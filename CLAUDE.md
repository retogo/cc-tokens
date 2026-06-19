# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

`cctok`（`claude-token-monitor`）は、Claude Code の **5h ローリングウィンドウ消費**をローカルで監視する Bun 製 TypeScript CLI。`~/.claude/projects/**/*.jsonl` のトランスクリプトを解析してバーンレート・枯渇予測・内訳（ツール / セッション / プロジェクト / モデル / 時間帯 / Workflow→agent ドリルダウン）を出す。API は `GET https://api.anthropic.com/api/oauth/usage`（OAuth Bearer）のみで、% と真のリセット時刻 / limit 逆算に使う。

## 開発コマンド

ランタイムは Bun（1.3 系で確認）。Node では動かさない。

```sh
bun install
bun test                              # 全テスト（単体 + 統合）
bun test tests/parse.test.ts          # 単一テストファイル
bun test --test-name-pattern "..."    # テスト名フィルタ
bun run typecheck                     # tsc --noEmit（厳格設定）
bun run src/cli.ts <subcommand>       # CLI を直接実行
```

CLI のサブコマンド: `watch`（既定）/ `report` / `usage`。詳細は `README.md` と `src/cli.ts` の `HELP` を参照。

## アーキテクチャの要点

レイヤは厳密に分離されている。**`render/` 以外の `src/` は webapp 化に向けて再利用する解析コア**として保つ設計。

```
parse.ts ─┐
scan.ts   ├─→ aggregate.ts / attribute.ts / blocks.ts ─→ snapshot.ts ─→ render/{bars,report,watch}.ts ─→ cli.ts
official.ts ┘                                                   ↑
pricing.ts ────────────────────────────────────────────────────┘
```

- **`parse.ts`**: JSONL 1 行を `TurnRecord` に正規化。assistant かつ `usage` を持つ行のみ計上。ファイルパスから `agentKind`（`task` / `workflow` / `null`）と `workflowId` / `agentId` を導出（`subagents/workflows/<id>/agent-<hash>.jsonl` 等のパス規約に依存）。
- **`scan.ts`**: `Scanner` クラスがバイトオフセットを記憶した**増分 tail**。`seed()` で初回走査（`sinceMs` で時間窓フィルタ）、`poll()` で追記分のみ。**改行で終わらない途中行は確定するまで消費しない**（二重計上回避）。サイズが縮んだら切り詰めとみなし先頭から再読込。
- **`attribute.ts`**: ツール別帰属の中核。**ハイブリッド集計**で、`=`（実測）= Agent(Task ツール)/Workflow のサブエージェント `agent-*.jsonl` の `usage` 合計、`~`（推定）= 直接ツール（Read/Bash/Edit など）の `tool_result` 文字数 ÷ `CHARS_PER_TOKEN`（既定 4）。**サブエージェント内部のツール呼び出しは推定から除外**して二重計上を避ける。換算係数の差し替え口は `CHARS_PER_TOKEN` に集約。表示ラベルは `Task` ツールを `Agent` と表記する。
- **`blocks.ts`**: 5h ウィンドウのバーンレート / 枯渇予測。ウィンドウ範囲は `[reset - 5h, now]`、`reset` は API の `resets_at`（取得時のみ）。**取得できない時は直近 5h を使い、リセット時刻はローカル近似しない**（README の制限通り）。
- **`official.ts`**: `/api/oauth/usage` 取得。OAuth トークンは **macOS Keychain（`Claude Code-credentials`）優先、無ければ `~/.claude/.credentials.json`**。**自動リフレッシュはしない**（refresh token ローテーション / Keychain 書き戻しで本体ログインを壊すリスクを避けるため）。401 時はユーザーに `claude` を一度起動するよう案内する。
- **`snapshot.ts`**: 上記を束ねた集計結果。**API 値が取れた時のみ % と reset を確定**、limit はトークン消費から逆算。
- **`render/`**: 表示専用。`bars.ts` の `Ticker` が**フレーム間差分による株価風の ▲▼ 着色**を担当（watch のみ）。

### トークン帰属の前提

- ターン単位の `usage` は正確、ツール単位は不正確、という非対称が前提。`=` と `~` を画面表示でも区別する。
- **セッション / プロジェクト / モデル / 時間帯の集計は `usage` 実測なので正確**。
- ツール内訳の `--expand`（watch は `Ctrl-O`）で展開する Workflow→実行→agent / Agent→agent ドリルダウンは `workflowId` / `agentId` で集計した実測値。

### 5h ウィンドウの定義

- API が取れる時: `[resets_at - 5h, now]`、% / reset 時刻も表示。
- 取れない時: `[now - 5h, now]`、% / reset 時刻は**表示しない**（ローカル近似で埋めない）。

## コード規約

- **TypeScript 厳格設定**（`tsconfig.json`）: `strict` / `noUncheckedIndexedAccess` / `noImplicitOverride` / `verbatimModuleSyntax`。配列・Map から取り出した値は `undefined` を含むのでガードが必要。
- **拡張子付き import**: `allowImportingTsExtensions` 有効、相対 import は **`.ts` を必ず付ける**（`./parse.ts` のように）。
- **型のみの import は `import type`**: `verbatimModuleSyntax` のため型と値の import を混ぜない。
- **ファイル I/O は Bun API**: `Bun.file(path)` / `Bun.Glob` を優先（`fs` を使うのは `stat` など Bun に直接対応がない箇所のみ）。
- **コメントは日本語、UI 文字列（CLI 出力 / HELP / エラーメッセージ）は英語**（公開リポジトリのため）。日本語が残ってよいのはコード内コメントと docstring のみ。
- **コア層は `render/` に依存しない**: webapp 化で差し替える前提。逆方向の依存だけ許す。

## コミット

- **コミットメッセージは英語で書く**（要約・本文とも）。公開リポジトリのため。

## テスト方針

- `bun test` を使う（Jest/Vitest ではない）。`describe` / `test` / `expect` は `bun:test` から import。
- フィクスチャは `fixtures/projects/-fixture-proj/` 配下の `*.jsonl` と `fixtures/official-usage.json`。新しい解析パターンを足す時は同じ場所にサンプルを追加する。
- ツール帰属（`attribute.ts`）の挙動は `tests/attribute.test.ts` が網羅しているので、`CHARS_PER_TOKEN` や除外ルールを変える時は必ずここを通す。

## 触る時の注意

- **OAuth トークン関連を弄らない**: 自動リフレッシュ実装は意図的に避けている（README「制限・今後」参照）。トークン取得失敗時のフォールバックは「画面に理由を出して % を非表示」が正解。
- **`render/` を変更しても解析コアの API を壊さない**: webapp 化に向けてコア層は安定させる。逆に解析コアを変える時は `render/` も同時に追従させる。
- **`scan.ts` の途中行扱いとオフセット管理は壊さない**: `claude` 実行中に tail しているので、改行待ちの扱いを誤ると同じターンを 2 重カウントする。
- **`--official` が無くても動く**: API 不在時は使用量・バーン・内訳のみで完結する必要がある（local-only モードが正規ユースケースのひとつ）。
