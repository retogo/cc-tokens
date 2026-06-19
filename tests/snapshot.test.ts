import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Scanner } from "../src/scan.ts";
import { buildSnapshot, rangeStart } from "../src/snapshot.ts";
import { DEFAULTS } from "../src/config.ts";
import { parseOfficialUsage } from "../src/official.ts";
import { renderBlockStatus } from "../src/render/report.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "projects");
const NOW = Date.parse("2026-06-18T00:02:00.000Z"); // fixture 群の直後（5h 以内）

async function snap(official = null as Parameters<typeof buildSnapshot>[3]) {
  const sc = new Scanner(FIX);
  const scan = await sc.seed();
  return buildSnapshot(scan, DEFAULTS, NOW, official);
}

/** util% と「NOW から minutes 分後の reset」を持つ API データ。 */
function officialAt(util: number, minutesToReset: number) {
  const reset = NOW + minutesToReset * 60_000;
  return parseOfficialUsage(
    { five_hour: { utilization: util, resets_at: new Date(reset).toISOString() } },
    NOW,
  );
}

describe("buildSnapshot（fixture 統合）", () => {
  test("現在ウィンドウに全 5 レコードを含む（main3 + subagent2）", async () => {
    const s = await snap();
    expect(s.hasActivity).toBe(true);
    expect(s.turns).toBe(5);
    expect(s.windowStart).toBe(NOW - 5 * 3600_000); // API なしは直近5h
    expect(s.resetTs).toBeNull(); // API なしは reset を出さない
  });

  test("ツール内訳: Workflow が実測、Read/Bash が推定", async () => {
    const s = await snap();
    const wf = s.tools.find((t) => t.tool === "Workflow")!;
    // 実測 = (300+20+3000)+(350+400+100)
    expect(wf.tokens).toBe(300 + 20 + 3000 + (350 + 400 + 100));
    expect(wf.estimated).toBe(false);
    const read = s.tools.find((t) => t.tool === "Read")!;
    expect(read.tokens).toBe(10); // 40 字 / 4
    expect(read.estimated).toBe(true);
    const bash = s.tools.find((t) => t.tool === "Bash")!;
    expect(bash.tokens).toBe(2); // 8 字 / 4
  });

  test("モデル内訳: opus(4ターン) が sonnet(1) より上位", async () => {
    const s = await snap();
    expect(s.byModel[0]!.key).toContain("opus");
    expect(s.byModel.find((r) => r.key.includes("opus"))!.count).toBe(4);
  });

  test("API が無ければ pct / effectiveLimit / resetTs はすべて null（使用量は出る）", async () => {
    const s = await snap(null);
    expect(s.pct).toBeNull();
    expect(s.effectiveLimit).toBeNull();
    expect(s.resetTs).toBeNull();
    expect(s.usedWeighted).toBeGreaterThan(0);
  });
});

describe("API（/api/oauth/usage）統合", () => {
  test("pct は utilization、reset は resets_at、limit は逆算", async () => {
    const sc = new Scanner(FIX);
    const scan = await sc.seed();
    // reset を NOW(00:02Z) より後にし、ウィンドウ(reset-5h)が fixture(00:00Z) を含むようにする
    const official = parseOfficialUsage(
      { five_hour: { utilization: 50, resets_at: "2026-06-18T02:00:00Z" } },
      NOW,
    );
    const s = buildSnapshot(scan, DEFAULTS, NOW, official);
    expect(s.pct).toBe(0.5);
    expect(s.resetTs).toBe(Date.parse("2026-06-18T02:00:00Z"));
    expect(s.windowStart).toBe(Date.parse("2026-06-18T02:00:00Z") - 5 * 3600_000);
    expect(s.usedWeighted).toBeGreaterThan(0);
    // effectiveLimit = usedWeighted / 0.5
    expect(s.effectiveLimit).toBeCloseTo(s.usedWeighted / 0.5, 10);
  });

  test("使い切りペース = 残り(limit-used) / reset までの分", async () => {
    const s = await snap(officialAt(50, 100)); // util50%, reset 100分後
    // effectiveLimit = used/0.5 = 2*used → 残り = used → /100分
    expect(s.budgetBurnPerMin).toBeCloseTo(s.usedWeighted / 100, 6);
  });

  test("API が無ければ使い切りペースは null", async () => {
    const s = await snap(null);
    expect(s.budgetBurnPerMin).toBeNull();
  });

  test("目標ペースが表示に出る", async () => {
    const s = await snap(officialAt(50, 100));
    const out = renderBlockStatus(s);
    expect(out).toContain("Target");
    expect(out).toContain("100% at reset");
  });
});

describe("rangeStart", () => {
  const now = Date.parse("2026-06-18T03:30:00.000Z");
  test("block/all は null", () => {
    expect(rangeStart("block", now)).toBeNull();
    expect(rangeStart("all", now)).toBeNull();
  });
  test("7d は 7 日前", () => {
    expect(rangeStart("7d", now)).toBe(now - 7 * 24 * 3600_000);
  });
  test("today はローカル日の 0 時", () => {
    const d = new Date(rangeStart("today", now)!);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});
