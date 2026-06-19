import { describe, expect, test } from "bun:test";
import { costOf, priceFor, weightedOf } from "../src/pricing.ts";
import type { TokenUsage } from "../src/types.ts";

const u: TokenUsage = {
  input: 1000,
  output: 50,
  cacheCreation: 2000,
  cacheRead: 10000,
};

describe("pricing (テスト4)", () => {
  test("Opus 4.8 の料金: cache_write=input×1.25 / cache_read=input×0.1", () => {
    const p = priceFor("claude-opus-4-8");
    expect(p.input).toBe(5);
    expect(p.output).toBe(25);
    expect(p.cacheWrite).toBeCloseTo(6.25, 10);
    expect(p.cacheRead).toBeCloseTo(0.5, 10);
  });

  test("costOf は各カテゴリ×$/Mtok の合計（ドル）", () => {
    // 1000/1e6*5 + 50/1e6*25 + 2000/1e6*6.25 + 10000/1e6*0.5
    const expected = 0.005 + 0.00125 + 0.0125 + 0.005;
    expect(costOf(u, "claude-opus-4-8")).toBeCloseTo(expected, 10);
  });

  test("モデル名は部分一致で解決（バージョン付きでも）", () => {
    expect(priceFor("claude-haiku-4-5-20251001").input).toBe(
      priceFor("haiku").input,
    );
    expect(priceFor("claude-sonnet-4-6").output).toBe(15);
  });

  test("未知モデルは fallback 価格を返す（例外を投げない）", () => {
    expect(priceFor("totally-unknown-model").input).toBeGreaterThan(0);
  });

  test("weightedOf 既定(cost) は costOf と一致", () => {
    expect(weightedOf(u, "claude-opus-4-8")).toBeCloseTo(
      costOf(u, "claude-opus-4-8"),
      10,
    );
  });

  test("weightedOf raw は cache_read を除いた生トークン合計", () => {
    const w = weightedOf(u, "claude-opus-4-8", { mode: "raw" });
    expect(w).toBe(1000 + 50 + 2000); // cacheRead 除外
  });
});
