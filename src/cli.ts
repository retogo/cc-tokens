#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import type { OfficialUsage } from "./official.ts";
import { fetchOfficialUsage, OfficialFetchError } from "./official.ts";
import { claudeProjectsDir } from "./paths.ts";
import type { ByAxis } from "./render/report.ts";
import { renderReport, renderUsage } from "./render/report.ts";
import { watch } from "./render/watch.ts";
import { Scanner } from "./scan.ts";
import type { Since } from "./snapshot.ts";
import { buildBreakdowns, buildSnapshot, rangeStart } from "./snapshot.ts";

const HELP = `cctok — Claude Code token monitor

Usage:
  cctok watch [--interval 5] [--top 6]
      Live dashboard (5h gauge, burn, exhaustion ETA, breakdown)

  cctok report [--since block|today|24h|7d|30d|all] [--by tool,model,session,project,hour] [--top 8] [--expand]
      One-shot report (--expand drills the tool breakdown into Workflow/Agent)

  cctok usage
      Fetch 5h/7d % and the true reset time from /api/oauth/usage

Common options:
  --official       Fetch % / true reset time / limit (derived) from /api/oauth/usage
                   (on by default in watch, opt-in for report; needs an OAuth token.
                    On 401, launch claude once to refresh the token)
  --local          Don't fetch the API (local only, no network / Keychain)
  --root <dir>     projects root (default: ~/.claude/projects)
  -h, --help
`;

/** API usage を取得（失敗時は理由を stderr に出して null）。report 用。 */
async function safeOfficial(now: number): Promise<OfficialUsage | null> {
  try {
    return await fetchOfficialUsage(now);
  } catch (e) {
    const msg = e instanceof OfficialFetchError ? e.message : String(e);
    process.stderr.write(`API unavailable (% / reset time hidden): ${msg}\n`);
    return null;
  }
}

function parseAxes(v: string | undefined, fallback: ByAxis[]): ByAxis[] {
  if (!v) return fallback;
  const valid = new Set<string>(["tool", "model", "session", "project", "hour"]);
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ByAxis => valid.has(s));
}

/** 数値フラグを検証。非数値や非正数は警告を出して undefined（呼び出し側で既定にフォールバック）。 */
function parsePositiveNumber(
  raw: string | undefined,
  flag: string,
  parser: (s: string) => number,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = parser(raw);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`Invalid --${flag}: ${raw} (must be a positive number; using default)\n`);
    return undefined;
  }
  return n;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      interval: { type: "string" },
      top: { type: "string" },
      since: { type: "string" },
      by: { type: "string" },
      root: { type: "string" },
      official: { type: "boolean" },
      local: { type: "boolean" },
      expand: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const cmd = positionals[0] ?? "watch";
  if (values.help || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }

  const root = values.root || claudeProjectsDir();
  const config = await loadConfig();
  const topN = parsePositiveNumber(values.top, "top", (s) => parseInt(s, 10));

  if (cmd === "usage") {
    const now = Date.now();
    try {
      const official = await fetchOfficialUsage(now);
      process.stdout.write(`${renderUsage(official, now)}\n`);
    } catch (e) {
      const msg = e instanceof OfficialFetchError ? e.message : String(e);
      process.stderr.write(`Failed to fetch usage: ${msg}\n`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "watch") {
    const intervalSec = parsePositiveNumber(values.interval, "interval", parseFloat);
    const intervalMs = (intervalSec ?? config.intervalSec) * 1000;
    await watch(root, config, {
      intervalMs,
      topN: topN ?? 6,
      axes: parseAxes(values.by, ["tool", "model", "session"]),
      official: values.local ? false : (values.official ?? true),
      expand: values.expand ?? false,
    });
    return;
  }

  if (cmd === "report") {
    const now = Date.now();
    const since = (values.since as Since) || "block";
    const scanner = new Scanner(root);
    const from = rangeStart(since, now);
    const scan = await scanner.seed(from ?? undefined);
    const official = values.official ? await safeOfficial(now) : null;
    const snap = buildSnapshot(scan, config, now, official);

    // block は snap.breakdowns（=5h ウィンドウ集計）をそのまま使い、
    // since=今日/24h/7d/30d/all のときだけ独自範囲の Breakdowns を組み立てる。
    const breakdowns =
      since === "block"
        ? snap.breakdowns
        : buildBreakdowns(
            from !== null ? scan.records.filter((r) => r.ts >= from) : scan.records,
            from !== null ? scan.toolEvents.filter((e) => e.ts >= from) : scan.toolEvents,
            { weighting: config.weighting, overrides: config.priceOverrides },
          );

    const body = renderReport(snap, breakdowns, since, {
      topN: topN ?? 8,
      axes: parseAxes(values.by, ["tool", "model", "session", "project"]),
      expand: values.expand ?? false,
    });
    process.stdout.write(`${body}\n`);
    return;
  }

  process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err?.stack || err}\n`);
  process.exit(1);
});
