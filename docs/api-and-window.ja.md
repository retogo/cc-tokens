# API 連携と 5h ウィンドウ

[English](./api-and-window.md) | [日本語](./api-and-window.ja.md)

## API 連携（`--official` / `usage`）

% / リセット時刻 / limit は **API（`GET https://api.anthropic.com/api/oauth/usage`、OAuth Bearer）に一本化**している。
レスポンスの `five_hour` / `seven_day` が `utilization`（%）と `resets_at`（**真のリセット時刻**）を持つ。`cctok` は:

- 表示の **% と リセット時刻**を API 値で確定する（**取得できなければ表示しない**。ローカル近似は使わない）。
- 現在%と現在の消費トークンから **limit（トークン目安）を逆算**し、`目標ペース` と枯渇予測に使う。
- ウィンドウ範囲も `resets_at - 5h` に確定（取得できない時は直近 5h で使用量・バーン・内訳のみ表示）。

OAuth トークンは **macOS Keychain（`Claude Code-credentials`）** を優先し、無ければ
`~/.claude/.credentials.json` を読む。ネットワーク/Keychain を使いたくない時は `--local`。

### % が出ない時の理由（画面に表示）

取得失敗時は理由を画面に出す（`API 未取得: …` / 一度取れていれば `API 更新失敗(…)・前回値 N分前`）。主な原因:

- **401 認証エラー** = アクセストークン期限切れ。`cctok` は素の GET で **自動リフレッシュしない**。
  本体の Claude Code は起動時に refresh token で更新するので、**`claude` を一度起動**すれば再び取得できる。
- **429 レート制限** = `/api/oauth/usage` への問い合わせ過多。`watch` は **3 分間隔**で取得し、失敗時は
  `Retry-After` を尊重して指数バックオフする。**一度取れた値は保持**するので、一時的な 429 でゲージは消えない。

トークン自動リフレッシュは未実装（refresh token のローテーション / Keychain 書き戻しで本体ログインを壊すリスクを避けるため）。

## 5h ウィンドウの定義

ウィンドウは `[reset - 5h, now]`。`reset` は `/api/oauth/usage` の `resets_at`（取得時）。取得できない時は
直近 5h（`[now - 5h, now]`）を用い、リセット時刻は表示しない（ローカル近似は出さない）。
使用量・バーン・内訳はこのウィンドウ内のターンから算出する。
