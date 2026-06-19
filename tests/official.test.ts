import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthToken, parseOfficialUsage } from "../src/official.ts";

const raw = await Bun.file(join(import.meta.dir, "..", "fixtures", "official-usage.json")).json();
const FETCHED = Date.parse("2026-06-18T03:30:00.000Z");

describe("parseOfficialUsage（実レスポンス）", () => {
  const u = parseOfficialUsage(raw, FETCHED);

  test("five_hour の utilization と resets_at を取り出す", () => {
    expect(u.fiveHour).not.toBeNull();
    expect(u.fiveHour!.utilization).toBe(50);
    expect(u.fiveHour!.resetsAt).toBe(Date.parse("2026-06-18T08:30:00.684728+00:00"));
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

describe("getOAuthToken は CLAUDE_CONFIG_DIR を尊重する", () => {
  const dir = mkdtempSync(join(tmpdir(), "cctok-cred-"));
  const origEnv = process.env.CLAUDE_CONFIG_DIR;
  const origPlatform = process.platform;

  beforeAll(async () => {
    // macOS の Keychain 経路を踏まないよう platform を上書きする（読み取り経路のみ検証）。
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.CLAUDE_CONFIG_DIR = dir;
    await Bun.write(
      join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "from-overridden-dir" } }),
    );
  });

  afterAll(() => {
    if (origEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origEnv;
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("CLAUDE_CONFIG_DIR 配下の .credentials.json を読む", async () => {
    expect(await getOAuthToken()).toBe("from-overridden-dir");
  });
});
