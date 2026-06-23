import type { AgentKind, TurnRecord } from "./types.ts";

/** assistant の tool_use ブロック（id↔name 対応用）。 */
export interface ToolUseRef {
  id: string;
  name: string;
}

/** user の tool_result ブロック（id でツール名に逆引きする）。 */
export interface ToolResultRef {
  toolUseId: string;
  chars: number;
}

/** セッション名イベント。custom は手動指定で ai より優先される。 */
export interface SessionTitleEvent {
  sessionId: string;
  kind: "custom" | "ai";
  title: string;
}

/** 1 行の完全解析結果。1 回の JSON.parse で turn とツール I/O を取り出す。 */
export interface ParsedLine {
  record: TurnRecord | null;
  toolUses: ToolUseRef[];
  toolResults: ToolResultRef[];
  /** 行の timestamp（epoch ms）。record の有無に関わらず取得。無ければ null。 */
  lineTs: number | null;
  /** ai-title / custom-title 行のときのみ非 null。 */
  title: SessionTitleEvent | null;
}

const EMPTY: ParsedLine = {
  record: null,
  toolUses: [],
  toolResults: [],
  lineTs: null,
  title: null,
};

/**
 * ファイルパスからサブエージェント種別を判定する。
 * - `/subagents/workflows/` を含む → "workflow"
 * - `/subagents/` を含む            → "task"
 * - それ以外（メインセッション）    → null
 */
export function agentKindFromPath(filePath: string): AgentKind {
  if (filePath.includes("/subagents/workflows/")) return "workflow";
  if (filePath.includes("/subagents/")) return "task";
  return null;
}

/** パスからワークフロー実行 ID / エージェント ID を抽出する。 */
export function subagentIdsFromPath(filePath: string): {
  workflowId: string | null;
  agentId: string | null;
} {
  const wf = filePath.match(/\/subagents\/workflows\/([^/]+)\//);
  const ag = filePath.match(/\/(agent-[^/]+)\.jsonl$/);
  return { workflowId: wf?.[1] ?? null, agentId: ag?.[1] ?? null };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** tool_result.content の文字数（文字列 or 構造化どちらも計測）。 */
function resultChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (content == null) return 0;
  try {
    return JSON.stringify(content).length;
  } catch {
    return 0;
  }
}

/** JSONL 1 行を完全解析する。壊れた JSON は EMPTY。 */
export function parseLineFull(line: string, filePath: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return EMPTY;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return EMPTY;
  }
  if (!isRecord(raw)) return EMPTY;
  const obj = raw;

  const msg = isRecord(obj.message) ? obj.message : null;
  const content: unknown[] = msg && Array.isArray(msg.content) ? msg.content : [];

  const lineTsRaw = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
  const lineTs = Number.isNaN(lineTsRaw) ? null : lineTsRaw;

  let title: SessionTitleEvent | null = null;
  if (obj.type === "custom-title" || obj.type === "ai-title") {
    const sid = typeof obj.sessionId === "string" ? obj.sessionId : "";
    const titleRaw = obj.type === "custom-title" ? obj.customTitle : obj.aiTitle;
    const text = typeof titleRaw === "string" ? titleRaw.trim() : "";
    if (sid && text) {
      title = { sessionId: sid, kind: obj.type === "custom-title" ? "custom" : "ai", title: text };
    }
  }

  const toolUses: ToolUseRef[] = [];
  const toolResults: ToolResultRef[] = [];
  const toolNames: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_use" && typeof block.name === "string") {
      toolNames.push(block.name);
      // id が欠落した tool_use は id↔name 対応に乗せない（空文字キーで保持すると idToName の
      // 上書きが起きて全 tool_result が直近の空 id 名へ誤帰属する）。toolsInvoked への計上は別途行う。
      if (typeof block.id === "string") {
        toolUses.push({ id: block.id, name: block.name });
      }
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      toolResults.push({
        toolUseId: block.tool_use_id,
        chars: resultChars(block.content),
      });
    }
  }

  let record: TurnRecord | null = null;
  if (obj.type === "assistant" && msg && isRecord(msg.usage) && lineTs !== null) {
    const usage = msg.usage;
    const agentKind = agentKindFromPath(filePath);
    const ids = subagentIdsFromPath(filePath);
    record = {
      ts: lineTs,
      model: typeof msg.model === "string" ? msg.model : "unknown",
      sessionId: typeof obj.sessionId === "string" ? obj.sessionId : "",
      project: typeof obj.cwd === "string" ? obj.cwd : "",
      gitBranch: typeof obj.gitBranch === "string" ? obj.gitBranch : "",
      usage: {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheCreation: num(usage.cache_creation_input_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
      },
      toolsInvoked: toolNames,
      isSidechain: obj.isSidechain === true || agentKind !== null,
      agentKind,
      workflowId: ids.workflowId,
      agentId: ids.agentId,
      requestId: typeof obj.requestId === "string" ? obj.requestId : null,
      messageId: typeof msg.id === "string" ? msg.id : null,
    };
  }

  return { record, toolUses, toolResults, lineTs, title };
}

/** assistant+usage の TurnRecord のみが必要な場合の薄いラッパ。 */
export function parseLine(line: string, filePath: string): TurnRecord | null {
  return parseLineFull(line, filePath).record;
}
