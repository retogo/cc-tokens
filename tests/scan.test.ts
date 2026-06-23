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

  test("subagent ファイルの tool_use は toolEvents に含めず subagentToolEvents へ振り分ける", async () => {
    const sc = new Scanner(join(root, "projects"));
    const subDir = join(proj, "s", "subagents", "workflows", "wf-sub-1");
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
    const resultLine = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "g1", content: "01234567" }],
      },
      timestamp: "2026-06-18T00:04:01.000Z",
      sessionId: "s",
      isSidechain: true,
    });
    writeFileSync(join(subDir, "agent-x.jsonl"), `${subLine}\n${resultLine}\n`);
    const r = await sc.seed();
    // record は含む（sidechain として 5h に効く）
    expect(r.records.some((x) => x.agentKind === "workflow")).toBe(true);
    // メインの toolEvents には Grep を含めない
    expect(r.toolEvents.some((e) => e.uses.some((u) => u.name === "Grep"))).toBe(false);
    // 代わりに subagentToolEvents に agentId / workflowId 付きで入る
    const subEvs = r.subagentToolEvents.filter(
      (e) =>
        e.uses.some((u) => u.name === "Grep") || e.results.some((res) => res.toolUseId === "g1"),
    );
    expect(subEvs.length).toBeGreaterThan(0);
    expect(subEvs.every((e) => e.agentKind === "workflow")).toBe(true);
    expect(subEvs.every((e) => e.agentId === "agent-x")).toBe(true);
    expect(subEvs.every((e) => e.workflowId === "wf-sub-1")).toBe(true);
  });
});

// Claude Code は 1 メッセージを content block ごとに別行へ書き、全行に同じ usage を載せる。
// message.id をキーに usage を 1 回だけ計上する（tool_use は別ブロックなので全行収集する）。
function blockLine(opts: {
  ts: string;
  out: number;
  msgId: string;
  block: { type: "thinking" } | { type: "text" } | { type: "tool_use"; name: string; id: string };
  sub?: boolean;
}): string {
  const c =
    opts.block.type === "tool_use"
      ? { type: "tool_use", name: opts.block.name, id: opts.block.id }
      : { type: opts.block.type, text: "x" };
  return JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-opus-4-8",
      id: opts.msgId,
      content: [c],
      usage: {
        input_tokens: 100,
        output_tokens: opts.out,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    timestamp: opts.ts,
    sessionId: "s",
    cwd: "/p",
    isSidechain: opts.sub === true,
  });
}

describe("message.id による usage の重複排除（content block 分割行の多重計上を防ぐ）", () => {
  test("同一 message.id の複数行は usage を 1 回だけ計上し、tool_use は全行から収集する", async () => {
    const sc = new Scanner(join(root, "projects"));
    const proj = join(root, "projects", "-dedup");
    mkdirSync(proj, { recursive: true });
    const f = join(proj, "s.jsonl");
    const ts = "2026-06-18T01:00:00.000Z";
    // 1 メッセージ = thinking + tool_use(Read) + tool_use(Bash) の 3 行。全行 usage 同一。
    writeFileSync(
      f,
      `${blockLine({ ts, out: 777, msgId: "msg_dd", block: { type: "thinking" } })}\n` +
        `${blockLine({ ts, out: 777, msgId: "msg_dd", block: { type: "tool_use", name: "Read", id: "r1" } })}\n` +
        `${blockLine({ ts, out: 777, msgId: "msg_dd", block: { type: "tool_use", name: "Bash", id: "b1" } })}\n`,
    );
    const r = await sc.seed();
    // usage は 1 メッセージ分のみ（3 重計上しない）
    const mine = r.records.filter((x) => x.usage.output === 777);
    expect(mine).toHaveLength(1);
    // tool_use は両方とも toolEvents に残る
    const toolNames = r.toolEvents.flatMap((e) => e.uses.map((u) => u.name));
    expect(toolNames).toContain("Read");
    expect(toolNames).toContain("Bash");
  });

  test("dedup は poll を跨いで効く（後続 poll で同 message.id が追記されても二重計上しない）", async () => {
    const sc = new Scanner(join(root, "projects"));
    const proj = join(root, "projects", "-dedup-poll");
    mkdirSync(proj, { recursive: true });
    const f = join(proj, "s.jsonl");
    const ts = "2026-06-18T02:00:00.000Z";
    writeFileSync(
      f,
      `${blockLine({ ts, out: 888, msgId: "msg_pp", block: { type: "thinking" } })}\n`,
    );
    const r1 = await sc.seed();
    expect(r1.records.filter((x) => x.usage.output === 888)).toHaveLength(1);
    // 同じメッセージの後続 content block が後から追記される
    appendFileSync(
      f,
      `${blockLine({ ts, out: 888, msgId: "msg_pp", block: { type: "tool_use", name: "Grep", id: "g1" } })}\n`,
    );
    const r2 = await sc.poll();
    // usage は計上しない（既出 message.id）
    expect(r2.records.filter((x) => x.usage.output === 888)).toHaveLength(0);
    // tool_use は拾う
    expect(r2.toolEvents.flatMap((e) => e.uses.map((u) => u.name))).toContain("Grep");
  });

  test("message.id が無い行は dedup しない（usage 同一でも別レコード扱い・既存挙動）", async () => {
    const sc = new Scanner(join(root, "projects"));
    const proj = join(root, "projects", "-dedup-noid");
    mkdirSync(proj, { recursive: true });
    const f = join(proj, "s.jsonl");
    // assistant() ヘルパは message.id を持たない
    writeFileSync(
      f,
      `${assistant("2026-06-18T03:00:00.000Z", 555, "Read")}\n` +
        `${assistant("2026-06-18T03:00:01.000Z", 555, "Bash")}\n`,
    );
    const r = await sc.seed();
    expect(r.records.filter((x) => x.usage.output === 555)).toHaveLength(2);
  });

  test("サブエージェントの実測 usage も message.id 単位で 1 回だけ計上する", async () => {
    const sc = new Scanner(join(root, "projects"));
    const subDir = join(root, "projects", "-dedup-sub", "s", "subagents", "workflows", "wf-dd");
    mkdirSync(subDir, { recursive: true });
    const ts = "2026-06-18T04:00:00.000Z";
    writeFileSync(
      join(subDir, "agent-z.jsonl"),
      `${blockLine({ ts, out: 333, msgId: "msg_sub", block: { type: "text" }, sub: true })}\n` +
        `${blockLine({ ts, out: 333, msgId: "msg_sub", block: { type: "tool_use", name: "Read", id: "s1" }, sub: true })}\n`,
    );
    const r = await sc.seed();
    expect(
      r.records.filter((x) => x.agentKind === "workflow" && x.usage.output === 333),
    ).toHaveLength(1);
  });
});
