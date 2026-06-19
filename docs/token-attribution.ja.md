# トークン帰属の精度

[English](./token-attribution.md) | [日本語](./token-attribution.ja.md)

API の `usage` は **1 ターン（API 応答）単位**で、ツール単位の正確なトークンは取得できない。
そのため「ツール別」内訳は次のハイブリッドで、表示も区別している:

- **`=:`（実測）**: **Agent（Task ツール）/ Workflow** のサブエージェントは `…/subagents/**/agent-*.jsonl` という独立ファイルに
  自身の `usage` を持つため、その合計（`input + output + cacheCreation`）を厳密に集計する。
- **`~:`（推定）**: **直接ツール（Read / Bash / Edit など）** は、各ツール結果（`tool_result`）の文字数を
  `chars / 4` でトークン換算した **コンテキスト寄与の推定値**。`tool_use.id ↔ tool_result.tool_use_id` で
  ツール名に対応づけている。換算係数は `src/attribute.ts` の `CHARS_PER_TOKEN` に集約（差し替え可能）。

サブエージェント**内部**のツール呼び出しは Agent / Workflow 側で実測済みのため、直接ツール推定からは除外している（二重計上回避）。

一方、**セッション / プロジェクト / モデル / 時間帯** の内訳は `usage` の実測値そのものなので正確。
