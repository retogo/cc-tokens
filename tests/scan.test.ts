import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scanner } from "../src/scan.ts";

const root = mkdtempSync(join(tmpdir(), "cctok-scan-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function assistant(ts: string, out: number, tool?: string, id = "u1"): string {
  const content: any[] = [];
  if (tool) content.push({ type: "tool_use", name: tool, id });
  content.push({ type: "text", text: "x" });
  return JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-opus-4-8",
      content,
      usage: {
        input_tokens: 100,
        output_tokens: out,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    timestamp: ts,
    sessionId: "s",
    cwd: "/p",
    gitBranch: "main",
    isSidechain: false,
  });
}

describe("Scanner seed + poll (テスト12)", () => {
  const proj = join(root, "projects", "-p");
  mkdirSync(proj, { recursive: true });
  const file = join(proj, "s.jsonl");
  writeFileSync(file, `${assistant("2026-06-18T00:00:00.000Z", 10, "Read")}\n`);

  test("seed は既存行を読み、records と toolEvents を返す", async () => {
    const sc = new Scanner(join(root, "projects"));
    const r = await sc.seed();
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.usage.output).toBe(10);
    expect(r.toolEvents.some((e) => e.uses.some((u) => u.name === "Read"))).toBe(true);
  });

  test("poll は追記分のみを返し、二重計上しない", async () => {
    const sc = new Scanner(join(root, "projects"));
    await sc.seed();
    // seed 後の追記
    appendFileSync(file, `${assistant("2026-06-18T00:01:00.000Z", 20, "Bash")}\n`);
    const r1 = await sc.poll();
    expect(r1.records).toHaveLength(1);
    expect(r1.records[0]!.usage.output).toBe(20);
    // 変更なしの poll は空
    const r2 = await sc.poll();
    expect(r2.records).toHaveLength(0);
  });

  test("改行が無い途中行は確定するまで消費しない", async () => {
    const sc = new Scanner(join(root, "projects"));
    await sc.seed();
    const partialFile = join(proj, "partial.jsonl");
    writeFileSync(partialFile, assistant("2026-06-18T00:02:00.000Z", 30, "Edit"));
    // 改行なし → まだ未確定
    const r1 = await sc.poll();
    expect(r1.records.filter((x) => x.usage.output === 30)).toHaveLength(0);
    // 改行を付与 → 1回だけ確定
    appendFileSync(partialFile, "\n");
    const r2 = await sc.poll();
    expect(r2.records.filter((x) => x.usage.output === 30)).toHaveLength(1);
    const r3 = await sc.poll();
    expect(r3.records.filter((x) => x.usage.output === 30)).toHaveLength(0);
  });

  test("新規ファイルは poll で検出する", async () => {
    const sc = new Scanner(join(root, "projects"));
    await sc.seed();
    const proj2 = join(root, "projects", "-p2");
    mkdirSync(proj2, { recursive: true });
    writeFileSync(join(proj2, "new.jsonl"), `${assistant("2026-06-18T00:03:00.000Z", 40)}\n`);
    const r = await sc.poll();
    expect(r.records.some((x) => x.usage.output === 40)).toBe(true);
  });

  test("ai-title / custom-title を sessionTitles に集約し、custom > ai を優先", async () => {
    const sc = new Scanner(join(root, "projects"));
    const titleProj = join(root, "projects", "-titles");
    mkdirSync(titleProj, { recursive: true });
    const f1 = join(titleProj, "s1.jsonl");
    writeFileSync(
      f1,
      JSON.stringify({ type: "ai-title", aiTitle: "auto name", sessionId: "s1" }) +
        "\n" +
        JSON.stringify({ type: "custom-title", customTitle: "user name", sessionId: "s1" }) +
        "\n",
    );
    const f2 = join(titleProj, "s2.jsonl");
    writeFileSync(
      f2,
      `${JSON.stringify({ type: "ai-title", aiTitle: "only ai", sessionId: "s2" })}\n`,
    );
    const r = await sc.seed();
    expect(r.sessionTitles.get("s1")).toBe("user name");
    expect(r.sessionTitles.get("s2")).toBe("only ai");
  });

  test("ai-title 受信後に custom-title が追記されたら custom が勝つ（poll でも上書き）", async () => {
    const sc = new Scanner(join(root, "projects"));
    const proj3 = join(root, "projects", "-titles2");
    mkdirSync(proj3, { recursive: true });
    const f = join(proj3, "s.jsonl");
    writeFileSync(f, `${JSON.stringify({ type: "ai-title", aiTitle: "auto", sessionId: "z" })}\n`);
    const r1 = await sc.seed();
    expect(r1.sessionTitles.get("z")).toBe("auto");
    appendFileSync(
      f,
      `${JSON.stringify({ type: "custom-title", customTitle: "manual", sessionId: "z" })}\n`,
    );
    const r2 = await sc.poll();
    expect(r2.sessionTitles.get("z")).toBe("manual");
  });

  test("custom が先に来たら、その後の ai-title は無視（custom 優先）", async () => {
    const sc = new Scanner(join(root, "projects"));
    const proj4 = join(root, "projects", "-titles3");
    mkdirSync(proj4, { recursive: true });
    const f = join(proj4, "s.jsonl");
    writeFileSync(
      f,
      JSON.stringify({ type: "custom-title", customTitle: "manual", sessionId: "k" }) +
        "\n" +
        JSON.stringify({ type: "ai-title", aiTitle: "auto", sessionId: "k" }) +
        "\n",
    );
    const r = await sc.seed();
    expect(r.sessionTitles.get("k")).toBe("manual");
  });

  test("timestamp 不在の行は toolEvents に含めない（record 側との対称化）", async () => {
    const sc = new Scanner(join(root, "projects"));
    const proj5 = join(root, "projects", "-ts-null");
    mkdirSync(proj5, { recursive: true });
    const f = join(proj5, "s.jsonl");
    // timestamp フィールドを欠落させた assistant 行（usage 無し）に tool_use のみ持たせる
    const line = JSON.stringify({
      type: "assistant",
      message: { model: "m", content: [{ type: "tool_use", name: "GhostTool", id: "g1" }] },
      sessionId: "s",
    });
    writeFileSync(f, `${line}\n`);
    const r = await sc.seed();
    expect(r.toolEvents.some((e) => e.uses.some((u) => u.name === "GhostTool"))).toBe(false);
  });

  test("subagent ファイルの tool_use は toolEvents に含めない（二重計上回避）", async () => {
    const sc = new Scanner(join(root, "projects"));
    const subDir = join(proj, "s", "subagents", "workflows", "wf");
    mkdirSync(subDir, { recursive: true });
    const subLine = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        content: [{ type: "tool_use", name: "Grep", id: "g1" }],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      timestamp: "2026-06-18T00:04:00.000Z",
      sessionId: "s",
      isSidechain: true,
    });
    writeFileSync(join(subDir, "agent-x.jsonl"), `${subLine}\n`);
    const r = await sc.seed();
    // record は含む（sidechain として 5h に効く）
    expect(r.records.some((x) => x.agentKind === "workflow")).toBe(true);
    // が、toolEvents には Grep を含めない
    expect(r.toolEvents.some((e) => e.uses.some((u) => u.name === "Grep"))).toBe(false);
  });
});
