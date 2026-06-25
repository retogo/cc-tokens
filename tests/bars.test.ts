import { describe, expect, test } from "bun:test";
import {
  bar,
  brailleChart,
  formatDuration,
  formatTokens,
  formatUSD,
  lineChart,
  lineChartBraille,
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

  test("lineChart は height 行ぶん返し、値に応じて下から積み上がる", () => {
    // height=2, 1 行あたり 8 サブステップなので 16 段階の精度。
    // 0=空, 0.5=ちょうど下行満タン, 1.0=両行満タン
    const out = lineChart([0, 0.5, 1.0], 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("  █"); // 上行: 0,0,1 は (0,8,16) subs → " "," ","█"
    expect(out[1]).toBe(" ██"); // 下行: 0,0.5,1 → " ","█","█"
  });

  test("lineChart は [0..1] にクランプし、超過もフル塗りで耐える", () => {
    const out = lineChart([1.5, -0.3], 1);
    expect(out[0]).toBe("█ ");
  });

  test("lineChart の途中の値は部分ブロック文字（▁..▇）で出る", () => {
    // height=1, value=0.125 → 1 sub → "▁"
    const out = lineChart([0.125, 0.875], 1);
    expect(out[0]).toBe("▁▇");
  });

  test("lineChartBraille は width × height 文字の grid を返す", () => {
    const out = lineChartBraille([0, 0.5, 1], 4, 2);
    expect(out).toHaveLength(2);
    for (const line of out) {
      // braille / space は 1 文字幅。長さがちゃんと width
      expect([...line]).toHaveLength(4);
    }
  });

  test("lineChartBraille 直線右上がりは下端から上端へ向かう経路に dot が並ぶ", () => {
    // 0 → 1 の直線。subW=4, subH=8。左下 (0, subH-1) から右上 (3, 0) へ。
    const out = lineChartBraille([0, 1], 2, 2);
    // 全文字が braille か空白で、空白ばかりではない（線が引かれている）
    const joined = out.join("");
    expect(joined.length).toBeGreaterThan(0);
    const hasBraille = [...joined].some((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x2800 && code <= 0x28ff;
    });
    expect(hasBraille).toBe(true);
  });

  test("lineChartBraille 全ゼロは下端に水平な baseline が引かれる（線は描画される）", () => {
    const out = lineChartBraille([0, 0, 0, 0], 3, 2);
    // 上半分は空、下半分（最下行）には水平線（dots 7+8 = 0xC0 = "⣀"）が並ぶ
    expect(out[0]).toBe("   ");
    expect(out[1]).toBe("⣀⣀⣀");
  });

  test("lineChartBraille 空配列は空白だけを返す", () => {
    const out = lineChartBraille([], 3, 2);
    expect(out).toEqual(["   ", "   "]);
  });

  test("brailleChart thick=true は線が太くなり、点灯ドット数が thin より増える", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    const thin = brailleChart([{ points, thick: false }], 6, 3).join("");
    const thick = brailleChart([{ points, thick: true }], 6, 3).join("");
    // braille char の点灯ドット数を popcount で数える（thick は ±1 方向に太らせる）
    const countDots = (s: string): number => {
      let n = 0;
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (code >= 0x2800 && code <= 0x28ff) {
          let b = code - 0x2800;
          while (b) {
            n += b & 1;
            b >>>= 1;
          }
        }
      }
      return n;
    };
    expect(countDots(thick)).toBeGreaterThan(countDots(thin));
  });

  test("brailleChart 過去 series が先頭にあると overlap セルで装飾を勝ち取る", () => {
    let pastCalls = 0;
    let predCalls = 0;
    const past = (s: string): string => {
      pastCalls++;
      return s; // 装飾はせず、呼び出しカウントのみで識別
    };
    const pred = (s: string): string => {
      predCalls++;
      return s;
    };
    // 同じ直線（0,0）→（1,1）を 2 系列にぶつける → すべてのセルが overlap
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    brailleChart(
      [
        { points, decorate: past },
        { points, decorate: pred },
      ],
      4,
      2,
    );
    // 先頭 series（past）の装飾だけが呼ばれ、predict は overlap セルでは呼ばれない
    expect(pastCalls).toBeGreaterThan(0);
    expect(predCalls).toBe(0);
  });

  test("brailleChart 空 series 配列はすべて空白", () => {
    const out = brailleChart([], 3, 2);
    expect(out).toEqual(["   ", "   "]);
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
