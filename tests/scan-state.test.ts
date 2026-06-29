import { describe, expect, test } from "bun:test";
import type { SubagentToolEvent, ToolEvent } from "../src/attribute.ts";
import type { ScanResult } from "../src/scan.ts";
import { merge, pruneState } from "../src/scan-state.ts";
import type { TurnRecord } from "../src/types.ts";

function rec(ts: number, sessionId = "s"): TurnRecord {
  return {
    ts,
    model: "m",
    sessionId,
    project: "/p",
    gitBranch: "main",
    usage: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 },
    toolsInvoked: [],
    isSidechain: false,
    agentKind: null,
    workflowId: null,
    agentId: null,
    requestId: null,
    messageId: null,
  };
}

function ev(ts: number): ToolEvent {
  return { uses: [], results: [], ts };
}

function subEv(ts: number, agentId = "agent-aaa"): SubagentToolEvent {
  return { uses: [], results: [], ts, agentKind: "task", agentId, workflowId: null };
}

describe("merge", () => {
  test("空でない sessionTitles を採用し、空のときは据え置く", () => {
    const into: ScanResult = {
      records: [],
      toolEvents: [],
      subagentToolEvents: [],
      sessionTitles: new Map([["s1", "Existing"]]),
    };
    // 空 sessionTitles の merge では既存値が残る（Scanner が空のとき毎回 reset しないため）。
    merge(into, {
      records: [rec(1)],
      toolEvents: [],
      subagentToolEvents: [],
      sessionTitles: new Map(),
    });
    expect(into.sessionTitles.get("s1")).toBe("Existing");
    // 空でない sessionTitles の merge では上書きする（Scanner 最新スナップショット）。
    merge(into, {
      records: [],
      toolEvents: [],
      subagentToolEvents: [],
      sessionTitles: new Map([["s2", "Newer"]]),
    });
    expect(into.sessionTitles.get("s1")).toBeUndefined();
    expect(into.sessionTitles.get("s2")).toBe("Newer");
  });

  test("records / toolEvents / subagentToolEvents は append される", () => {
    const into: ScanResult = {
      records: [rec(1)],
      toolEvents: [ev(1)],
      subagentToolEvents: [subEv(1)],
      sessionTitles: new Map(),
    };
    merge(into, {
      records: [rec(2)],
      toolEvents: [ev(2)],
      subagentToolEvents: [subEv(2)],
      sessionTitles: new Map(),
    });
    expect(into.records.length).toBe(2);
    expect(into.toolEvents.length).toBe(2);
    expect(into.subagentToolEvents.length).toBe(2);
  });
});

describe("pruneState（5h 外の sessionTitles も削除する）", () => {
  test("cutoff より古い records / toolEvents / subagentToolEvents を捨てる", () => {
    const state: ScanResult = {
      records: [rec(50), rec(100), rec(150)],
      toolEvents: [ev(50), ev(120)],
      subagentToolEvents: [subEv(40), subEv(110)],
      sessionTitles: new Map(),
    };
    pruneState(state, 100);
    expect(state.records.map((r) => r.ts)).toEqual([100, 150]);
    expect(state.toolEvents.map((e) => e.ts)).toEqual([120]);
    expect(state.subagentToolEvents.map((e) => e.ts)).toEqual([110]);
  });

  test("cutoff 後に残った sessionId だけを sessionTitles に残す（長期 daemon の titles 肥大対策）", () => {
    // 受理 finding『pruneState が sessionTitles を畳まず…』の退行検知。
    const state: ScanResult = {
      records: [rec(50, "old"), rec(200, "live")],
      toolEvents: [],
      subagentToolEvents: [],
      sessionTitles: new Map([
        ["old", "Stale Title"],
        ["live", "Active Title"],
        ["never-seen", "Phantom"],
      ]),
    };
    pruneState(state, 100);
    // 'old' は records から消えるので titles からも除外
    expect(state.sessionTitles.has("old")).toBe(false);
    // 'live' は残る
    expect(state.sessionTitles.get("live")).toBe("Active Title");
    // records に一度も出ない 'never-seen' も削除（active set 外）
    expect(state.sessionTitles.has("never-seen")).toBe(false);
  });

  test("sessionTitles が空のときは何もしない（不要なコピーを発生させない）", () => {
    const state: ScanResult = {
      records: [rec(200)],
      toolEvents: [],
      subagentToolEvents: [],
      sessionTitles: new Map(),
    };
    const orig = state.sessionTitles;
    pruneState(state, 100);
    expect(state.sessionTitles).toBe(orig);
  });
});
