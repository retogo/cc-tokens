import { stat } from "node:fs/promises";
import type { SubagentToolEvent, ToolEvent } from "./attribute.ts";
import { agentKindFromPath, parseLineFull, subagentIdsFromPath } from "./parse.ts";
import type { TurnRecord } from "./types.ts";

export interface ScanResult {
  /** 全ファイルの assistant+usage レコード（サブエージェント含む。5h 集計用）。 */
  records: TurnRecord[];
  /** メインセッションファイル由来のツール I/O のみ（直接ツール帰属用）。 */
  toolEvents: ToolEvent[];
  /** サブエージェントファイル由来のツール I/O。agent 単位のツール推定に使う。 */
  subagentToolEvents: SubagentToolEvent[];
  /** sessionId → 表示名（custom-title 優先、無ければ ai-title）。 */
  sessionTitles: Map<string, string>;
}

const GLOB = new Bun.Glob("**/*.jsonl");

/** projects ルート配下の *.jsonl を絶対パスで列挙する。 */
export async function globTranscripts(root: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const p of GLOB.scan({ cwd: root, absolute: true })) {
      out.push(p);
    }
  } catch {
    // ルート不在などは空配列
  }
  return out;
}

/**
 * トランスクリプトの増分読み取り器。
 * seed() で全（または時間窓内）走査しオフセットを末尾に進め、poll() で追記分のみ読む。
 * 改行で終わらない途中行は確定するまで消費しない（二重計上を避ける）。
 */
export class Scanner {
  private offsets = new Map<string, number>();
  // sessionId → {custom?, ai?}。表示時は custom > ai で解決する（途中で custom が来たら昇格）。
  private titles = new Map<string, { custom?: string; ai?: string }>();
  // 計上済みメッセージ（message.id、無ければ requestId）。Claude Code は 1 メッセージを
  // content block ごとに別行へ書き全行に同じ usage を載せるため、これで usage の多重計上を防ぐ。
  // resume / 再出力でファイルを跨いだ複製も同じ id で弾く。poll を跨いで効かせる必要があるので
  // インスタンスに保持する（5h あたり数百件程度で増分は無視できる）。
  private seenMessages = new Set<string>();

  constructor(private readonly root: string) {}

  /**
   * 全ファイルを走査する。sinceMs を渡すと mtime がそれ以降のファイルのみ対象。
   * 読んだ各ファイルのオフセットは末尾（最終改行位置）まで進む。
   */
  async seed(sinceMs?: number): Promise<ScanResult> {
    const files = await globTranscripts(this.root);
    const acc = empty();
    for (const f of files) {
      if (sinceMs !== undefined) {
        try {
          const st = await stat(f);
          if (st.mtimeMs < sinceMs) {
            this.offsets.set(f, st.size);
            continue;
          }
        } catch {
          continue;
        }
      }
      await this.read(f, acc);
    }
    return acc;
  }

  /** 既知ファイルの追記分＋新規ファイルを読む。 */
  async poll(): Promise<ScanResult> {
    const files = await globTranscripts(this.root);
    const acc = empty();
    for (const f of files) {
      await this.read(f, acc);
    }
    return acc;
  }

  private async read(path: string, acc: ScanResult): Promise<void> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return;
    }
    let offset = this.offsets.get(path) ?? 0;
    if (size < offset) offset = 0; // 切り詰め/ローテーション
    if (size <= offset) {
      this.offsets.set(path, size);
      return;
    }

    const text = await Bun.file(path).slice(offset, size).text();
    const nl = text.lastIndexOf("\n");
    if (nl < 0) {
      // 確定行なし（途中行のみ）。オフセットは進めない。
      return;
    }
    const consumed = text.slice(0, nl + 1);
    this.offsets.set(path, offset + Buffer.byteLength(consumed, "utf8"));

    const agentKind = agentKindFromPath(path);
    const isSub = agentKind !== null;
    // サブエージェント側はファイル単位で agentId / workflowId が決まる。
    const subIds = isSub ? subagentIdsFromPath(path) : null;
    for (const line of consumed.split("\n")) {
      if (!line) continue;
      const parsed = parseLineFull(line, path);
      if (parsed.record) {
        // usage は message 単位で 1 回だけ。tool I/O（下の toolEvents 収集）は行ごとに別ブロックなので
        // dedup せず全行から拾う。id が取れない行のみフォールバックで毎回計上する。
        const key = parsed.record.messageId ?? parsed.record.requestId;
        if (key === null) {
          acc.records.push(parsed.record);
        } else if (!this.seenMessages.has(key)) {
          this.seenMessages.add(key);
          acc.records.push(parsed.record);
        }
      }
      // 直接ツール帰属はメインセッションのみ（サブは records 側で実測）。
      // サブエージェント由来は agent 単位のツール推定用に subagentToolEvents へ分けて保持。
      // record 側が lineTs !== null を必須としているのに合わせ、timestamp 不在行は除外する
      // （since ウィンドウ間で非対称に混入するのを防ぐ）。
      const hasToolIO = parsed.toolUses.length > 0 || parsed.toolResults.length > 0;
      if (parsed.lineTs !== null && hasToolIO) {
        if (!isSub) {
          acc.toolEvents.push({
            uses: parsed.toolUses,
            results: parsed.toolResults,
            ts: parsed.lineTs,
          });
        } else if (agentKind && subIds?.agentId) {
          acc.subagentToolEvents.push({
            uses: parsed.toolUses,
            results: parsed.toolResults,
            ts: parsed.lineTs,
            agentKind,
            agentId: subIds.agentId,
            workflowId: subIds.workflowId,
          });
        }
      }
      if (parsed.title) {
        const cur = this.titles.get(parsed.title.sessionId) ?? {};
        if (parsed.title.kind === "custom") cur.custom = parsed.title.title;
        else cur.ai = parsed.title.title;
        this.titles.set(parsed.title.sessionId, cur);
      }
    }
    // Scanner 内部の最新解決済みマップで毎回上書き（呼び出し側は ScanResult の Map をそのまま使える）。
    acc.sessionTitles = this.snapshotTitles();
  }

  private snapshotTitles(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [sid, t] of this.titles) {
      const v = t.custom ?? t.ai;
      if (v) out.set(sid, v);
    }
    return out;
  }
}

function empty(): ScanResult {
  return { records: [], toolEvents: [], subagentToolEvents: [], sessionTitles: new Map() };
}
