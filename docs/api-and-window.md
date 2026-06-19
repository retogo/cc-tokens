# API integration & the 5h window

[English](./api-and-window.md) | [日本語](./api-and-window.ja.md)

## API integration (`--official` / `usage`)

`%` / reset time / limit are **unified on the API** (`GET https://api.anthropic.com/api/oauth/usage`, OAuth Bearer). The response's `five_hour` / `seven_day` carry `utilization` (`%`) and `resets_at` (the **true reset time**). `cctok`:

- Fixes the displayed **`%` and reset time** from API values (**hides them when unavailable**; no local approximation).
- Derives the **limit (token estimate)** from the current `%` and current consumption, and uses it for `target pace` and the exhaustion projection.
- Fixes the window range to `resets_at - 5h` as well (when unavailable, falls back to the last 5h and shows only usage / burn / breakdown).

The OAuth token is read from the **macOS Keychain (`Claude Code-credentials`)** first, falling back to `~/.claude/.credentials.json`. Use `--local` when you don't want to touch the network / Keychain.

### Why `%` may not show (displayed on screen)

On fetch failure the reason is shown on screen (`API 未取得: …`, or once a value was obtained, `API 更新失敗(…)・前回値 N分前`). Main causes:

- **401 Unauthorized** = the access token expired. `cctok` issues a plain GET and **does not auto-refresh**. The Claude Code app refreshes via the refresh token at startup, so **launching `claude` once** restores fetching.
- **429 Rate limit** = too many requests to `/api/oauth/usage`. `watch` fetches every **3 minutes** and, on failure, honors `Retry-After` with exponential backoff. **The last good value is retained**, so a transient 429 doesn't blank the gauge.

Automatic token refresh is intentionally not implemented (to avoid breaking the main login via refresh-token rotation / Keychain write-back).

## The 5h window definition

The window is `[reset - 5h, now]`, where `reset` is `resets_at` from `/api/oauth/usage` (when fetched). When unavailable, it uses the last 5h (`[now - 5h, now]`) and does **not** show the reset time (no local approximation). Usage / burn / breakdown are computed from the turns within this window.
