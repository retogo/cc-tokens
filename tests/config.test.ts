import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULTS, loadConfig } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "cctok-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadConfig（読み取り専用設定）", () => {
  test("既定はトークン基準・5秒インターバル", () => {
    expect(DEFAULTS.weighting).toEqual({ mode: "raw" });
    expect(DEFAULTS.intervalSec).toBe(5);
  });

  test("存在しないパスは DEFAULTS を返す", async () => {
    const c = await loadConfig(join(dir, "nope.json"));
    expect(c).toEqual(DEFAULTS);
  });

  test("ユーザー編集の値を DEFAULTS にマージする", async () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ intervalSec: 2 }));
    const c = await loadConfig(p);
    expect(c.intervalSec).toBe(2);
    expect(c.windowHours).toBe(DEFAULTS.windowHours);
    expect(c.weighting).toEqual(DEFAULTS.weighting);
  });

  test("壊れた JSON は DEFAULTS にフォールバック", async () => {
    const p = join(dir, "broken.json");
    writeFileSync(p, "{not json");
    expect(await loadConfig(p)).toEqual(DEFAULTS);
  });
});
