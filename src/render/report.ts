import type { DrillNode, ToolBreakdownRow } from "../attribute.ts";
import type { OfficialUsage } from "../official.ts";
import type { RangedBreakdowns, Snapshot } from "../snapshot.ts";
import type { BreakdownRow } from "../types.ts";
import {
  bar,
  barParts,
  brailleChart,
  color,
  formatDuration,
  formatTokens,
  formatUSD,
  gaugeColor,
  type PolylineSeries,
  type Ticker,
} from "./bars.ts";

export type ByAxis = "tool" | "model" | "session" | "project" | "hour";

export interface ReportOptions {
  topN: number;
  axes: ByAxis[];
  /** 指定すると数値の変化を株価ティッカー風に色付け（watch 用）。 */
  ticker?: Ticker;
  /** ツール内訳の Workflow/Task をドリル展開して表示するか（watch では Ctrl-O でトグル）。 */
  expand?: boolean;
  /** By session を強制的に id 表示にする（watch では Ctrl-N でトグル）。既定は false=name 優先。 */
  showSessionIds?: boolean;
}

const c = color;

// 行頭ラベル（Used / Reset / Burn / Target / Run-out 等）を固定幅まで詰めて縦に揃える。
function padLabel(s: string, width = 8): string {
  return s.padEnd(width);
}

// 複合 stat 行の区切り。中黒（U+00B7）で論理境界を明示する。
const SEP = c.dim(" · ");

/** ticker があれば key の値変化で着色。無ければそのまま。 */
function tick(t: Ticker | undefined, key: string, value: number, text: string): string {
  return t ? t.fmt(key, value, text) : text;
}

function timeHHMM(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** セッション/プロジェクトキーを表示用に短縮。 */
function shortKey(key: string): string {
  if (key.includes("/")) return key.split("/").filter(Boolean).pop() ?? key;
  return key.length > 18 ? key.slice(0, 8) : key;
}

/** name 表示用に長すぎる title を切り詰める（端末幅を圧迫しない程度）。 */
function shortTitle(title: string): string {
  const max = 48;
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

/** モデル名の末尾 cutoff サフィックス（-20YYMMDD）を落として表示。 */
function shortModel(model: string): string {
  return model.replace(/-20\d{6}$/, "");
}

/** 5h ウィンドウのゲージと予測。ticker があれば数値変化を着色。 */
export function renderBlockStatus(s: Snapshot, t?: Ticker): string {
  const lines: string[] = [];
  lines.push(c.bold("● Claude Code 5h window"));

  const officialPct = s.official?.fiveHour?.utilization ?? null;

  if (!s.hasActivity && officialPct === null) {
    lines.push(c.dim("  No activity in the last 5h (0 used)"));
    return lines.join("\n");
  }

  // ── 状態系: ゲージ・使用・リセット ──
  const totalTok = s.totals.input + s.totals.output + s.totals.cacheCreation;
  const totalTokStr = tick(t, "used.tok", totalTok, formatTokens(totalTok));
  const limitFrag = s.effectiveLimit !== null ? ` / ${formatTokens(s.effectiveLimit)}` : "";
  const usedRhs = `${totalTokStr}${c.dim(`${limitFrag} tok`)}${SEP}${c.dim(formatUSD(s.cost))}`;

  if (s.pct !== null) {
    const g = gaugeColor(s.pct);
    const pctStr = tick(t, "pct", s.pct, g(`${(s.pct * 100).toFixed(1)}%`));
    lines.push(`  ${g(bar(s.pct, 28))}  ${pctStr}`);
  }
  lines.push(`  ${c.dim(padLabel("Used"))} ${usedRhs}`);
  if (s.resetTs !== null) {
    lines.push(
      `  ${c.dim(padLabel("Reset"))} ${c.dim(`${formatDuration(s.resetTs - s.now)} (${timeHHMM(s.resetTs)})`)}`,
    );
  }

  // ── ペース系: バーン・目標・枯渇予測 ──
  lines.push("");

  // 3 つの時間窓を 1 行に圧縮: 1m が "いまの瞬間" / 10m が安定したベース / 1h が長期。
  // ▲▼ ticker を 1m に当てて、最も反応の速い数字に直接出る形にする。
  const b1m = formatTokens(s.burn1m.rawPerMin);
  const b10 = formatTokens(s.burn10.rawPerMin);
  const bHr = formatTokens(s.burnHour.rawPerMin);
  lines.push(
    `  ${c.dim(padLabel("Burn"))} ${c.cyan(tick(t, "burn1m", s.burn1m.rawPerMin, b1m))} ${c.dim("tok/min")}${SEP}${c.dim(`10m ${b10}`)}${SEP}${c.dim(`1h ${bHr}`)}`,
  );

  if (s.budgetBurnPerMin !== null) {
    const budget = tick(t, "budgetBurn", s.budgetBurnPerMin, formatTokens(s.budgetBurnPerMin));
    lines.push(
      `  ${c.dim(padLabel("Target"))} ${budget} ${c.dim("tok/min")}${SEP}${c.dim("100% at reset")}`,
    );
  }

  if (s.projection?.exhaustionTs != null) {
    const eta = s.projection.exhaustionTs - s.now;
    const within = s.resetTs === null || s.projection.exhaustionTs <= s.resetTs;
    // 枯渇する場合のみ表示（枯渇しない = 正常なので非表示）
    if (within) {
      const msg =
        eta <= 0
          ? c.red(`depleted (${timeHHMM(s.projection.exhaustionTs)})`)
          : c.red(`in ${formatDuration(eta)} (${timeHHMM(s.projection.exhaustionTs)})`);
      lines.push(`  ${c.dim(padLabel("Run-out"))} ${msg}`);
    }
  }

  // 累積 % チャート（5h ウィンドウ全幅。limit が取れたときだけ表示）。
  // 旧 Trend スパークラインは廃止: 提供してた情報（"いま増えてるか"）は Burn 行の 1m + ▲▼ で代替、
  // 時間軸の "いつ高まったか" は Cumul の傾きで読める。
  if (s.hasActivity && s.cumul) {
    lines.push("");
    for (const line of renderCumulChart(s.cumul, s.now)) lines.push(line);
  }
  return lines.join("\n");
}

/**
 * 累積 % の折れ線チャートを Trend の直下に出す。
 * - 過去（windowStart〜now、実測）: 太線・通常色で前面レイヤ
 * - 予測（now〜windowEnd、burn10 線形外挿）: 細線・dim 色で背面レイヤ
 * - 横軸: windowStart〜windowEnd（5h 全幅）、縦軸: 0〜100%
 * - 描画: braille で本物のポリライン（thick=true で 3 ドット幅にして実線らしく見せる）
 */
function renderCumulChart(cumul: NonNullable<Snapshot["cumul"]>, now: number): string[] {
  if (cumul.past.length === 0) return [];
  const height = 6;
  // bodyWidth - 1 を「ウィンドウ時間数」で割り切れる値にすると、clock-hour 境界の col が
  // 丸めなしで等間隔になる。5h ウィンドウなら (bodyWidth-1) % 5 === 0 で OK → 51（時間あたり 10 列）。
  const bodyWidth = 51;
  const series: PolylineSeries[] = [
    // past: 通常色（先頭 series が overlap セルで装飾を勝ち取る = 前面）
    { points: cumul.past },
  ];
  if (cumul.prediction.length >= 2) {
    series.push({ points: cumul.prediction, decorate: c.dim });
  }
  const body = brailleChart(series, bodyWidth, height);

  // 1 時間ごとのグリッド: clock-aligned な hour 境界（windowStart より厳密に大きく、windowEnd 未満）。
  // 背景レイヤとして body の空白セルにのみ "┊" を差し込む（chart line を上書きしない）。
  const HOUR_MS = 3600_000;
  const range = cumul.end - cumul.start;
  const firstHour = Math.ceil(cumul.start / HOUR_MS) * HOUR_MS;
  const hourCols = new Set<number>();
  for (let ts = firstHour; ts < cumul.end; ts += HOUR_MS) {
    const xFrac = (ts - cumul.start) / range;
    if (xFrac <= 0 || xFrac >= 1) continue;
    const col = Math.round(xFrac * (bodyWidth - 1));
    // col=0 は y 軸 │ の真隣で `│┊` がダブル線に見えるので落とす。最右端も同様。
    if (col <= 0 || col >= bodyWidth - 1) continue;
    hourCols.add(col);
  }
  const griddedBody = body.map((line) => overlayHourGrid(line, hourCols));

  // 過去ラインの "tip"（= 現在時刻のポイント）を "白 ↔ グレー" で点滅させてライブカーソル化する。
  // ANSI SGR 5（blink）に頼ると VSCode 内蔵 terminal 等で無視されるので、now を 1 秒粒度で
  // 偶数秒/奇数秒に分けて装飾を切り替える方式（呼び出し側が 1Hz 以上で再描画する前提）。
  // tip は past 配列の最終点 (xNow, cumulNow)。brailleChart の toSubX/toSubY と同じ式で
  // セル座標を逆算し、その 1 セルの braille char をラップする（文字種は変えない）。
  const tipPoint = cumul.past[cumul.past.length - 1];
  if (tipPoint) {
    const subW = 2 * bodyWidth;
    const subH = 4 * height;
    const tx = Math.max(0, Math.min(1, tipPoint.x));
    const ty = Math.max(0, Math.min(1, tipPoint.y));
    const tipCharCol = Math.floor(Math.round(tx * (subW - 1)) / 2);
    const tipCharRow = Math.floor(Math.round((1 - ty) * (subH - 1)) / 4);
    if (tipCharRow >= 0 && tipCharRow < height) {
      const blinkOn = Math.floor(now / 1000) % 2 === 0;
      // on: 装飾なし（既定色 = 白）/ off: dim（グレー）
      const tipDecorate = blinkOn ? (s: string) => s : c.dim;
      // biome-ignore lint/style/noNonNullAssertion: tipCharRow は範囲チェック済み
      griddedBody[tipCharRow] = wrapCharAtCol(griddedBody[tipCharRow]!, tipCharCol, tipDecorate);
    }
  }

  // y 軸目盛: height=6 で 100/80/60/40/20/0 の 6 段。
  const ticks = ["100%", " 80%", " 60%", " 40%", " 20%", "  0%"];
  const label = padLabel("Cumul");
  const blank = " ".repeat(label.length);
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    const prefix = i === 0 ? c.dim(label) : c.dim(blank);
    // biome-ignore lint/style/noNonNullAssertion: griddedBody と ticks は同じ height で揃えている
    out.push(`  ${prefix} ${c.dim(ticks[i]!)} ${c.dim("│")}${griddedBody[i]!}`);
  }
  // 軸線: hour tick 位置で "─" を "┴" に置き換える。
  let axis = "└";
  for (let i = 0; i < bodyWidth; i++) axis += hourCols.has(i) ? "┴" : "─";
  out.push(`  ${c.dim(blank)} ${c.dim("    ")} ${c.dim(axis)}`);
  // x 軸ラベル: 両端の時刻のみ（途中の hour 値は ┴ で十分視覚化されている）。
  const startStr = timeHHMM(cumul.start);
  const endStr = timeHHMM(cumul.end);
  const padCount = Math.max(0, bodyWidth - startStr.length - endStr.length);
  out.push(
    `  ${c.dim(blank)} ${c.dim("    ")}  ${c.dim(startStr + " ".repeat(padCount) + endStr)}`,
  );
  return out;
}

/**
 * body 行の特定 visible col にある 1 文字（元の文字はそのまま）を `decorate` で包む。
 * ANSI escape は可視幅 0 として skip するので、装飾済みの行でも正しい列をヒットする。
 * tip cell の braille char を点滅させたいだけのときに使う（文字を別物に置き換えないので
 * グリフサイズが変わらず、線の太さ感が保たれる）。
 */
function wrapCharAtCol(line: string, col: number, decorate: (s: string) => string): string {
  let visibleCol = 0;
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i);
      if (end === -1) {
        out += line.slice(i);
        break;
      }
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (visibleCol === col) {
      // biome-ignore lint/style/noNonNullAssertion: ループ範囲は line 内
      out += decorate(line[i]!);
    } else {
      out += line[i];
    }
    visibleCol++;
    i++;
  }
  return out;
}

/**
 * brailleChart の body 行に対し、hour grid の列位置に "┊" を差し込む（dim）。
 * chart line の braille char や ANSI 装飾は壊さず、空白セルだけを置き換える。
 * ANSI sequences は可視幅 0 として skip して visibleCol を進めない。
 */
function overlayHourGrid(line: string, cols: Set<number>): string {
  if (cols.size === 0) return line;
  let visibleCol = 0;
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      // ANSI CSI sequence: ESC '[' ... 'm' まで丸ごとコピー
      const end = line.indexOf("m", i);
      if (end === -1) {
        out += line.slice(i);
        break;
      }
      out += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const ch = line[i];
    if (ch === " " && cols.has(visibleCol)) {
      out += c.dim("┊");
    } else {
      out += ch;
    }
    visibleCol++;
    i++;
  }
  return out;
}

/** `usage` コマンド: 公式の 5h / 7d / スコープ別リミットを表示。 */
export function renderUsage(o: OfficialUsage, now: number): string {
  const lines = [c.bold("● Usage") + c.dim(" /api/oauth/usage")];
  const win = (label: string, w: { utilization: number; resetsAt: number } | null) => {
    if (!w) {
      lines.push(`  ${c.dim(padLabel(label, 4))} ${c.dim("(none)")}`);
      return;
    }
    const g = gaugeColor(w.utilization / 100);
    lines.push(
      `  ${c.dim(padLabel(label, 4))} ${g(bar(w.utilization / 100, 24))}  ` +
        `${g(`${w.utilization.toFixed(1)}%`)}${SEP}` +
        c.dim(`reset ${formatDuration(w.resetsAt - now)} (${timeHHMM(w.resetsAt)})`),
    );
  };
  win("5h", o.fiveHour);
  win("7d", o.sevenDay);
  const scoped = o.limits.filter((l) => l.scopeLabel);
  for (const l of scoped) {
    lines.push(
      c.dim(
        `  ${padLabel(`7d:${l.scopeLabel}`, 4)}  ${(l.percent).toFixed(0)}%  reset ${l.resetsAt ? timeHHMM(l.resetsAt) : "-"}`,
      ),
    );
  }
  lines.push(c.dim(`  ${padLabel("", 4)} fetched ${new Date(o.fetchedAt).toLocaleTimeString()}`));
  return lines.join("\n");
}

/**
 * 軽量バー文字列を組む。塗り部分は既定色（top 行を強調するため非 dim）、
 * 空き部分は dim の `·` で「全長 = 100%」のスケール感を保つ。
 */
function lightBar(share: number, width: number): string {
  const { filled, empty } = barParts(share, width);
  return filled + c.dim(empty);
}

/** 1 つの内訳テーブル（BreakdownRow）。keyNs は ticker 用の名前空間。 */
function renderBreakdown(
  title: string,
  rows: BreakdownRow[],
  topN: number,
  keyNs: string,
  t?: Ticker,
  resolveLabel?: (key: string) => string,
): string {
  const lines = [c.bold(title)];
  if (rows.length === 0) {
    lines.push(c.dim("  (none)"));
    return lines.join("\n");
  }
  for (const r of rows.slice(0, topN)) {
    const tok = r.usage.input + r.usage.output + r.usage.cacheCreation;
    const tokStr = tick(t, `${keyNs}:${r.key}`, tok, formatTokens(tok).padStart(7));
    const display = resolveLabel
      ? resolveLabel(r.key)
      : keyNs === "model"
        ? shortModel(r.key)
        : shortKey(r.key);
    lines.push(
      `  ${lightBar(r.share, 12)} ${(r.share * 100).toFixed(0).padStart(3)}%  ` +
        `${c.dim(formatUSD(r.cost).padStart(8))}  ${tokStr}  ` +
        `${c.dim(`×${String(r.count).padStart(4)}`)}  ${display}`,
    );
  }
  return lines.join("\n");
}

/** ドリル木の 1 ノードを再帰でインデント表示。固定段差で縦に整列させる。 */
function walkDrill(
  lines: string[],
  n: DrillNode,
  depth: number,
  keyPath: string,
  topN: number,
  baseIndent: string,
  t?: Ticker,
): void {
  // depth=1（Workflow/Agent 配下の第一階層）から 2 スペース刻み。親ツール行に対しては
  // baseIndent（4 スペース）を加えるだけで、横方向の伸びを抑える。
  const indent = baseIndent + "  ".repeat(depth - 1);
  const tokStr = tick(t, `agents:${keyPath}`, n.tokens, formatTokens(n.tokens).padStart(7));
  const marker = depth === 1 ? c.dim("▸ ") : c.dim("· ");
  lines.push(
    `${indent}${marker}${tokStr}  ${c.dim(`×${String(n.turns).padStart(3)}`)}  ${n.label}`,
  );
  for (const ch of n.children.slice(0, topN)) {
    walkDrill(lines, ch, depth + 1, `${keyPath}/${ch.key}`, topN, baseIndent, t);
  }
  if (n.children.length > topN) {
    lines.push(`${baseIndent}${"  ".repeat(depth)}${c.dim(`… ${n.children.length - topN} more`)}`);
  }
  // agent 葉ノード: その agent が内部で使ったツール推定をぶら下げる（chars/4、`~` マーク）。
  // agent 自身の実消費 (n.tokens) とは別量なので加算関係にはない。
  if (n.tools && n.tools.length > 0) {
    const toolIndent = `${indent}  `;
    for (const tool of n.tools.slice(0, topN)) {
      const toolTok = tick(
        t,
        `agent-tool:${keyPath}/${tool.tool}`,
        tool.tokens,
        formatTokens(tool.tokens).padStart(7),
      );
      lines.push(
        `${toolIndent}${c.dim("~ ")}${toolTok}  ${c.dim(`×${String(tool.calls).padStart(3)}`)}  ${c.dim(tool.tool)}`,
      );
    }
    if (n.tools.length > topN) {
      lines.push(`${toolIndent}${c.dim(`… ${n.tools.length - topN} more`)}`);
    }
  }
}

/**
 * ツール内訳テーブル（推定/実測の別を表示）。
 * expand=true かつ drill に該当ノードがあれば、Workflow/Task 行の直下にドリルダウンを展開する。
 * 展開行は親行の「ラベル開始列」に揃えてインデントする。
 */
function renderTools(
  rows: ToolBreakdownRow[],
  topN: number,
  drill: DrillNode[],
  expand: boolean,
  t?: Ticker,
): string {
  const hasDrill = drill.length > 0;
  const hint = hasDrill ? c.dim(expand ? "  ^O collapse" : "  ^O expand") : "";
  const lines = [
    c.bold("By tool") + c.dim("  ~est / =measured") + hint,
  ];
  if (rows.length === 0) {
    lines.push(c.dim("  (none)"));
    return lines.join("\n");
  }
  const drillByTool = new Map(drill.map((n) => [n.key, n]));
  // drilldown のベースインデント: 親ツール行の左マージン（2）から 4 スペース追加。
  // 親の「ラベル開始列」に揃える従来案より圧倒的にコンパクトで、深い木でも横スクロールを誘発しない。
  const drillIndent = "      ";
  for (const r of rows.slice(0, topN)) {
    const mark = r.estimated ? c.dim("~") : c.green("=");
    const tokStr = tick(t, `tool:${r.tool}`, r.tokens, formatTokens(r.tokens).padStart(7));
    lines.push(
      `  ${lightBar(r.share, 12)} ${(r.share * 100).toFixed(0).padStart(3)}%  ` +
        `${mark}${tokStr}  ${c.dim(`×${String(r.calls).padStart(4)}`)}  ${r.tool}`,
    );
    if (!expand) continue;
    const node = drillByTool.get(r.tool);
    if (!node) continue;
    for (const ch of node.children.slice(0, topN)) {
      walkDrill(lines, ch, 1, `${r.tool}/${ch.key}`, topN, drillIndent, t);
    }
    if (node.children.length > topN) {
      lines.push(`${drillIndent}${c.dim(`… ${node.children.length - topN} more`)}`);
    }
  }
  return lines.join("\n");
}

/**
 * 単発レポート全体。
 * - watch / report block: snapshot.breakdowns（5h ウィンドウ）をそのまま表示
 * - report --since 24h/7d/30d 等: 呼び出し側がその範囲の Breakdowns を計算して渡す
 */
export function renderReport(
  s: Snapshot,
  breakdowns: RangedBreakdowns,
  rangeLabel: string,
  opts: ReportOptions,
): string {
  const t = opts.ticker;
  // 各サブセクションは独立した文字列としてプッシュし、空行で区切って join する。
  const sections: string[] = [renderBlockStatus(s, t)];

  sections.push(c.bold("● Breakdown") + c.dim(`  ${rangeLabel}`));

  for (const axis of opts.axes) {
    switch (axis) {
      case "tool":
        sections.push(
          renderTools(breakdowns.tools, opts.topN, breakdowns.drill, opts.expand ?? false, t),
        );
        break;
      case "model":
        sections.push(renderBreakdown("By model", breakdowns.byModel, opts.topN, "model", t));
        break;
      case "session": {
        const titles = s.sessionTitles;
        const showIds = opts.showSessionIds ?? false;
        const resolve = (key: string): string => {
          if (showIds) return shortKey(key);
          const name = titles.get(key);
          return name ? shortTitle(name) : shortKey(key);
        };
        sections.push(
          renderBreakdown("By session", breakdowns.bySession, opts.topN, "session", t, resolve),
        );
        break;
      }
      case "project":
        sections.push(renderBreakdown("By project", breakdowns.byProject, opts.topN, "project", t));
        break;
      case "hour":
        sections.push(renderBreakdown("By hour", breakdowns.byHour, opts.topN, "hour", t));
        break;
    }
  }
  return sections.join("\n\n");
}
