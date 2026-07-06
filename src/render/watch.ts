import type { Config } from "../config.ts";
import { createOfficialPoller } from "../official-poll.ts";
import type { ScanResult } from "../scan.ts";
import { Scanner } from "../scan.ts";
// merge / pruneState は scan-state に集約（daemon と共有）。テスト互換のため pruneState を再 export する。
import { merge, pruneState } from "../scan-state.ts";
import { buildSnapshot } from "../snapshot.ts";
import { color, Ticker } from "./bars.ts";
import type { ReportOptions } from "./report.ts";
import { renderReport } from "./report.ts";

export { pruneState };

// alternate screen 上に独自のビューポートを描く（vim/less と同じ仕組み）。
// 内容は全行レンダリングし、画面に収まらない分は「アプリ内仮想スクロール」で見せる。
// alt screen なので通常画面の履歴を汚さず、再描画の積み重なりも起きない。
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const REDRAW = "\x1b[H\x1b[J";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

export interface WatchOptions extends ReportOptions {
  intervalMs: number;
}

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
        if (!refreshing) {
          refreshing = true;
          // backoff をリセットしてから fire-and-forget。完了で rebuild。
          poller.refreshManually().finally(() => {
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
  // poller が前回値の保持・401 特例・指数バックオフを内蔵している（daemon と共通）。
  const poller = createOfficialPoller();
  // 手動 refresh 中フラグ（多重押下で fetchOfficialUsage を並列起動しない）。
  let refreshing = false;
  await poller.refresh();

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
    const snap = buildSnapshot(state, config, now, poller.state.official);
    const body = renderReport(snap, snap.breakdowns, "current 5h window", {
      ...opts,
      ticker,
      expand,
      showSessionIds,
    });
    let apiNote = "";
    if (poller.state.error) {
      if (poller.state.official) {
        const ageMin = Math.floor((now - poller.state.official.fetchedAt) / 60_000);
        apiNote = color.dim(
          `\nAPI update failed (${poller.state.error}) · last value ${ageMin}m ago`,
        );
      } else {
        apiNote = color.dim(`\nAPI unavailable: ${poller.state.error}`);
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
        ? ` · ${scroll + 1}-${Math.min(scroll + viewport, lines.length)}/${lines.length} ↑↓`
        : "";
    const refreshHint = " · r refresh";
    const updated = new Date(lastUpdate).toLocaleTimeString();
    const tick = `${opts.intervalMs / 1000}s`;
    const sessionMode = showSessionIds ? "name" : "id";
    const footer = color.dim(
      `${updated} · ${tick} tick · ^O expand · ^N ${sessionMode}${refreshHint}${pos} · q quit`,
    );
    process.stdout.write(`${REDRAW + visible.join("\n")}\n${footer}`);
  };

  rebuild();
  // 再描画は固定 1Hz（Cumul tip の 1 秒点滅と Burn ▲▼ ticker のため）。
  // データ poll は別 cadence で、設定 opts.intervalMs を経過したときだけ走らせる。
  // これで「データは 5s ごとに更新したいが、視覚アニメーションは 1Hz で動かしたい」を両立する。
  const REDRAW_MS = 1000;
  let nextPollAt = Date.now() + opts.intervalMs;
  while (!stopped) {
    await Bun.sleep(REDRAW_MS);
    if (Date.now() >= nextPollAt) {
      merge(state, await scanner.poll());
      if (poller.shouldRefresh(Date.now())) {
        await poller.refresh();
      }
      nextPollAt = Date.now() + opts.intervalMs;
    }
    rebuild();
  }
}
