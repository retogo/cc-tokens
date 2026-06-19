import type { ToolResultRef, ToolUseRef } from "./parse.ts";
import type { TurnRecord } from "./types.ts";

/**
 * トークン推定の換算係数。tool_result の文字数 → 推定トークン。
 * 正確なトークナイザではなく相対比較用の近似（差し替え口はここに集約）。
 */
export const CHARS_PER_TOKEN = 4;

export function estTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** 直接ツール帰属から除外する名前（サブエージェントは別ファイルで実測するため）。 */
const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent"]);

export interface ToolBreakdownRow {
  tool: string;
  /** トークン。直接ツール=結果文字数からの推定 / Task・Workflow=実消費。 */
  tokens: number;
  /** true=推定(chars/4) / false=実測（サブエージェント usage）。 */
  estimated: boolean;
  /** 呼び出し回数（直接=tool_use 数 / サブ=ターン数）。 */
  calls: number;
  share: number;
}

/** agent 葉ノードの下に出す「その agent が内部で使ったツール」の推定値。 */
export interface AgentToolEstimate {
  tool: string;
  /** 推定トークン（tool_result.chars / CHARS_PER_TOKEN）。 */
  tokens: number;
  /** 呼び出し回数。 */
  calls: number;
}

/** ドリルダウン木のノード（Workflow → wf run → agent / Task → agent）。 */
export interface DrillNode {
  key: string;
  label: string;
  /** 実消費トークン（input+output+cacheCreation）。 */
  tokens: number;
  /** ターン数。 */
  turns: number;
  children: DrillNode[];
  /** agent 葉ノードのみ: 内部で使ったツールの推定（tokens 降順）。 */
  tools?: AgentToolEstimate[];
}

function recTokens(r: TurnRecord): number {
  return r.usage.input + r.usage.output + r.usage.cacheCreation;
}

/** records を keyFn でまとめ、tokens 降順の {key,label,tokens,turns} を返す。 */
function groupRecords(
  records: TurnRecord[],
  keyFn: (r: TurnRecord) => string,
  labelFn: (key: string) => string,
): { key: string; label: string; tokens: number; turns: number; recs: TurnRecord[] }[] {
  const map = new Map<string, { tokens: number; turns: number; recs: TurnRecord[] }>();
  for (const r of records) {
    const k = keyFn(r);
    let g = map.get(k);
    if (!g) {
      g = { tokens: 0, turns: 0, recs: [] };
      map.set(k, g);
    }
    g.tokens += recTokens(r);
    g.turns += 1;
    g.recs.push(r);
  }
  return [...map.entries()]
    .map(([key, g]) => ({ key, label: labelFn(key), ...g }))
    .sort((a, b) => b.tokens - a.tokens);
}

/** agent-<hash> を短縮表示。 */
function shortAgent(id: string): string {
  const h = id.replace(/^agent-/, "");
  return `agent ${h.slice(0, 8)}`;
}

/**
 * サブエージェントのドリルダウン木を作る。
 * - Workflow → 各 workflow 実行(wf_*) → 各 agent
 * - Task → 各 agent
 * agentToolEstimates を渡すと、各 agent 葉ノードに内部で使ったツール推定をぶら下げる。
 */
export function buildSubagentDrill(
  subRecords: TurnRecord[],
  agentToolEstimates?: Map<string, AgentToolEstimate[]>,
): DrillNode[] {
  const wfRecs = subRecords.filter((r) => r.agentKind === "workflow");
  const taskRecs = subRecords.filter((r) => r.agentKind === "task");
  const nodes: DrillNode[] = [];
  const toolsFor = (agentId: string): AgentToolEstimate[] | undefined =>
    agentToolEstimates?.get(agentId);

  if (wfRecs.length) {
    const runs = groupRecords(
      wfRecs,
      (r) => r.workflowId ?? "(unknown)",
      (k) => k,
    ).map((run) => ({
      key: run.key,
      label: run.label,
      tokens: run.tokens,
      turns: run.turns,
      children: groupRecords(run.recs, (r) => r.agentId ?? "(unknown)", shortAgent).map((a) => ({
        key: a.key,
        label: a.label,
        tokens: a.tokens,
        turns: a.turns,
        children: [],
        tools: toolsFor(a.key),
      })),
    }));
    nodes.push({
      key: "Workflow",
      label: "Workflow",
      tokens: runs.reduce((s, r) => s + r.tokens, 0),
      turns: runs.reduce((s, r) => s + r.turns, 0),
      children: runs,
    });
  }

  if (taskRecs.length) {
    const agents = groupRecords(taskRecs, (r) => r.agentId ?? "(unknown)", shortAgent).map((a) => ({
      key: a.key,
      label: a.label,
      tokens: a.tokens,
      turns: a.turns,
      children: [],
      tools: toolsFor(a.key),
    }));
    nodes.push({
      key: "Agent",
      label: "Agent",
      tokens: agents.reduce((s, a) => s + a.tokens, 0),
      turns: agents.reduce((s, a) => s + a.turns, 0),
      children: agents,
    });
  }

  return nodes.sort((a, b) => b.tokens - a.tokens);
}

/** 1 行から取り出したツール I/O（順序を保って渡す）。 */
export interface ToolEvent {
  uses: ToolUseRef[];
  results: ToolResultRef[];
  /** 行の timestamp（epoch ms）。scan 側で必ず非 null の行のみ採用する。 */
  ts: number;
}

/** サブエージェント由来のツール I/O。agentId / agentKind を付けて、どの agent の活動か追跡できるようにする。 */
export interface SubagentToolEvent extends ToolEvent {
  agentKind: "task" | "workflow";
  agentId: string;
  workflowId: string | null;
}

/**
 * サブエージェントのツール I/O を agentId × tool 名で集計し、各 agent の内部消費を推定する。
 * 推定方式は直接ツールと同じ chars/CHARS_PER_TOKEN（agent 自身の usage 実測とは別量）。
 */
export function buildAgentToolEstimates(
  events: SubagentToolEvent[],
): Map<string, AgentToolEstimate[]> {
  // agentId → (toolName → {chars, calls})
  const byAgent = new Map<string, Map<string, { chars: number; calls: number }>>();
  // agentId → (tool_use.id → tool name) で結果と use を結ぶ。
  const idMaps = new Map<string, Map<string, string>>();

  const accFor = (agentId: string): Map<string, { chars: number; calls: number }> => {
    let m = byAgent.get(agentId);
    if (!m) {
      m = new Map();
      byAgent.set(agentId, m);
    }
    return m;
  };
  const idMapFor = (agentId: string): Map<string, string> => {
    let m = idMaps.get(agentId);
    if (!m) {
      m = new Map();
      idMaps.set(agentId, m);
    }
    return m;
  };
  const bump = (agentId: string, tool: string): { chars: number; calls: number } => {
    const m = accFor(agentId);
    let row = m.get(tool);
    if (!row) {
      row = { chars: 0, calls: 0 };
      m.set(tool, row);
    }
    return row;
  };

  for (const ev of events) {
    const idMap = idMapFor(ev.agentId);
    for (const u of ev.uses) {
      // サブエージェントが内部で Task/Agent を呼ぶケースはほぼ無いが、念のため除外し
      // 直接ツール（Read/Bash/Edit など）だけを集計対象にする。
      if (SUBAGENT_TOOL_NAMES.has(u.name)) continue;
      idMap.set(u.id, u.name);
      bump(ev.agentId, u.name).calls += 1;
    }
    for (const res of ev.results) {
      const name = idMap.get(res.toolUseId);
      if (!name) continue;
      bump(ev.agentId, name).chars += res.chars;
    }
  }

  const out = new Map<string, AgentToolEstimate[]>();
  for (const [agentId, m] of byAgent) {
    const rows: AgentToolEstimate[] = [];
    for (const [tool, row] of m) {
      rows.push({ tool, tokens: estTokens(row.chars), calls: row.calls });
    }
    rows.sort((a, b) => b.tokens - a.tokens);
    out.set(agentId, rows);
  }
  return out;
}

interface Acc {
  tokens: number;
  estimated: boolean;
  calls: number;
}

/**
 * ツール別のトークン内訳を作る。
 * - 直接ツール: tool_use.id ↔ tool_result.tool_use_id で結果文字数を名前へ集約し chars/4 で推定。
 *   Task/Agent はサブエージェント側で実測するためここでは除外。
 * - Task/Workflow: subagentRecords を agentKind 別に集計し実消費トークン（input+output+cacheCreation）。
 */
export function buildToolBreakdown(
  toolEvents: ToolEvent[],
  subagentRecords: TurnRecord[],
): ToolBreakdownRow[] {
  const acc = new Map<string, Acc>();
  const bump = (tool: string, estimated: boolean): Acc => {
    let a = acc.get(tool);
    if (!a) {
      a = { tokens: 0, estimated, calls: 0 };
      acc.set(tool, a);
    }
    return a;
  };

  // 直接ツール: id→name を保持しつつ結果文字数を積む。
  const idToName = new Map<string, string>();
  for (const ev of toolEvents) {
    for (const u of ev.uses) {
      if (SUBAGENT_TOOL_NAMES.has(u.name)) continue;
      idToName.set(u.id, u.name);
      bump(u.name, true).calls += 1;
    }
    for (const res of ev.results) {
      const name = idToName.get(res.toolUseId);
      if (!name) continue; // Task/Agent 由来 or 対応不明はスキップ
      bump(name, true).tokens += estTokens(res.chars);
    }
  }

  // サブエージェント: agentKind 別に実消費を集計。
  for (const r of subagentRecords) {
    if (r.agentKind === null) continue;
    const tool = r.agentKind === "workflow" ? "Workflow" : "Agent";
    const a = bump(tool, false);
    a.estimated = false;
    a.tokens += r.usage.input + r.usage.output + r.usage.cacheCreation;
    a.calls += 1;
  }

  const total = [...acc.values()].reduce((s, a) => s + a.tokens, 0);
  const rows: ToolBreakdownRow[] = [];
  for (const [tool, a] of acc) {
    rows.push({
      tool,
      tokens: a.tokens,
      estimated: a.estimated,
      calls: a.calls,
      share: total > 0 ? a.tokens / total : 0,
    });
  }
  rows.sort((a, b) => b.tokens - a.tokens);
  return rows;
}
