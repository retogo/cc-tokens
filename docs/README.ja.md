# cc-tokens (`cctok`)

<p align="center">
  <a href="https://github.com/retogo/cc-tokens/stargazers"><img src="https://img.shields.io/github/stars/retogo/cc-tokens?logo=github&label=stars" alt="GitHub stars"></a>
  <a href="../LICENSE"><img src="https://img.shields.io/github/license/retogo/cc-tokens" alt="license"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-000000?logo=bun" alt="Bun"></a>
</p>

<p align="center">
  <a href="../README.md">English</a> |
  <a href="./README.ja.md">日本語</a>
</p>

Claude Code の **5 時間ローリングウィンドウ**の消費を **バーンレート・枯渇予測**とともに監視し、
**何（ツール / セッション / プロジェクト / モデル / 時間帯）にどれだけトークンを使っているか**を可視化するライブ CLI。

`~/.claude/projects` 配下のトランスクリプト（`*.jsonl`）をローカル解析して動く。公式 `/api/oauth/usage` は
**真の % とリセット時刻の表示・limit の逆算にのみ**使い、それ以外はローカルで完結しオフラインでも動作する。

## 必要環境

- [Bun](https://bun.sh)（開発・実行は 1.3 系で確認）。Node では動かない。

```sh
bun install
```

## 使い方

```sh
# ライブ監視ダッシュボード（既定 5 秒ごとに再描画。API 取得は既定 ON）
bun run src/cli.ts watch
bun run src/cli.ts watch --interval 1 --top 8
bun run src/cli.ts watch --local           # API 取得なし（ネットワーク/Keychain 不使用）

# /api/oauth/usage から 5h/7d の % と真のリセット時刻を取得
bun run src/cli.ts usage

# 単発レポート
bun run src/cli.ts report --since block                 # 現在の5hウィンドウ（既定）
bun run src/cli.ts report --since today --official      # % / リセット時刻 / limit 自動推定
bun run src/cli.ts report --since block --expand        # ツール内訳の Workflow/Agent をドリルダウン展開
bun run src/cli.ts report --since 7d --by tool,model,session,project --top 12
```

`cctok` として使いたい場合は `bun link` するか、`alias cctok='bun run /path/to/src/cli.ts'`。

### 表示の見方

表示は英語（コメントは日本語、UI 文字列は英語という方針）。

```
● Claude Code 5h window
  ███████████░░░░░░░░░░░░░░░░░ 50.0%
  Used     15.4M / 30.8M tok   $238.31
  Reset    2h48m (17:30)

  Burn     169.7k tok/min   1h avg 83.3k
  Target   92.0k tok/min   100% at reset
  Run-out  in 2h05m (16:40)
  Trend (10m) ▁▂▃▄▅▆▇█▇▅▃▂▁▁▁
```

- **トークンが主指標**: バーン・limit はトークン量で表示。`Used`（使用）行は `消費 / limit` と `$`（サブスク利用の目安コスト）。
- **目標ペース（`Target`）**: リセットまでに残り（`limit − 使用`）をちょうど使い切るバーンレート（残り ÷ リセットまでの分）。
  バーンがこれを上回れば reset 前に枯渇、下回れば余裕（判定はバーンと見比べる）。`limit` と リセット時刻が揃った時のみ表示。
- **数値の単位圧縮**: 大きな数は `k` / `M` に圧縮（`169.7k`、`30.8M`）。
- **株価ティッカー風の着色（watch のみ）**: フレーム間で数値が増えると **緑 ▲**、減ると **赤 ▼** でフラッシュ。
  マーカは増減が無くても 1 文字幅の枠を確保するので、後続テキストは横にズレない。
- **% と リセット時刻**: `/api/oauth/usage`（`--official`、watch は既定 ON）から取得した時のみ表示。
  取得できない時は使用量・バーン・内訳のみ（リセットの近似表示はしない）。
- **バーン / 枯渇予測**: 直近 10 分のバーンレートを優先して枯渇時刻を外挿する。リセットまでに枯渇しない予測なら非表示。

### ドリルダウン（`--expand` / watch は `Ctrl-O`）

Workflow / Agent（Task ツール）は内部で多数のサブエージェントを起動する。`--expand`（watch では `Ctrl-O` でトグル）で
ツール内訳の **Workflow → 各実行(`wf_*`) → 各 agent** / **Agent → 各 agent** をその場で字下げ展開する
（いずれもサブエージェントファイルからの実測トークン）。

```
Tokens by tool (~:est / =:measured)  [Ctrl-O: collapse]
  █████████░░░  78%  =  2.84M  × 696  Workflow
                                      ▸  851.3k  ×216  wf_1d4fd59a-641
                                        ·  583.4k  ×157  agent a360de6f
                                        ·  267.9k  × 59  agent a8cb4033
                                        … 11 more
  █░░░░░░░░░░░  12%  =  720.2k  × 296  Agent
                                      ▸  632.4k  ×284  agent adbaa461
```

watch は **アプリ内仮想スクロール**（`↑↓` / PageUp/Down / `g`・`G`）で全内訳を遡れる。`q` または `Ctrl-C` で終了。

## ドキュメント

- [トークン帰属の精度](./token-attribution.ja.md) — 実測（`=:`）/ 推定（`~:`）のハイブリッド集計の仕組み。
- [API 連携と 5h ウィンドウ](./api-and-window.ja.md) — `--official` / `usage`、OAuth トークン解決、401 / 429 の扱い、ウィンドウ定義。

## 開発

```sh
bun test            # 単体 + 統合テスト
bun run typecheck   # tsc --noEmit
```

| モジュール         | 役割                                                          |
| ------------------ | ------------------------------------------------------------- |
| `src/parse.ts`     | JSONL 1 行 → TurnRecord / ツール I/O                          |
| `src/scan.ts`      | 再帰 glob・全走査 + バイトオフセットによる増分 tail           |
| `src/pricing.ts`   | モデル別料金・コスト換算・トークン加重                        |
| `src/blocks.ts`    | 5h ウィンドウのバーンレート・枯渇予測                         |
| `src/aggregate.ts` | モデル/セッション/プロジェクト/時間帯の集計                   |
| `src/attribute.ts` | ツール別帰属（実測 + 推定）                                   |
| `src/official.ts`  | `/api/oauth/usage` 取得（Keychain/creds）とパース             |
| `src/snapshot.ts`  | 上記を束ねたスナップショット（API 値で % / reset を確定）     |
| `src/render/`      | `bars`（整形・`Ticker`）・`report`（単発）・`watch`（ライブ） |
| `src/cli.ts`       | `watch` / `report` / `usage` のディスパッチ                   |

解析コア（`src/` のうち `render/` 以外）は再利用可能に保ち、将来の webapp 化では `render/` だけ差し替える設計。

## 制限・今後

- 直接ツールのトークンは `chars/4` 近似（正確なトークナイザではない）。`attribute.ts` で差し替え可能。
- `--official` が使えない時（トークン無し/期限切れ/オフライン）は % とリセット時刻を表示しない（使用量・バーン・内訳は出る）。
- 逆算する limit はトークン単位の目安（5h 制限はサーバ側で重み付けされるため厳密な上限ではない）。
- トークン自動リフレッシュは未実装（refresh token のローテーション・Keychain 書き戻しの破壊リスクを避けるため）。`claude` 起動で更新。

## ライセンス

MIT — [LICENSE](../LICENSE) を参照。
