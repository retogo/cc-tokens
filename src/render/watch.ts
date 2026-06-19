import type { Config } from "../config.ts";
import type { OfficialUsage } from "../official.ts";
import { fetchOfficialUsage, OfficialFetchError } from "../official.ts";
import type { ScanResult } from "../scan.ts";
import { Scanner } from "../scan.ts";
import { buildSnapshot } from "../snapshot.ts";
import { color, Ticker } from "./bars.ts";
import type { ReportOptions } from "./report.ts";
import { renderReport } from "./report.ts";

// alternate screen 上に独自のビューポートを描く（vim/less と同じ仕組み）。
// 内容は全行レンダリングし、画面に収まらない分は「アプリ内仮想スクロール」で見せる。
// alt screen なので通常画面の履歴を汚さず、再描画の積み重なりも起きない。
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const REDRAW = "\x1b[H\x1b[J";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

function merge(into: ScanResult, more: ScanResult): void {
  for (const r of more.records) into.records.push(r);
  for (const e of more.toolEvents) into.toolEvents.push(e);
  for (const e of more.subagentToolEvents) into.subagentToolEvents.push(e);
  // sessionTitles は Scanner 内部で累積されており、`more` が常に最新スナップショット。空でなければ採用する。
  if (more.sessionTitles.size > 0) into.sessionTitles = more.sessionTitles;
}

/**
 * 長時間 watch で state 配列が単調増加するのを抑える。
 * 表示は 5h ウィンドウのみなので、2× ウィンドウより古い要素は捨ててもどの算出にも影響しない。
 * scan.poll() は複数ファイルから append するため ts 単調増加は保証されず、
 * 頭だけ見て早期 return すると後続に潜む古い要素が永続滞留する。空配列のみスキップする。
 */
export function pruneState(state: ScanResult, cutoffMs: number): void {
  if (state.records.length > 0) {
    state.records = state.records.filter((r) => r.ts >= cutoffMs);
  }
  if (state.toolEvents.length > 0) {
    state.toolEvents = state.toolEvents.filter((e) => e.ts >= cutoffMs);
  }
  if (state.subagentToolEvents.length > 0) {
    state.subagentToolEvents = state.subagentToolEvents.filter((e) => e.ts >= cutoffMs);
  }
}

export interface WatchOptions extends ReportOptions {
  intervalMs: number;
  /** 公式 usage を取得して % / reset を表示・自動キャリブレーションするか。 */
  official: boolean;
}

/** API usage の通常再取得間隔（ミリ秒）。% は緩やかに動くので頻繁に叩かない。 */
const OFFICIAL_REFRESH_MS = 180_000;
/** 失敗時バックオフの上限（ミリ秒）。 */
const OFFICIAL_BACKOFF_MAX_MS = 15 * 60_000;

/**
 * ライブ監視ループ。seed 後、interval 毎に追記分を tail してスナップショットを再描画する。
 * SIGINT でカーソルを復帰して終了。now は実時間で更新する。
 */
export async function watch(root: string, config: Config, opts: WatchOptions): Promise<void> {
  const scanner = new Scanner(root);
  const state: ScanResult = {
    records: [],
    toolEvents: [],
    subagentToolEvents: [],
    sessionTitles: new Map(),
  };
  // 起動時は直近 2 ウィンドウ分のみシード（巨大履歴の全読みを避ける）。
  const seedSince = Date.now() - 2 * config.windowHours * 3600_000;
  merge(state, await scanner.seed(seedSince));

  let stopped = false;
  const isTTY = process.stdin.isTTY === true;
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.stdout.write(SHOW + ALT_OFF);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // ツール内訳の Workflow/Task をドリル展開するか。Ctrl-O でトグルし即時再描画する。
  let expand = opts.expand ?? false;
  // By session を id 表示に強制するか。Ctrl-N でトグル（既定は name 優先＝false）。
  let showSessionIds = opts.showSessionIds ?? false;
  // 仮想スクロールのオフセット（先頭からの行数）。draw() 側で内容行数にクランプする。
  let scroll = 0;
  // 直近の draw() で算出したビューポート高さ（PageUp/Down のページ送り量に使う）。
  let viewport = 20;

  // raw mode 入力。矢印・PageUp/Down・j/k/g/G でビューポートをスクロールし、
  // Ctrl-O で展開トグル、Ctrl-C / q で終了。raw mode では SIGINT が来ないので手動検出する。
  if (isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data: Buffer) => {
      const s = data.toString("utf8");
      if (s === "\x03" || s === "q") return cleanup();
      if (s === "\x0f") {
        // Ctrl-O: ドリル展開トグル。行数が変わるので先頭へ戻して再計算する。
        expand = !expand;
        scroll = 0;
        rebuild();
        return;
      }
      if (s === "\x0e") {
        // Ctrl-N: By session の name/id 表示トグル。行数は変わらないので scroll は維持。
        showSessionIds = !showSessionIds;
        rebuild();
        return;
      }
      if (s === "r") {
        // r: API usage を即時再取得（401 などの一時エラー復旧後にユーザが明示的に促せる）。
        if (opts.official && !refreshing) {
          refreshing = true;
          // backoff をリセットしてから fire-and-forget。完了で rebuild。
          backoffMs = OFFICIAL_REFRESH_MS;
          refreshOfficial().finally(() => {
            refreshing = false;
            rebuild();
          });
        }
        return;
      }
      // 以下はビューポート移動のみ。データは再計算せず paint() で切り出すだけ（着色が瞬く・値が動くのを防ぐ）。
      if (s === "\x1b[A" || s === "\x1bOA" || s === "k") {
        scroll -= 1; // ↑
      } else if (s === "\x1b[B" || s === "\x1bOB" || s === "j") {
        scroll += 1; // ↓
      } else if (s === "\x1b[5~" || s === "\x02") {
        scroll -= viewport; // PageUp / Ctrl-B
      } else if (s === "\x1b[6~" || s === "\x06" || s === " ") {
        scroll += viewport; // PageDown / Ctrl-F / Space
      } else if (s === "g" || s === "\x1b[H" || s === "\x1b[1~") {
        scroll = 0; // 先頭 / Home
      } else if (s === "G" || s === "\x1b[F" || s === "\x1b[4~") {
        scroll = Number.MAX_SAFE_INTEGER; // 末尾 / End（paint でクランプ）
      } else {
        return; // 未対応キーは無視（再描画しない）
      }
      if (scroll < 0) scroll = 0;
      paint();
    });
  }

  process.stdout.write(ALT_ON + HIDE);

  // API usage は別系統で定期取得（描画ループはブロックしない）。
  // 一度取れた値は保持し、更新失敗(429等)では消さずに前回値＋注記を出す。
  let official: OfficialUsage | null = null;
  let officialError: string | null = null;
  let nextOfficialAt = 0;
  let backoffMs = OFFICIAL_REFRESH_MS;
  // 手動 refresh 中フラグ（多重押下で fetchOfficialUsage を並列起動しない）。
  let refreshing = false;
  const refreshOfficial = async () => {
    if (!opts.official) return;
    try {
      official = await fetchOfficialUsage(Date.now());
      officialError = null;
      backoffMs = OFFICIAL_REFRESH_MS;
      nextOfficialAt = Date.now() + OFFICIAL_REFRESH_MS;
    } catch (e) {
      // official（前回値）は残す。理由を表示し、次回までバックオフ。
      officialError = e instanceof Error ? e.message : String(e);
      // 401（トークン期限切れ）は復旧がユーザ操作（claude 再起動）に依存するので backoff を伸ばさず、
      // 短間隔で再試行することで再認証直後に古い表示を引きずらないようにする。
      const is401 = e instanceof OfficialFetchError && e.status === 401;
      const retry = e instanceof OfficialFetchError && e.retryAfterMs ? e.retryAfterMs : backoffMs;
      if (!is401) {
        backoffMs = Math.min(backoffMs * 2, OFFICIAL_BACKOFF_MAX_MS);
      }
      nextOfficialAt =
        Date.now() + (is401 ? OFFICIAL_REFRESH_MS : Math.max(retry, OFFICIAL_REFRESH_MS));
    }
  };
  await refreshOfficial();

  // フレーム横断で数値の前回値を保持し、変化を株価ティッカー風に着色する。
  const ticker = new Ticker();

  // 直近の rebuild() でレンダリングした全行と更新時刻。paint() はこれを切り出すだけ。
  let lines: string[] = [];
  let lastUpdate = Date.now();

  /** スナップショットを再計算して全行を作り直す（データ更新・展開トグル時）。ticker 着色もここで進む。 */
  const rebuild = () => {
    const now = Date.now();
    lastUpdate = now;
    // 2× ウィンドウより古い要素を捨て、長期稼働での state 配列の単調増加を抑える。
    pruneState(state, now - 2 * config.windowHours * 3600_000);
    const snap = buildSnapshot(state, config, now, official);
    const body = renderReport(snap, snap.breakdowns, "current 5h window", {
      ...opts,
      ticker,
      expand,
      showSessionIds,
    });
    let apiNote = "";
    if (opts.official && officialError) {
      if (official) {
        const ageMin = Math.floor((now - official.fetchedAt) / 60_000);
        apiNote = color.dim(`\nAPI update failed (${officialError}) · last value ${ageMin}m ago`);
      } else {
        apiNote = color.dim(`\nAPI unavailable: ${officialError}`);
      }
    }
    lines = (body + apiNote).split("\n");
    paint();
  };

  /** 保持済みの行をビューポート分だけ切り出して描画する（スクロール時はこれだけ）。 */
  const paint = () => {
    const rows = process.stdout.rows ?? 40;
    viewport = Math.max(1, rows - 1); // 最下行はフッター固定
    const maxScroll = Math.max(0, lines.length - viewport);
    if (scroll > maxScroll) scroll = maxScroll;

    const visible = lines.slice(scroll, scroll + viewport);
    // フッターを最下行に固定するため、足りない分は空行で埋める。
    while (visible.length < viewport) visible.push("");

    const pos =
      lines.length > viewport
        ? `  [${scroll + 1}-${Math.min(scroll + viewport, lines.length)}/${lines.length} ↑↓]`
        : "";
    const refreshHint = opts.official ? "  /  r: refresh API" : "";
    const footer = color.dim(
      `Updated ${new Date(lastUpdate).toLocaleTimeString()}  /  every ${opts.intervalMs / 1000}s  /  Ctrl-O: expand  /  Ctrl-N: ${showSessionIds ? "name" : "id"}${refreshHint}${pos}  /  q: quit`,
    );
    process.stdout.write(`${REDRAW + visible.join("\n")}\n${footer}`);
  };

  rebuild();
  while (!stopped) {
    await Bun.sleep(opts.intervalMs);
    merge(state, await scanner.poll());
    if (opts.official && Date.now() >= nextOfficialAt) {
      await refreshOfficial();
    }
    rebuild();
  }
}
