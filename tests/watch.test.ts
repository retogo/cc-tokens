import { describe, expect, test } from "bun:test";
import type { ScanResult } from "../src/scan.ts";
import type { TurnRecord } from "../src/types.ts";
import type { ToolEvent } from "../src/attribute.ts";
import { pruneState } from "../src/render/watch.ts";

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

describe("pruneState（長期稼働の state 配列を 2x ウィンドウで切り詰める）", () => {
  test("cutoff 未満の records / toolEvents を捨てる", () => {
    const cutoff = 100;
    const state: ScanResult = {
      records: [rec(50), rec(80), rec(100), rec(150)],
      toolEvents: [ev(50), ev(120), ev(200)],
      sessionTitles: new Map(),
    };
    pruneState(state, cutoff);
    expect(state.records.map((r) => r.ts)).toEqual([100, 150]);
    expect(state.toolEvents.map((e) => e.ts)).toEqual([120, 200]);
  });

  test("配列が空 or 先頭が cutoff 以上なら filter を走らせない（ホットパスで無駄なコピーを避ける）", () => {
    const state: ScanResult = {
      records: [rec(200), rec(300)],
      toolEvents: [],
      sessionTitles: new Map(),
    };
    const origRecords = state.records;
    const origEvents = state.toolEvents;
    pruneState(state, 100);
    expect(state.records).toBe(origRecords);
    expect(state.toolEvents).toBe(origEvents);
  });
});
