# cc-tokens (`cctok`)

<p align="center">
  <a href="https://github.com/retogo/cc-tokens/stargazers"><img src="https://img.shields.io/github/stars/retogo/cc-tokens?logo=github&label=stars" alt="GitHub stars"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/retogo/cc-tokens" alt="license"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-000000?logo=bun" alt="Bun"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> |
  <a href="./docs/README.ja.md">日本語</a>
</p>

A live CLI that monitors Claude Code's **5-hour rolling window** consumption — burn rate, exhaustion ETA, and a breakdown of **what (tool / session / project / model / hour) is spending how many tokens**.

It works by parsing the local transcripts (`*.jsonl`) under `~/.claude/projects`. The official `/api/oauth/usage` endpoint is used **only** to show the true `%` and reset time, and to derive the limit; everything else is local and works offline.

## Requirements

- [Bun](https://bun.sh) (developed and verified on the 1.3 line). It does not run on Node.

```sh
bun install
```

## Usage

```sh
# Live dashboard (redraws every 5s by default; API fetch on by default)
bun run src/cli.ts watch
bun run src/cli.ts watch --interval 1 --top 8
bun run src/cli.ts watch --local           # no API fetch (no network / Keychain)

# Fetch 5h/7d % and the true reset time from /api/oauth/usage
bun run src/cli.ts usage

# One-shot report
bun run src/cli.ts report --since block                 # current 5h window (default)
bun run src/cli.ts report --since today --official      # % / reset time / limit estimate
bun run src/cli.ts report --since block --expand        # drill the tool breakdown into Workflow/Agent
bun run src/cli.ts report --since 7d --by tool,model,session,project --top 12

# Snapshot daemon (for the macOS menu-bar app and other external consumers)
bun run src/cli.ts daemon --emit ~/.cctok/snapshot.json
bun run src/cli.ts daemon --emit ~/.cctok/snapshot.json --interval 2 --local
```

#### `daemon` JSON contract

`cctok daemon` writes a single JSON object to `--emit <path>` and rewrites it every
`--interval` seconds (default 5s, minimum 1s). The write is atomic — the file is first
written to `<path>.tmp` and then `rename(2)`d into place, so readers never observe a
partial file. The file is created with mode `0600` (owner-only readable), so put it
under a user-private directory such as `~/.cctok/`. On `SIGINT` / `SIGTERM` the daemon
exits cleanly and leaves no `.tmp` behind. With `--local` no `/api/oauth/usage` call is
made; `--official` (default on) includes `%` / reset time / derived limit when the API
is reachable.

The canonical type is `SerializedSnapshot` in [`src/daemon.ts`](./src/daemon.ts) — the
exact set of fields. The shape below is illustrative; consumers should ignore any keys
they do not recognise rather than reject the payload.

```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-06-29T02:06:17.954Z", // ISO 8601, when the payload was built
  "snapshot": {
    // The Snapshot type from src/snapshot.ts, with sessionTitles as a plain object
    // (sessionId -> display name) instead of a Map.
    "now": 1782698777954, "windowMs": 18000000, "windowStart": 1782680777954,
    "hasActivity": true, "turns": 5, "usedWeighted": 4170,
    "pct": null, "resetTs": null, "effectiveLimit": null,
    "totals": { "input": 0, "output": 0, "cacheCreation": 0, "cacheRead": 0 },
    "cost": 0,
    "burnWindow":  { "weightedPerMin": 0, "rawPerMin": 0 },
    "burn1m":      { "weightedPerMin": 0, "rawPerMin": 0 },
    "burn10":      { "weightedPerMin": 0, "rawPerMin": 0 },
    "burnHour":    { "weightedPerMin": 0, "rawPerMin": 0 },
    "budgetBurnPerMin": null,
    "projection":  null,                  // null | { runOutMs, runOutAt }
    "cumul":       null,                  // null | { past, prediction, start, end }
    "official":    null,                  // null | parsed /api/oauth/usage payload
    "breakdowns":  { /* by tool/model/session/project/hour + drill */ },
    "sessionTitles": { "sess-1": "Title One" }
  }
}
```

Bump `schema_version` only on breaking changes (removing or renaming a field, changing
its type, etc.). Adding a new optional field is non-breaking.

To use it as `cctok`, either `bun link` or `alias cctok='bun run /path/to/src/cli.ts'`.

### Reading the display

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

- **Tokens are the primary metric.** Burn rate and limit are shown in tokens. The `Used` line shows `used / limit` plus `$` (an approximate cost reference for subscription use).
- **Target pace (`Target`).** The burn rate that would spend exactly the remaining tokens (`limit − used`) by reset (remaining ÷ minutes-to-reset). If the actual burn is above it you'll run out before reset; below it you have headroom — compare against the burn line. Shown only when both `limit` and reset time are available.
- **Unit compression.** Large numbers are compressed to `k` / `M` (`169.7k`, `30.8M`).
- **Stock-ticker coloring (watch only).** When a value rises between frames it flashes **green ▲**, falls **red ▼**. The marker always reserves a 1-character slot even when unchanged, so following text never shifts horizontally.
- **% and reset time** are shown only when fetched from `/api/oauth/usage` (`--official`, on by default in watch). When unavailable, only usage / burn / breakdown are shown (no local approximation of the reset).
- **Burn / exhaustion ETA.** The exhaustion time is extrapolated from the last-10-minute burn rate. If the projection doesn't run out before reset, the line is hidden.

### Drilldown (`--expand`, or `Ctrl-O` in watch)

Workflow and Agent (the Task tool) spawn many subagents. `--expand` (toggle with `Ctrl-O` in watch) expands the tool breakdown in place into **Workflow → each run (`wf_*`) → each agent** / **Agent → each agent** (all measured tokens read from the subagent files).

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

In watch, an **in-app virtual scroll** (`↑↓` / PageUp/Down / `g`·`G`) lets you page through the whole breakdown. Quit with `q` or `Ctrl-C`.

## Documentation

- [Token attribution accuracy](./docs/token-attribution.md) — how the measured (`=:`) / estimated (`~:`) hybrid works.
- [API integration & the 5h window](./docs/api-and-window.md) — `--official` / `usage`, OAuth token resolution, 401 / 429 handling, and the window definition.

## Development

```sh
bun test            # unit + integration tests
bun run typecheck   # tsc --noEmit
```

| Module                 | Role                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| `src/parse.ts`         | JSONL line → TurnRecord / tool I/O                                  |
| `src/scan.ts`          | Recursive glob + incremental tail by byte offset                    |
| `src/scan-state.ts`    | `merge` / `pruneState` shared by `watch` and `daemon`               |
| `src/pricing.ts`       | Per-model pricing, cost conversion, token weighting                 |
| `src/blocks.ts`        | 5h window burn rate / exhaustion projection                         |
| `src/aggregate.ts`     | Model / session / project / hour aggregation                        |
| `src/attribute.ts`     | Per-tool attribution (measured + estimated)                         |
| `src/official.ts`      | `/api/oauth/usage` fetch (Keychain/creds) and parsing               |
| `src/official-poll.ts` | Refresh-cadence / backoff / 401 handling shared by `watch`/`daemon` |
| `src/snapshot.ts`      | The bundled snapshot (fixes % / reset from API values)              |
| `src/render/`          | `bars` (formatting / `Ticker`), `report` (one-shot), `watch` (live) |
| `src/daemon.ts`        | Snapshot JSON emitter (atomic write, mode 0600, AbortSignal-driven) |
| `src/cli.ts`           | `watch` / `report` / `usage` / `daemon` dispatch                    |

The core under `src/` (everything except `render/`) is kept reusable so a future web app can swap out only `render/`.

## Limitations

- Direct-tool tokens are a `chars/4` approximation (not a real tokenizer); swap the factor in `attribute.ts`.
- When `--official` is unavailable (no token / expired / offline), `%` and reset time are hidden (usage / burn / breakdown still show).
- The derived limit is a token-unit estimate (the 5h limit is server-side weighted, so it is not a strict ceiling).
- No automatic token refresh (to avoid breaking the main login via refresh-token rotation / Keychain write-back). Launch `claude` once to refresh.

## License

MIT — see [LICENSE](./LICENSE).
