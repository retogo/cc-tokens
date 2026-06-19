import { describe, expect, test } from "bun:test";
import {
  bar,
  formatDuration,
  formatTokens,
  formatUSD,
  sparkline,
  Ticker,
} from "../src/render/bars.ts";

describe("整形ヘルパ", () => {
  test("formatTokens は k/M に丸める（<10k は小数2桁、10k 以上は1桁）", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_234)).toBe("1.23k");
    expect(formatTokens(9_999)).toBe("10.00k");
    expect(formatTokens(12_300)).toBe("12.3k");
    expect(formatTokens(1_250_000)).toBe("1.25M");
  });

  test("formatUSD はドル表記", () => {
    expect(formatUSD(0.01875)).toBe("$0.019");
    expect(formatUSD(12.5)).toBe("$12.50");
  });

  test("formatDuration は h/m 表記、負やゼロは即時表現", () => {
    expect(formatDuration(90 * 60 * 1000)).toBe("1h30m");
    expect(formatDuration(45 * 1000)).toBe("45s");
    expect(formatDuration(-1)).toBe("now");
  });

  test("bar は幅に応じた塗りつぶし（fraction クランプ）", () => {
    expect(bar(0.5, 10)).toHaveLength(10);
    expect(bar(0, 10)).toBe("░".repeat(10));
    expect(bar(1, 10)).toBe("█".repeat(10));
    expect(bar(2, 10)).toBe("█".repeat(10)); // >1 はクランプ
  });

  test("sparkline は値域を 8 段階ブロックへ写像", () => {
    const s = sparkline([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(s).toHaveLength(8);
    expect(s[0]).toBe("▁");
    expect(s[7]).toBe("█");
  });

  test("sparkline 空配列は空文字", () => {
    expect(sparkline([])).toBe("");
  });
});

describe("Ticker（株価風の変化色付け）", () => {
  // NO_COLOR をテスト時に強制するため、色コードの有無ではなく ▲▼ マーカで判定
  // arrow=true ではレイアウト固定のため、マーカが出ない時も 1 文字幅のスペースを足す。
  test("初回は着色なし（マーカ枠はスペース）", () => {
    const t = new Ticker();
    expect(t.fmt("a", 100, "100")).toBe("100 ");
  });

  test("増加は ▲、減少は ▼ が付く", () => {
    const t = new Ticker();
    t.fmt("a", 100, "100"); // seed
    expect(t.fmt("a", 150, "150")).toContain("▲");
    expect(t.fmt("a", 120, "120")).toContain("▼");
  });

  test("不変はマーカ枠のスペースのみ（▲▼なし）", () => {
    const t = new Ticker();
    t.fmt("a", 100, "100");
    const out = t.fmt("a", 100, "100");
    expect(out).toBe("100 ");
    expect(out).not.toContain("▲");
    expect(out).not.toContain("▼");
  });

  test("キーは独立に追跡する", () => {
    const t = new Ticker();
    t.fmt("a", 1, "1");
    t.fmt("b", 1, "1");
    expect(t.fmt("a", 2, "2")).toContain("▲");
    expect(t.fmt("b", 1, "1")).toBe("1 ");
  });

  test("arrow=false はスロットを足さない", () => {
    const t = new Ticker();
    t.fmt("a", 100, "100", false);
    expect(t.fmt("a", 100, "100", false)).toBe("100");
  });
});
