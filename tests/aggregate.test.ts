import { describe, expect, test } from "bun:test";
import { byHour, byModel, byProject, bySession, groupBy } from "../src/aggregate.ts";
import type { TokenUsage, TurnRecord } from "../src/types.ts";

function rec(partial: Partial<TurnRecord> & { usage: TokenUsage }): TurnRecord {
  return {
    ts: Date.parse("2026-06-18T03:30:00.000Z"),
    model: "claude-opus-4-8",
    sessionId: "s1",
    project: "/p1",
    gitBranch: "main",
    toolsInvoked: [],
    isSidechain: false,
    agentKind: null,
    workflowId: null,
    agentId: null,
    requestId: null,
    ...partial,
  };
}

const records: TurnRecord[] = [
  rec({
    model: "claude-opus-4-8",
    usage: { input: 1000, output: 100, cacheCreation: 0, cacheRead: 0 },
  }),
  rec({
    model: "claude-opus-4-8",
    usage: { input: 0, output: 50, cacheCreation: 0, cacheRead: 0 },
  }),
  rec({
    model: "claude-sonnet-4-6",
    usage: { input: 100, output: 10, cacheCreation: 0, cacheRead: 0 },
  }),
];

describe("groupBy (テスト10)", () => {
  test("モデル別に weighted/cost/count を集計し share 降順", () => {
    const rows = byModel(records);
    expect(rows[0]!.key).toContain("opus"); // opus の方が高コスト
    const opus = rows.find((r) => r.key.includes("opus"))!;
    expect(opus.count).toBe(2);
    expect(opus.usage.input).toBe(1000);
    expect(opus.usage.output).toBe(150);
    const total = rows.reduce((s, r) => s + r.share, 0);
    expect(total).toBeCloseTo(1, 6);
    // 降順
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.weighted).toBeGreaterThanOrEqual(rows[i]!.weighted);
    }
  });

  test("セッション別・プロジェクト別キー", () => {
    expect(bySession(records)[0]!.key).toBe("s1");
    expect(byProject(records)[0]!.key).toBe("/p1");
  });

  test("時間帯別キーはローカル時刻の時（HH）", () => {
    const rows = byHour(records);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(3);
  });

  test("汎用 groupBy: 任意キー関数で分割", () => {
    const rows = groupBy(records, (r) => r.gitBranch);
    expect(rows[0]!.key).toBe("main");
    expect(rows[0]!.count).toBe(3);
  });
});
