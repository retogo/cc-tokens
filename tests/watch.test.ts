import { describe, expect, test } from "bun:test";
import type { SubagentToolEvent, ToolEvent } from "../src/attribute.ts";
import { pruneState } from "../src/render/watch.ts";
import type { ScanResult } from "../src/scan.ts";
import type { TurnRecord } from "../src/types.ts";

function rec(ts: number): TurnRecord {
  return {
    ts,
    model: "m",
    sessionId: "s",
    project: "/p",
    gitBranch: "main",
    usage: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 },
    toolsInvoked: [],
    isSidechain: false,
    agentKind: null,
    workflowId: null,
    agentId: null,
    requestId: null,
  };
}

function ev(ts: number): ToolEvent {
  return { uses: [], results: [], ts };
}

function subEv(ts: number, agentId = "agent-aaa"): SubagentToolEvent {
  return { uses: [], results: [], ts, agentKind: "task", agentId, workflowId: null };
}

describe("pruneState（長期稼働の state 配列を 2x ウィンドウで切り詰める）", () => {
  test("cutoff 未満の records / toolEvents / subagentToolEvents を捨てる", () => {
    const cutoff = 100;
    const state: ScanResult = {
      records: [rec(50), rec(80), rec(100), rec(150)],
      toolEvents: [ev(50), ev(120), ev(200)],
      subagentToolEvents: [subEv(40), subEv(110), subEv(220)],
      sessionTitles: new Map(),
    };
    pruneState(state, cutoff);
    expect(state.records.map((r) => r.ts)).toEqual([100, 150]);
    expect(state.toolEvents.map((e) => e.ts)).toEqual([120, 200]);
    expect(state.subagentToolEvents.map((e) => e.ts)).toEqual([110, 220]);
  });

  test("配列が空 or 先頭が cutoff 以上なら filter を走らせない（ホットパスで無駄なコピーを避ける）", () => {
    const state: ScanResult = {
      records: [rec(200), rec(300)],
      toolEvents: [],
      subagentToolEvents: [],
      sessionTitles: new Map(),
    };
    const origRecords = state.records;
    const origEvents = state.toolEvents;
    const origSubEvents = state.subagentToolEvents;
    pruneState(state, 100);
    expect(state.records).toBe(origRecords);
    expect(state.toolEvents).toBe(origEvents);
    expect(state.subagentToolEvents).toBe(origSubEvents);
  });
});
