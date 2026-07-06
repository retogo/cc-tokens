import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import type { Config } from "./config.ts";
import { createOfficialPoller, OFFICIAL_REFRESH_MS } from "./official-poll.ts";
import { Scanner } from "./scan.ts";
import type { ScanResult } from "./scan.ts";
import { merge, pruneState } from "./scan-state.ts";
import { buildSnapshot } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";

/** メニューバーアプリと共有する JSON コントラクトのバージョン。破壊的変更は bump する。
 * v2: local-only モード撤廃に伴い api_status.enabled を削除（official は常時取得）。 */
export const SCHEMA_VERSION = 2 as const;

/** emit ファイルのパーミッション。snapshot には session タイトル等が含まれるので owner-only。 */
const EMIT_FILE_MODE = 0o600;

/** emit 連続失敗の上限。これを超えると process.exit(1) して launchd / systemd に再起動を委ねる。 */
const EMIT_FAILURE_EXIT_THRESHOLD = 10;

/**
 * Snapshot を JSON-safe な representation に正規化した型。
 * - Map（sessionTitles）→ Record に変換
 * - その他のフィールドは Snapshot と同型（Date を含まないので JSON.stringify でそのまま流れる）
 *
 * Omit で絞り込むことで、Snapshot に新フィールドが追加されると TS コンパイルが落ちる
 * （`{ now, windowMs, ... } satisfies SerializedSnapshot` で列挙漏れを検出）。これにより
 * Map/Set/Date が暗黙に payload に混入して SCHEMA_VERSION の bump 漏れを起こす事故を防ぐ。
 */
export type SerializedSnapshot = Omit<Snapshot, "sessionTitles"> & {
  /** sessionId → 表示名（custom-title 優先、無ければ ai-title）。Map から畳まれた plain object。 */
  sessionTitles: Record<string, string>;
};

/**
 * 公式 API の取得状態。consumer (menu-bar app 等) が「% / reset が消えた理由」を
 * 表示するために使う（429 / 401 / network エラー等）。official は常時取得する。
 */
export interface ApiStatus {
  /** 直近 fetch が成功し、かつ value を保持しているか。 */
  ok: boolean;
  /** 最終エラーメッセージ。成功時 / 未取得時は null。 */
  error: string | null;
  /** 直近成功 fetch の時刻（epoch ms）。一度も成功していなければ null。 */
  last_fetch_at: number | null;
  /** 次回 refresh 予定時刻（epoch ms）。起動直後は null。 */
  next_retry_at: number | null;
}

/** Swift 側（および将来の web 側）が読み取る固定構造。 */
export interface EmitPayload {
  schema_version: typeof SCHEMA_VERSION;
  /** payload を作った時刻（ISO 8601）。snapshot.now（epoch ms）とは別系統。 */
  generated_at: string;
  snapshot: SerializedSnapshot;
  /** 公式 API の取得状態（v1.1 で追加。古い consumer は無視するだけで壊れない）。 */
  api_status: ApiStatus;
}

/** runDaemon が返す制御ハンドル。SIGINT 経路と外部呼び出し（テスト）の両方で停止する。 */
export interface DaemonController {
  /** poll ループを止め、最後の cleanup（.tmp の best-effort unlink）まで待つ。 */
  stop: () => Promise<void>;
  /** ループが自然 / stop() で終了するまでの Promise。CLI 層が await して process を保持する用途。 */
  done: Promise<void>;
}

export interface RunDaemonOptions {
  /** snapshot JSON を書き出す絶対パス。`<emitPath>.tmp` も同じディレクトリに作られる。 */
  emitPath: string;
  /** ループ間隔（ミリ秒）。CLI 層で最小 1 秒に強制する想定（テストは小さい値を渡す）。 */
  intervalMs: number;
  /**
   * 停止シグナル（任意）。指定された場合、abort で graceful 終了する。
   * CLI 層で SIGINT/SIGTERM ハンドラを貼る用途（library として埋め込む際にも process 操作を分離する）。
   */
  signal?: AbortSignal;
}

/**
 * Snapshot 内の Map（sessionTitles）を plain object に畳んで JSON-safe にする。
 * 全フィールドを field-by-field でコピーして列挙漏れを TS で検出する（rest spread は使わない）。
 * Snapshot に新フィールドが入ると satisfies で TS が落ちるので、SCHEMA_VERSION の bump 判断を強制できる。
 */
export function serializeSnapshot(snap: Snapshot): SerializedSnapshot {
  const sessionTitles: Record<string, string> = {};
  for (const [k, v] of snap.sessionTitles) sessionTitles[k] = v;
  // field-by-field 列挙（Snapshot 拡張時のコントラクト破壊検知ポイント）。
  const out = {
    now: snap.now,
    windowMs: snap.windowMs,
    windowStart: snap.windowStart,
    hasActivity: snap.hasActivity,
    turns: snap.turns,
    usedWeighted: snap.usedWeighted,
    pct: snap.pct,
    totals: snap.totals,
    cost: snap.cost,
    burnWindow: snap.burnWindow,
    burn1m: snap.burn1m,
    burn10: snap.burn10,
    burnHour: snap.burnHour,
    budgetBurnPerMin: snap.budgetBurnPerMin,
    projection: snap.projection,
    breakdowns: snap.breakdowns,
    sessionTitles,
    cumul: snap.cumul,
    official: snap.official,
    resetTs: snap.resetTs,
    effectiveLimit: snap.effectiveLimit,
  } satisfies SerializedSnapshot;
  return out;
}

/** EmitPayload を組み立てる。generated_at は `new Date(generatedAtMs).toISOString()`。 */
export function buildEmitPayload(
  snap: Snapshot,
  generatedAtMs: number,
  apiStatus: ApiStatus,
): EmitPayload {
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date(generatedAtMs).toISOString(),
    snapshot: serializeSnapshot(snap),
    api_status: apiStatus,
  };
}

/**
 * OfficialPoller の state から ApiStatus を組み立てる。
 * - error が出ていても official 値が残っていれば「stale だが使える」状態。
 *   ok の判定は error === null && official !== null とする。
 */
export function buildApiStatus(
  poller: { state: { official: unknown; error: string | null; lastFetchAt: number | null; nextRetryAt: number | null } },
): ApiStatus {
  return {
    ok: poller.state.error === null && poller.state.official !== null,
    error: poller.state.error,
    last_fetch_at: poller.state.lastFetchAt,
    next_retry_at: poller.state.nextRetryAt,
  };
}

/**
 * payload を atomic に書き出す。`<path>.tmp` に書き、同一ディレクトリ内で rename する。
 * rename は POSIX で atomic なので、読み手は途中状態を観測しない。
 *
 * mode は 0o600 固定。payload には session タイトル（ユーザプロンプト断片）や
 * per-session/project の token 使用量が含まれるため、共有 mac 環境で他ユーザから読まれないようにする。
 * rename 後にも chmod する（既存ファイルが world-readable だった場合の救済）。
 */
export async function emitOnce(payload: EmitPayload, path: string): Promise<void> {
  const tmp = `${path}.tmp`;
  // node:fs/promises の writeFile は mode を渡せる（Bun.write はオプション非対応）。
  await writeFile(tmp, JSON.stringify(payload), { mode: EMIT_FILE_MODE });
  await rename(tmp, path);
  // rename は src のパーミッションを引き継ぐので原則 0600 のままだが、
  // 念のため明示 chmod（既存 dst が 0644 だったとしても、rename 後は src のものになるが Linux 環境差を吸収）。
  try {
    await chmod(path, EMIT_FILE_MODE);
  } catch {
    // chmod 失敗（読み取り専用 FS など）は致命ではないので無視
  }
}

/**
 * snapshot を JSON ファイルに atomic に書き出し続ける daemon。
 * - 初回に直近 2× ウィンドウのみ seed する（巨大履歴の全読みを避ける）。
 * - intervalMs ごとに Scanner.poll → buildSnapshot → emitOnce を回す。
 * - createOfficialPoller を経由して % / reset をバックグラウンド再取得（失敗時バックオフ／401 特例）。
 * - opts.signal で graceful 終了し、`.tmp` が残らないよう best-effort unlink。
 *   signal は CLI 層が SIGINT/SIGTERM を AbortController に変換して渡す想定。
 */
export function runDaemon(
  root: string,
  config: Config,
  opts: RunDaemonOptions,
): DaemonController {
  let stopped = false;
  // signal 経路と controller.stop() 経路を一本化するためのリゾルバ。
  let resolveStop: () => void = () => {};
  const stopSignal = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });

  const setStopped = () => {
    if (stopped) return;
    stopped = true;
    resolveStop();
  };

  // 外部 AbortSignal が渡された場合は abort で停止する。一度だけ登録。
  if (opts.signal) {
    if (opts.signal.aborted) setStopped();
    else opts.signal.addEventListener("abort", setStopped, { once: true });
  }

  // ループ本体は async IIFE。controller.stop() / signal はこの loopDone を await する。
  const loopDone: Promise<void> = (async () => {
    const scanner = new Scanner(root);
    const state: ScanResult = {
      records: [],
      toolEvents: [],
      subagentToolEvents: [],
      sessionTitles: new Map(),
    };

    const poller = createOfficialPoller({
      onError: (msg) => {
        process.stderr.write(`API unavailable (% / reset time hidden): ${msg}\n`);
      },
    });

    const seedSince = Date.now() - 2 * config.windowHours * 3600_000;
    merge(state, await scanner.seed(seedSince));
    // seed の最中に stop が来た場合、loop 本体に入る前に return（spurious emit を出さない）。
    if (stopped) {
      await cleanupTmp(opts.emitPath);
      return;
    }

    await poller.refresh();
    if (stopped) {
      await cleanupTmp(opts.emitPath);
      return;
    }

    // emit 連続失敗カウンタ。N 連続で process.exit(1) して supervisor の再起動に委ねる。
    let consecutiveEmitFailures = 0;
    let lastEmitErrorMsg: string | null = null;

    while (!stopped) {
      // 2× ウィンドウより古い要素を捨ててから snapshot を作る。
      pruneState(state, Date.now() - 2 * config.windowHours * 3600_000);
      const now = Date.now();
      const snap = buildSnapshot(state, config, now, poller.state.official);
      const apiStatus = buildApiStatus(poller);
      try {
        await emitOnce(buildEmitPayload(snap, now, apiStatus), opts.emitPath);
        consecutiveEmitFailures = 0;
        lastEmitErrorMsg = null;
      } catch (e) {
        // 書き出し失敗は致命ではない（ディレクトリ消滅・権限変更等）。
        // ただし同じエラーが連続すると stderr スパムになるので、
        // (a) 同一メッセージは初回だけ書き、(b) N 連続で exit して supervisor に再起動を任せる。
        const msg = e instanceof Error ? e.message : String(e);
        consecutiveEmitFailures += 1;
        if (msg !== lastEmitErrorMsg) {
          process.stderr.write(`emit failed: ${msg}\n`);
          lastEmitErrorMsg = msg;
        }
        if (consecutiveEmitFailures >= EMIT_FAILURE_EXIT_THRESHOLD) {
          process.stderr.write(
            `emit failed ${consecutiveEmitFailures} times in a row; exiting for supervisor restart\n`,
          );
          await cleanupTmp(opts.emitPath);
          process.exit(1);
        }
      }

      if (stopped) break;
      // interval 経過 or stop シグナルのどちらかで起きる。
      await Promise.race([Bun.sleep(opts.intervalMs), stopSignal]);
      if (stopped) break;

      merge(state, await scanner.poll());
      if (stopped) break;
      if (poller.shouldRefresh(Date.now())) {
        await poller.refresh();
      }
    }

    await cleanupTmp(opts.emitPath);
  })();

  return {
    stop: async () => {
      setStopped();
      await loopDone;
    },
    done: loopDone,
  };
}

// 共有定数を re-export（既存 import 互換、テストや watch 側からの参照用）。
export { OFFICIAL_REFRESH_MS };

/** 終了パスの best-effort cleanup。失敗（存在しない・権限）は握りつぶす。 */
async function cleanupTmp(emitPath: string): Promise<void> {
  try {
    await unlink(`${emitPath}.tmp`);
  } catch {
    // 存在しない / 権限なしは無視
  }
}
