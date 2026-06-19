import { describe, expect, test } from "bun:test";
import { parseLine, parseLineFull } from "../src/parse.ts";

const MAIN_PATH = "/x/projects/-fixture-proj/sess-aaa.jsonl";
const WF_PATH =
  "/x/projects/-fixture-proj/sess-aaa/subagents/workflows/wf-1/agent-bbb.jsonl";
const TASK_PATH =
  "/x/projects/-fixture-proj/sess-aaa/subagents/agent-ccc.jsonl";

const assistantLine = JSON.stringify({
  type: "assistant",
  message: {
    model: "claude-opus-4-8",
    role: "assistant",
    content: [
      { type: "text", text: "reading" },
      { type: "tool_use", name: "Read", input: { file_path: "/x" } },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ],
    usage: {
      input_tokens: 1000,
      output_tokens: 50,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 0,
    },
  },
  requestId: "req_1",
  timestamp: "2026-06-18T00:00:10.000Z",
  sessionId: "sess-aaa",
  cwd: "/fixture/proj",
  gitBranch: "main",
  isSidechain: false,
});

describe("parseLine (テスト1: assistant+usage の抽出)", () => {
  test("4カテゴリ・model・ts(epoch)・tool_use名・メタを抽出する", () => {
    const r = parseLine(assistantLine, MAIN_PATH);
    expect(r).not.toBeNull();
    expect(r!.usage).toEqual({
      input: 1000,
      output: 50,
      cacheCreation: 2000,
      cacheRead: 0,
    });
    expect(r!.model).toBe("claude-opus-4-8");
    expect(r!.ts).toBe(Date.parse("2026-06-18T00:00:10.000Z"));
    expect(r!.toolsInvoked).toEqual(["Read", "Bash"]);
    expect(r!.project).toBe("/fixture/proj");
    expect(r!.gitBranch).toBe("main");
    expect(r!.isSidechain).toBe(false);
    expect(r!.agentKind).toBeNull();
    expect(r!.requestId).toBe("req_1");
  });
});

describe("パス由来の種別とフォールバック (テスト3)", () => {
  test("workflows 配下のパスは agentKind=workflow", () => {
    const line = assistantLine.replace('"isSidechain":false', '"isSidechain":true');
    const r = parseLine(line, WF_PATH);
    expect(r!.isSidechain).toBe(true);
    expect(r!.agentKind).toBe("workflow");
  });

  test("subagents 配下(非 workflows)は agentKind=task", () => {
    const r = parseLine(assistantLine, TASK_PATH);
    expect(r!.agentKind).toBe("task");
    // パスがサブエージェントなら isSidechain フラグが無くても sidechain 扱い
    expect(r!.isSidechain).toBe(true);
  });
});

describe("セッションタイトル行の抽出 (ai-title / custom-title)", () => {
  test("ai-title は kind=ai で sessionId/title を返す", () => {
    const line = JSON.stringify({
      type: "ai-title",
      aiTitle: "Refactor parser",
      sessionId: "sess-aaa",
    });
    const p = parseLineFull(line, MAIN_PATH);
    expect(p.record).toBeNull();
    expect(p.title).toEqual({ sessionId: "sess-aaa", kind: "ai", title: "Refactor parser" });
  });

  test("custom-title は kind=custom で返す（手動指定が優先源）", () => {
    const line = JSON.stringify({
      type: "custom-title",
      customTitle: "agent-skills",
      sessionId: "sess-bbb",
    });
    const p = parseLineFull(line, MAIN_PATH);
    expect(p.title).toEqual({ sessionId: "sess-bbb", kind: "custom", title: "agent-skills" });
  });

  test("title 文字列が空ならタイトルとして扱わない", () => {
    const line = JSON.stringify({ type: "ai-title", aiTitle: "", sessionId: "s" });
    expect(parseLineFull(line, MAIN_PATH).title).toBeNull();
  });

  test("非タイトル行は title=null", () => {
    expect(parseLineFull(assistantLine, MAIN_PATH).title).toBeNull();
  });
});

describe("非対象行・壊れた行は null (テスト2)", () => {
  test.each([
    ['mode 行', '{"type":"mode","mode":"normal","sessionId":"s"}'],
    ["user 行", '{"type":"user","message":{"role":"user","content":[]}}'],
    ["system 行", '{"type":"system","subtype":"info"}'],
    ["usage 無し assistant", '{"type":"assistant","message":{"model":"m","content":[]}}'],
    ["壊れた JSON", "{not valid json"],
    ["空行", "   "],
  ])("%s → null", (_label, line) => {
    expect(parseLine(line, MAIN_PATH)).toBeNull();
  });
});
