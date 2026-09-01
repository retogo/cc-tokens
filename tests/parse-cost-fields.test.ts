import { describe, expect, test } from "bun:test";
import { parseLine } from "../src/parse.ts";

const PATH = "/x/projects/-fixture-proj/sess-aaa.jsonl";

function line(usage: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-opus-5",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      usage,
    },
    timestamp: "2026-06-18T00:00:10.000Z",
    sessionId: "sess-aaa",
    cwd: "/fixture/proj",
  });
}

describe("parseLine: コスト計算に必要な usage 属性", () => {
  test("cache_creation の 1h 内訳を取り込む", () => {
    const r = parseLine(
      line({
        input_tokens: 2,
        output_tokens: 10,
        cache_creation_input_tokens: 21448,
        cache_read_input_tokens: 22968,
        cache_creation: { ephemeral_1h_input_tokens: 21448, ephemeral_5m_input_tokens: 0 },
      }),
      PATH,
    );
    expect(r!.usage.cacheCreation).toBe(21448);
    expect(r!.pricing.cacheCreation1h).toBe(21448);
  });

  test("cache_creation を持たない旧形式は 1h 分 0（全額 5m 単価）", () => {
    const r = parseLine(
      line({
        input_tokens: 2,
        output_tokens: 10,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 0,
      }),
      PATH,
    );
    expect(r!.usage.cacheCreation).toBe(2000);
    expect(r!.pricing.cacheCreation1h).toBe(0);
  });

  test("web search 件数・speed・inference_geo を取り込む", () => {
    const r = parseLine(
      line({
        input_tokens: 2,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 3, web_fetch_requests: 1 },
        speed: "fast",
        inference_geo: "us",
      }),
      PATH,
    );
    expect(r!.pricing.webSearchRequests).toBe(3);
    expect(r!.pricing.speed).toBe("fast");
    expect(r!.pricing.inferenceGeo).toBe("us");
  });

  test("これらの属性が無い行では 0 / null になる", () => {
    const r = parseLine(
      line({ input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 0 }),
      PATH,
    );
    expect(r!.pricing.webSearchRequests).toBe(0);
    expect(r!.pricing.speed).toBeNull();
    expect(r!.pricing.inferenceGeo).toBeNull();
  });
});
