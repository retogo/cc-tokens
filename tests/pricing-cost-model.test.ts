import { describe, expect, test } from "bun:test";
import { costOf, priceFor } from "../src/pricing.ts";
import type { PricingAttributes, TokenUsage } from "../src/types.ts";

/**
 * Claude Code 本体のコスト計算（`/cost`）と同じ式に揃えるためのテスト。
 * - cache write は 1h 分と 5m 分で単価が違う（input×2 / input×1.25）
 * - `speed: "fast"` は opus 系のみ専用の価格行
 * - `inference_geo: "us"` はトークン費用のみ ×1.1
 * - web search は 1 リクエスト $0.01 で、geo 倍率の外側に足す
 */

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, ...over };
}

function attrs(over: Partial<PricingAttributes> = {}): PricingAttributes {
  return {
    cacheCreation1h: 0,
    webSearchRequests: 0,
    speed: null,
    inferenceGeo: null,
    ...over,
  };
}

describe("cache write の 1h / 5m 単価", () => {
  test("cacheWrite1h は input×2（Opus は 10）", () => {
    const p = priceFor("claude-opus-4-8", attrs());
    expect(p.cacheWrite1h).toBeCloseTo(10, 10);
    expect(p.cacheWrite).toBeCloseTo(6.25, 10);
  });

  test("1h 分は cacheWrite1h、残りは cacheWrite で課金する", () => {
    const u = usage({ cacheCreation: 1_000_000 });
    // 600_000/1e6*10 + 400_000/1e6*6.25
    expect(costOf(u, "claude-opus-4-8", attrs({ cacheCreation1h: 600_000 }))).toBeCloseTo(
      6 + 2.5,
      10,
    );
  });

  test("cacheCreation1h が 0 なら全額 5m 単価", () => {
    const u = usage({ cacheCreation: 1_000_000 });
    expect(costOf(u, "claude-opus-4-8", attrs())).toBeCloseTo(6.25, 10);
  });

  test("cacheCreation1h が総量を超えても総量で頭打ちにする", () => {
    const u = usage({ cacheCreation: 500_000 });
    expect(costOf(u, "claude-opus-4-8", attrs({ cacheCreation1h: 900_000 }))).toBeCloseTo(5, 10);
  });
});

describe("fast mode の価格行", () => {
  test("Opus 5 の fast は input=10 / output=50 / cacheWrite1h=20", () => {
    const p = priceFor("claude-opus-5", attrs({ speed: "fast" }));
    expect(p.input).toBe(10);
    expect(p.output).toBe(50);
    expect(p.cacheWrite).toBeCloseTo(12.5, 10);
    expect(p.cacheWrite1h).toBeCloseTo(20, 10);
    expect(p.cacheRead).toBeCloseTo(1, 10);
  });

  test("Opus 4.7 の fast は input=30 / output=150", () => {
    const p = priceFor("claude-opus-4-7", attrs({ speed: "fast" }));
    expect(p.input).toBe(30);
    expect(p.output).toBe(150);
  });

  test("fast でも opus 以外は通常価格", () => {
    expect(priceFor("claude-sonnet-5", attrs({ speed: "fast" })).input).toBe(
      priceFor("claude-sonnet-5", attrs()).input,
    );
  });

  test("speed が standard なら通常価格", () => {
    expect(priceFor("claude-opus-5", attrs({ speed: "standard" })).input).toBe(5);
  });
});

describe("inference_geo と web search", () => {
  test("inference_geo=us はトークン費用を ×1.1 する", () => {
    const u = usage({ input: 1_000_000 });
    expect(costOf(u, "claude-opus-4-8", attrs({ inferenceGeo: "us" }))).toBeCloseTo(5.5, 10);
  });

  test("us 以外の inference_geo は倍率をかけない", () => {
    const u = usage({ input: 1_000_000 });
    expect(costOf(u, "claude-opus-4-8", attrs({ inferenceGeo: "not_available" }))).toBeCloseTo(
      5,
      10,
    );
  });

  test("web search は 1 リクエスト $0.01", () => {
    const u = usage();
    expect(costOf(u, "claude-opus-4-8", attrs({ webSearchRequests: 3 }))).toBeCloseTo(0.03, 10);
  });

  test("web search 費用には geo 倍率をかけない", () => {
    const u = usage({ input: 1_000_000 });
    expect(
      costOf(u, "claude-opus-4-8", attrs({ inferenceGeo: "us", webSearchRequests: 3 })),
    ).toBeCloseTo(5.5 + 0.03, 10);
  });
});
