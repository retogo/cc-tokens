/**
 * 共有型。Claude Code のトランスクリプト（~/.claude/projects 配下の *.jsonl）から
 * 抽出する 1 ターン（= 1 API 応答 = 1 usage）の正規化レコードと、その集計型。
 */

/** message.usage の 4 カテゴリ（生トークン）。 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/** サブエージェントの起源（ファイルパス由来）。null はメインセッション。 */
export type AgentKind = "task" | "workflow" | null;

/**
 * 正規化した 1 ターン。assistant かつ usage を持つレコードのみが対象。
 * tool_use を含まないターン（純粋なテキスト応答）でも usage は計上する。
 */
export interface TurnRecord {
  /** epoch ミリ秒（timestamp を変換）。 */
  ts: number;
  model: string;
  sessionId: string;
  /** cwd（プロジェクトの絶対パス）。欠落時は空文字。 */
  project: string;
  gitBranch: string;
  usage: TokenUsage;
  /** このターンで呼ばれた tool_use の name（重複あり）。 */
  toolsInvoked: string[];
  /** サブエージェント（isSidechain）か。 */
  isSidechain: boolean;
  /** サブエージェントの種別（メインは null）。 */
  agentKind: AgentKind;
  /** ワークフロー実行 ID（`subagents/workflows/<id>/` 由来。非workflowは null）。 */
  workflowId: string | null;
  /** エージェント ID（`agent-<hash>` 由来。メインは null）。 */
  agentId: string | null;
  requestId: string | null;
  /**
   * message.id（API レスポンス ID）。Claude Code は 1 メッセージを content block ごとに
   * 別行へ書き、全行に同じ usage を載せるため、これをキーに usage を 1 回だけ計上する。
   */
  messageId: string | null;
}

/** 5h ブロック（ローリングウィンドウの近似単位）。 */
/** バーンレート（加重 / 生トークン、いずれも /分）。 */
export interface BurnRate {
  /** 加重指標/分（既定は生トークン）。 */
  weightedPerMin: number;
  /** 生トークン/分（input+output+cacheCreation）。 */
  rawPerMin: number;
}

export interface Projection {
  /** 枯渇予測時刻（epoch ms）。limit 未設定 or burn=0 なら null。 */
  exhaustionTs: number | null;
  /** ウィンドウ終端での加重トークン着地予測。 */
  projectedWeightedAtWindowEnd: number;
}

/** 集計の 1 行（ツール/セッション/モデル/時間など共通）。 */
export interface BreakdownRow {
  key: string;
  usage: TokenUsage;
  weighted: number;
  cost: number;
  /** ターン数 or 呼び出し回数。 */
  count: number;
  /** weighted 全体に占める割合（0..1）。 */
  share: number;
}
