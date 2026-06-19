import { describe, expect, test } from "bun:test";
import { burnRateOverWindow, FIVE_HOURS_MS, projectExhaustion } from "../src/blocks.ts";
import type { TokenUsage, TurnRecord } from "../src/types.ts";

const MIN = 60 * 1000;
const T0 = Date.parse("2026-06-18T00:00:00.000Z");

function rec(offsetMs: number, raw: number): TurnRecord {
  const usage: TokenUsage = {
    input: raw,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
  };
  return {
    ts: T0 + offsetMs,
    model: "claude-opus-4-8",
    sessionId: "s",
    project: "/p",
    gitBranch: "main",
    usage,
    toolsInvoked: [],
    isSidechain: false,
    agentKind: null,
    workflowId: null,
    agentId: null,
    requestId: null,
  };
}

const RAW = { mode: "raw" as const };

describe("FIVE_HOURS_MS", () => {
  test("5h をミリ秒で表す", () => {
    expect(FIVE_HOURS_MS).toBe(5 * 60 * 60 * 1000);
  });
});

describe("burnRateOverWindow", () => {
  const records = [rec(0, 600), rec(10 * MIN, 600)];
  const now = T0 + 10 * MIN;

  test("直近N分のバーンレート（加重=生トークン）", () => {
    const br = burnRateOverWindow(records, 5 * MIN, now, RAW);
    expect(br.weightedPerMin).toBeCloseTo(120, 6); // 直近5分は 600 / 5min
  });

  test("ウィンドウ全体平均", () => {
    const br = burnRateOverWindow(records, 10 * MIN, now, RAW);
    expect(br.weightedPerMin).toBeCloseTo(120, 6); // 1200 / 10min
  });

  test("ウィンドウ外のターンは含めない", () => {
    const br = burnRateOverWindow(records, 1 * MIN, now, RAW);
    expect(br.weightedPerMin).toBeCloseTo(600, 6); // 直近1分は 600 のみ
  });
});

describe("projectExhaustion", () => {
  const now = T0 + 10 * MIN;
  const windowEnd = T0 + 300 * MIN; // +5h

  test("枯渇予測時刻と着地予測", () => {
    const p = projectExhaustion(1200, 6000, 120, now, windowEnd);
    // remaining 4800 / 120 = 40 分後
    expect(p.exhaustionTs).toBe(now + 40 * MIN);
    // 1200 + 120 * (290 分) = 36000
    expect(p.projectedWeightedAtWindowEnd).toBeCloseTo(36000, 6);
  });

  test("burn 0 または limit 無しなら exhaustionTs は null", () => {
    expect(projectExhaustion(1200, 6000, 0, now, windowEnd).exhaustionTs).toBeNull();
    expect(projectExhaustion(1200, null, 120, now, windowEnd).exhaustionTs).toBeNull();
  });

  test("既に limit 超過なら now を返す", () => {
    expect(projectExhaustion(7000, 6000, 120, now, windowEnd).exhaustionTs).toBe(now);
  });
});
