import { describe, expect, test } from "bun:test";
import { parsePositiveFloat, parsePositiveInt, parseSince } from "../src/cli.ts";

/** stderr.write を一時的に差し替えて警告文字列を捕捉する。 */
function captureStderr(fn: () => void): string {
  const orig = process.stderr.write.bind(process.stderr);
  let warn = "";
  const stub = (s: string | Uint8Array) => {
    warn += typeof s === "string" ? s : Buffer.from(s).toString("utf8");
    return true;
  };
  (process.stderr as { write: typeof stub }).write = stub;
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return warn;
}

describe("parseSince（--since の値検証）", () => {
  test("undefined は block にフォールバック", () => {
    expect(parseSince(undefined)).toBe("block");
  });

  test("既知値はそのまま採用", () => {
    expect(parseSince("today")).toBe("today");
    expect(parseSince("24h")).toBe("24h");
    expect(parseSince("7d")).toBe("7d");
    expect(parseSince("30d")).toBe("30d");
    expect(parseSince("all")).toBe("all");
    expect(parseSince("block")).toBe("block");
  });

  test("未知値は警告を出して block に戻す（無音で全期間集計しない）", () => {
    let result: string = "";
    const warn = captureStderr(() => {
      result = parseSince("lastweek");
    });
    expect(result).toBe("block");
    expect(warn).toContain("Invalid --since");
    expect(warn).toContain("lastweek");
  });
});

describe("parsePositiveInt（parseInt の寛容パースを禁止）", () => {
  test("undefined は undefined（呼び出し側で既定にフォールバック）", () => {
    expect(parsePositiveInt(undefined, "top")).toBeUndefined();
  });

  test("純粋な正整数を採用", () => {
    expect(parsePositiveInt("5", "top")).toBe(5);
    expect(parsePositiveInt("12", "top")).toBe(12);
  });

  test("末尾ゴミ付き ('5abc') は警告して undefined", () => {
    let result: number | undefined = 999;
    const warn = captureStderr(() => {
      result = parsePositiveInt("5abc", "top");
    });
    expect(result).toBeUndefined();
    expect(warn).toContain("Invalid --top");
  });

  test("小数 ('5.9') は警告して undefined（int 期待）", () => {
    let result: number | undefined = 999;
    const warn = captureStderr(() => {
      result = parsePositiveInt("5.9", "top");
    });
    expect(result).toBeUndefined();
    expect(warn).toContain("Invalid --top");
  });

  test("0 / 負数は警告して undefined", () => {
    captureStderr(() => {
      expect(parsePositiveInt("0", "top")).toBeUndefined();
      expect(parsePositiveInt("-3", "top")).toBeUndefined();
    });
  });
});

describe("parsePositiveFloat（parseFloat の寛容パースを禁止）", () => {
  test("正の小数・整数を採用", () => {
    expect(parsePositiveFloat("0.5", "interval")).toBe(0.5);
    expect(parsePositiveFloat("3", "interval")).toBe(3);
    expect(parsePositiveFloat(".25", "interval")).toBe(0.25);
  });

  test("末尾ゴミ ('5.0abc') は警告して undefined", () => {
    let result: number | undefined = 999;
    const warn = captureStderr(() => {
      result = parsePositiveFloat("5.0abc", "interval");
    });
    expect(result).toBeUndefined();
    expect(warn).toContain("Invalid --interval");
  });

  test("0 / 負数は警告して undefined", () => {
    captureStderr(() => {
      expect(parsePositiveFloat("0", "interval")).toBeUndefined();
      expect(parsePositiveFloat("-1.5", "interval")).toBeUndefined();
    });
  });
});
