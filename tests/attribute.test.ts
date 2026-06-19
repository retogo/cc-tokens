import { describe, expect, test } from "bun:test";
import { buildSubagentDrill, buildToolBreakdown, estTokens } from "../src/attribute.ts";
import type { ToolResultRef, ToolUseRef } from "../src/parse.ts";
import type { TokenUsage, TurnRecord } from "../src/types.ts";

function ev(uses: ToolUseRef[], results: ToolResultRef[] = []) {
  return { uses, results, ts: 0 };
}

function subRec(
  usage: TokenUsage,
  agentKind: "task" | "workflow",
  workflowId: string | null = null,
  agentId: string | null = null,
): TurnRecord {
  return {
    ts: 0,
    model: "claude-opus-4-8",
    sessionId: "s",
    project: "/p",
    gitBranch: "main",
    usage,
    toolsInvoked: [],
    isSidechain: true,
    agentKind,
    workflowId,
    agentId,
    requestId: null,
  };
}

describe("buildSubagentDrill（Workflow→実行→agent ドリルダウン）", () => {
  const u = (n: number): TokenUsage => ({
    input: n,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
  });
  const subs = [
    subRec(u(100), "workflow", "wf_a", "agent-1"),
    subRec(u(50), "workflow", "wf_a", "agent-2"),
    subRec(u(30), "workflow", "wf_b", "agent-3"),
    subRec(u(200), "task", null, "agent-9"),
  ];

  test("Workflow と Agent のトップノード（tokens 降順）", () => {
    const tree = buildSubagentDrill(subs);
    const wf = tree.find((n) => n.key === "Workflow")!;
    const agent = tree.find((n) => n.key === "Agent")!;
    expect(wf.tokens).toBe(180); // 100+50+30
    expect(wf.turns).toBe(3);
    expect(agent.tokens).toBe(200);
  });

  test("Workflow を wf 実行→agent でドリルダウン", () => {
    const wf = buildSubagentDrill(subs).find((n) => n.key === "Workflow")!;
    const wfA = wf.children.find((r) => r.key === "wf_a")!;
    expect(wfA.tokens).toBe(150); // 100+50
    expect(wfA.children.map((a) => a.key).sort()).toEqual(["agent-1", "agent-2"]);
    expect(wfA.children.find((a) => a.key === "agent-1")!.tokens).toBe(100);
  });

  test("サブエージェントが無ければ空配列", () => {
    expect(buildSubagentDrill([])).toEqual([]);
  });
});

describe("estTokens (chars/4)", () => {
  test("文字数を 4 で割って丸める", () => {
    expect(estTokens(40)).toBe(10);
    expect(estTokens(7)).toBe(2);
  });
});

describe("直接ツールの推定帰属 (テスト9)", () => {
  test("tool_use.id↔tool_result でツール名別に推定トークンを積む", () => {
    // 2ターン分: Read(id u1) → 結果40字, Bash(id u2) → 結果80字, Read 再呼出し(id u3) → 結果40字
    const events = [
      ev([{ id: "u1", name: "Read" }]),
      ev([], [{ toolUseId: "u1", chars: 40 }]),
      ev([
        { id: "u2", name: "Bash" },
        { id: "u3", name: "Read" },
      ]),
      ev(
        [],
        [
          { toolUseId: "u2", chars: 80 },
          { toolUseId: "u3", chars: 40 },
        ],
      ),
    ];
    const rows = buildToolBreakdown(events, []);
    const read = rows.find((r) => r.tool === "Read")!;
    const bash = rows.find((r) => r.tool === "Bash")!;
    expect(read.tokens).toBe(estTokens(80)); // 40+40
    expect(read.calls).toBe(2);
    expect(read.estimated).toBe(true);
    expect(bash.tokens).toBe(estTokens(80));
    expect(bash.calls).toBe(1);
  });

  test("Task/Agent の直接結果は二重計上を避けるため除外", () => {
    const events = [ev([{ id: "t1", name: "Task" }]), ev([], [{ toolUseId: "t1", chars: 4000 }])];
    const rows = buildToolBreakdown(events, []);
    expect(rows.find((r) => r.tool === "Task")).toBeUndefined();
  });
});

describe("サブエージェントの正確帰属 (テスト8)", () => {
  test("subagent レコードの実消費トークンを Task/Workflow に集計", () => {
    const subs = [
      subRec({ input: 300, output: 20, cacheCreation: 3000, cacheRead: 0 }, "workflow"),
      subRec({ input: 350, output: 400, cacheCreation: 100, cacheRead: 9999 }, "workflow"),
    ];
    const rows = buildToolBreakdown([], subs);
    const wf = rows.find((r) => r.tool === "Workflow")!;
    // 実消費 = input+output+cacheCreation（cacheRead 除外）
    expect(wf.tokens).toBe(300 + 20 + 3000 + (350 + 400 + 100));
    expect(wf.estimated).toBe(false);
    expect(wf.calls).toBe(2);
  });

  test("share は tokens 降順で合計 1", () => {
    const events = [ev([{ id: "u1", name: "Read" }]), ev([], [{ toolUseId: "u1", chars: 400 }])];
    const subs = [subRec({ input: 100, output: 0, cacheCreation: 0, cacheRead: 0 }, "task")];
    const rows = buildToolBreakdown(events, subs);
    expect(rows[0]!.tokens).toBeGreaterThanOrEqual(rows[rows.length - 1]!.tokens);
    const total = rows.reduce((s, r) => s + r.share, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});
