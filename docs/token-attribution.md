# Token attribution accuracy

[English](./token-attribution.md) | [日本語](./token-attribution.ja.md)

The API's `usage` is reported **per turn (per API response)** — there is no accurate per-tool token count. So the "by tool" breakdown uses a hybrid, and the display distinguishes the two cases:

- **`=:` (measured).** The subagents of **Agent (the Task tool) / Workflow** each have their own `usage` in a separate file under `…/subagents/**/agent-*.jsonl`. Their sum (`input + output + cacheCreation`) is aggregated exactly.
- **`~:` (estimated).** **Direct tools (Read / Bash / Edit, etc.)** are estimated from the character length of each tool result (`tool_result`) converted to tokens with `chars / 4` — a context-contribution estimate. Tool names are matched via `tool_use.id ↔ tool_result.tool_use_id`. The conversion factor lives in `CHARS_PER_TOKEN` in `src/attribute.ts` (replaceable).

Tool calls **inside** a subagent are already measured on the Agent / Workflow side, so they are excluded from the direct-tool estimate to avoid double counting.

By contrast, the **session / project / model / hour** breakdowns are the raw measured `usage`, so they are accurate.
