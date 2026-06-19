import type { BreakdownRow } from "../types.ts";
import type { DrillNode, ToolBreakdownRow } from "../attribute.ts";
import type { RangedBreakdowns, Snapshot } from "../snapshot.ts";
import type { OfficialUsage } from "../official.ts";
import {
  bar,
  color,
  formatDuration,
  formatTokens,
  formatUSD,
  gaugeColor,
  sparkline,
  Ticker,
} from "./bars.ts";

export type ByAxis =
  | "tool"
  | "model"
  | "session"
  | "project"
  | "hour";

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
  return title.length > max ? title.slice(0, max - 1) + "…" : title;
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
  const usedRhs = `${totalTokStr}${c.dim(`${limitFrag} tok`)}   ${c.dim(formatUSD(s.cost))}`;

  if (s.pct !== null) {
    const g = gaugeColor(s.pct);
    const pctStr = tick(t, "pct", s.pct, g(`${(s.pct * 100).toFixed(1)}%`));
    lines.push(`  ${g(bar(s.pct, 28))} ${pctStr}`);
  }
  lines.push(`  ${c.dim(padLabel("Used"))} ${usedRhs}`);
  if (s.resetTs !== null) {
    lines.push(
      `  ${c.dim(padLabel("Reset"))} ${c.dim(`${formatDuration(s.resetTs - s.now)} (${timeHHMM(s.resetTs)})`)}`,
    );
  }

  // ── ペース系: バーン・目標・枯渇予測 ──
  const hasPace = true; // バーンは常に出す
  if (hasPace) lines.push("");

  const b10 = formatTokens(s.burn10.rawPerMin);
  const bHr = formatTokens(s.burnHour.rawPerMin);
  lines.push(
    `  ${c.dim(padLabel("Burn"))} ${c.cyan(tick(t, "burn10", s.burn10.rawPerMin, b10))} ${c.dim("tok/min")}   ${c.dim(`1h avg ${bHr}`)}`,
  );

  if (s.budgetBurnPerMin !== null) {
    const budget = tick(t, "budgetBurn", s.budgetBurnPerMin, formatTokens(s.budgetBurnPerMin));
    lines.push(
      `  ${c.dim(padLabel("Target"))} ${budget} ${c.dim("tok/min")}   ${c.dim("100% at reset")}`,
    );
  }

  if (s.projection?.exhaustionTs != null) {
    const eta = s.projection.exhaustionTs - s.now;
    const within = s.resetTs === null || s.projection.exhaustionTs <= s.resetTs;
    // 枯渇する場合のみ表示（枯渇しない = 正常なので非表示）
    if (within) {
      const msg = eta <= 0
        ? c.red(`depleted (${timeHHMM(s.projection.exhaustionTs)})`)
        : c.red(`in ${formatDuration(eta)} (${timeHHMM(s.projection.exhaustionTs)})`);
      lines.push(`  ${c.dim(padLabel("Run-out"))} ${msg}`);
    }
  }

  if (s.hasActivity) {
    if (t) {
      // watch モード: 直近10分
      if (s.sparkRecent.length) {
        lines.push(c.dim("  Trend (10m) ") + sparkline(s.sparkRecent));
      }
    } else {
      // report モード: 5h全体
      if (s.spark.length) {
        lines.push(c.dim("  Trend ") + sparkline(s.spark));
      }
    }
  }
  return lines.join("\n");
}

/** `usage` コマンド: 公式の 5h / 7d / スコープ別リミットを表示。 */
export function renderUsage(o: OfficialUsage, now: number): string {
  const lines = [c.bold("● usage (/api/oauth/usage)")];
  const win = (label: string, w: { utilization: number; resetsAt: number } | null) => {
    if (!w) {
      lines.push(`  ${label}  ` + c.dim("(none)"));
      return;
    }
    const g = gaugeColor(w.utilization / 100);
    lines.push(
      `  ${label}  ${g(bar(w.utilization / 100, 24))} ${g(`${w.utilization.toFixed(1)}%`)}  ` +
        c.dim(`reset ${formatDuration(w.resetsAt - now)} (${timeHHMM(w.resetsAt)})`),
    );
  };
  win("5h    ", o.fiveHour);
  win("7d    ", o.sevenDay);
  const scoped = o.limits.filter((l) => l.scopeLabel);
  for (const l of scoped) {
    lines.push(
      c.dim(
        `  7d:${l.scopeLabel}  ${(l.percent).toFixed(0)}%  reset ${l.resetsAt ? timeHHMM(l.resetsAt) : "-"}`,
      ),
    );
  }
  lines.push(c.dim(`  fetched ${new Date(o.fetchedAt).toLocaleTimeString()}`));
  return lines.join("\n");
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
      `  ${c.dim(bar(r.share, 12))} ${(r.share * 100).toFixed(0).padStart(3)}%  ` +
        `${formatUSD(r.cost).padStart(8)}  ${tokStr}  ` +
        `${c.dim(`×${String(r.count).padStart(4)}`)}  ${display}`,
    );
  }
  return lines.join("\n");
}

/** ANSI 制御を除いた可視幅。インデント計算用。 */
function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** ドリル木の 1 ノードを再帰でインデント表示。baseIndent は親ツール行の「ラベル開始列」に揃える。 */
function walkDrill(
  lines: string[],
  n: DrillNode,
  depth: number,
  keyPath: string,
  topN: number,
  baseIndent: string,
  t?: Ticker,
): void {
  const indent = baseIndent + "  ".repeat(depth - 1);
  const tokStr = tick(t, `agents:${keyPath}`, n.tokens, formatTokens(n.tokens).padStart(7));
  const marker = depth === 1 ? "▸ " : c.dim("· ");
  lines.push(`${indent}${marker}${tokStr}  ${c.dim(`×${String(n.turns).padStart(3)}`)}  ${n.label}`);
  for (const ch of n.children.slice(0, topN)) {
    walkDrill(lines, ch, depth + 1, `${keyPath}/${ch.key}`, topN, baseIndent, t);
  }
  if (n.children.length > topN) {
    lines.push(`${baseIndent}${"  ".repeat(depth)}${c.dim(`… ${n.children.length - topN} more`)}`);
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
  const hint = hasDrill ? c.dim(expand ? "  [Ctrl-O: collapse]" : "  [Ctrl-O: expand]") : "";
  const lines = [c.bold("Tokens by tool") + c.dim(" (~:est / =:measured)") + hint];
  if (rows.length === 0) {
    lines.push(c.dim("  (none)"));
    return lines.join("\n");
  }
  const drillByTool = new Map(drill.map((n) => [n.key, n]));
  for (const r of rows.slice(0, topN)) {
    const mark = r.estimated ? c.dim("~") : c.green("=");
    const tokStr = tick(t, `tool:${r.tool}`, r.tokens, formatTokens(r.tokens).padStart(7));
    const prefix =
      `  ${c.dim(bar(r.share, 12))} ${(r.share * 100).toFixed(0).padStart(3)}%  ` +
      `${mark}${tokStr}  ${c.dim(`×${String(r.calls).padStart(4)}`)}  `;
    lines.push(prefix + r.tool);
    if (!expand) continue;
    const node = drillByTool.get(r.tool);
    if (!node) continue;
    const baseIndent = " ".repeat(visibleWidth(prefix));
    for (const ch of node.children.slice(0, topN)) {
      walkDrill(lines, ch, 1, `${r.tool}/${ch.key}`, topN, baseIndent, t);
    }
    if (node.children.length > topN) {
      lines.push(`${baseIndent}${c.dim(`… ${node.children.length - topN} more`)}`);
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
  const sections: string[] = [renderBlockStatus(s, t), ""];

  sections.push(c.bold(`■ Breakdown (${rangeLabel})`));

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
        sections.push(
          renderBreakdown("By project", breakdowns.byProject, opts.topN, "project", t),
        );
        break;
      case "hour":
        sections.push(renderBreakdown("By hour", breakdowns.byHour, opts.topN, "hour", t));
        break;
    }
  }
  return sections.join("\n");
}
