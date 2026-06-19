import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseOfficialUsage } from "../src/official.ts";

const raw = await Bun.file(
  join(import.meta.dir, "..", "fixtures", "official-usage.json"),
).json();
const FETCHED = Date.parse("2026-06-18T03:30:00.000Z");

describe("parseOfficialUsage（実レスポンス）", () => {
  const u = parseOfficialUsage(raw, FETCHED);

  test("five_hour の utilization と resets_at を取り出す", () => {
    expect(u.fiveHour).not.toBeNull();
    expect(u.fiveHour!.utilization).toBe(50);
    expect(u.fiveHour!.resetsAt).toBe(
      Date.parse("2026-06-18T08:30:00.684728+00:00"),
    );
  });

  test("seven_day も取り出す", () => {
    expect(u.sevenDay!.utilization).toBe(45);
  });

  test("limits を正規化（resetsAt epoch・scope モデル名・isActive）", () => {
    const session = u.limits.find((l) => l.kind === "session")!;
    expect(session.isActive).toBe(true);
    expect(session.percent).toBe(50);
    const scoped = u.limits.find((l) => l.kind === "weekly_scoped")!;
    expect(scoped.scopeLabel).toBe("Sonnet");
  });

  test("fetchedAt を保持する", () => {
    expect(u.fetchedAt).toBe(FETCHED);
  });

  test("null/欠落フィールドに強い", () => {
    const empty = parseOfficialUsage({}, FETCHED);
    expect(empty.fiveHour).toBeNull();
    expect(empty.sevenDay).toBeNull();
    expect(empty.limits).toEqual([]);
  });
});
