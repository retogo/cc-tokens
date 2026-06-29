#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { runDaemon } from "./daemon.ts";
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

  cctok daemon --emit <path> [--interval 5] [--official|--local]
      Write snapshot JSON ({ schema_version, generated_at, snapshot })
      atomically to <path> every interval seconds (min 1s, default 5s).
      The file is written with mode 0600 (owner-only). Intended for the
      macOS menu-bar app and other external consumers.

Common options:
  --official       Fetch % / true reset time / limit (derived) from /api/oauth/usage
                   (on by default in watch and daemon, opt-in for report;
                    needs an OAuth token. On 401, launch claude once to refresh)
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

const SINCE_VALUES: ReadonlySet<Since> = new Set(["block", "today", "24h", "7d", "30d", "all"]);

/** --since の値を検証。未知値は警告して既定 (block) に戻す（不明な文字列を素通しすると無音で全期間集計になる）。 */
export function parseSince(raw: string | undefined): Since {
  if (raw === undefined) return "block";
  if (SINCE_VALUES.has(raw as Since)) return raw as Since;
  process.stderr.write(
    `Invalid --since: ${raw} (must be block|today|24h|7d|30d|all; using default 'block')\n`,
  );
  return "block";
}

/**
 * 数値フラグを検証。`parseInt` / `parseFloat` の寛容パース（`5abc` → 5 等）を避け、
 * 正規表現でフォーマットを厳格チェックしてから Number() で変換する。
 * 非数値・部分パース・非正数は警告を出して undefined（呼び出し側で既定にフォールバック）。
 */
export function parsePositiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || !(Number(raw) > 0)) {
    process.stderr.write(`Invalid --${flag}: ${raw} (must be a positive integer; using default)\n`);
    return undefined;
  }
  return Number(raw);
}

/**
 * daemon --emit のパスを検証する。
 * - 未指定 / 空白だけ → エラー
 * - 末尾 `/`（ディレクトリ指定っぽい） → エラー
 * - `~` リテラル始まり（シェル expand 済みでない） → エラー（launchd plist の典型ミス）
 * これらに通った場合は文字列をそのまま返す。シンボリックリンクの拒否は writeFile 経路で
 * 行う想定（rename がリンク先を上書きするのは想定内とし、ここでは入力 sanitation のみ）。
 */
export function validateEmitPath(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") {
    process.stderr.write("daemon: --emit <path> is required\n");
    return null;
  }
  if (raw.endsWith("/")) {
    process.stderr.write(`daemon: --emit must point to a file, not a directory (${raw})\n`);
    return null;
  }
  if (raw.startsWith("~")) {
    process.stderr.write(
      `daemon: --emit must be an expanded absolute path; '~' is not expanded by the CLI (${raw})\n`,
    );
    return null;
  }
  return raw;
}

export function parsePositiveFloat(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  // 5 / 5.0 / 0.5 / .5 を許容。末尾ゴミは弾く。
  if (!/^(\d+\.?\d*|\.\d+)$/.test(raw)) {
    process.stderr.write(`Invalid --${flag}: ${raw} (must be a positive number; using default)\n`);
    return undefined;
  }
  const n = Number(raw);
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
      emit: { type: "string" },
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
  const topN = parsePositiveInt(values.top, "top");

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
    const intervalSec = parsePositiveFloat(values.interval, "interval");
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

  if (cmd === "daemon") {
    const emitPath = validateEmitPath(values.emit);
    if (emitPath === null) {
      // validateEmitPath 内で stderr に詳細を出している。
      process.exit(1);
    }
    // --interval は CLI フラグの場合のみ「最小 1s」警告を出す（config 由来の値には別文言）。
    const cliInterval = parsePositiveFloat(values.interval, "interval");
    let intervalSec: number;
    if (cliInterval !== undefined) {
      if (cliInterval < 1) {
        process.stderr.write(
          `--interval ${cliInterval} is below the minimum of 1s; using 1s instead\n`,
        );
      }
      intervalSec = Math.max(cliInterval, 1);
    } else {
      // config.intervalSec が壊れていた場合（非数値・非正・非有限）は DEFAULTS と同じ 5 に戻す。
      // loadConfig は schema 検証していないので外部境界として CLI 側で守る。
      const cfg = config.intervalSec;
      if (!Number.isFinite(cfg) || cfg <= 0) {
        process.stderr.write(
          `config intervalSec is invalid (${String(cfg)}); using default 5s\n`,
        );
        intervalSec = 5;
      } else if (cfg < 1) {
        process.stderr.write(
          `config intervalSec=${cfg} is below the minimum of 1s; using 1s instead\n`,
        );
        intervalSec = 1;
      } else {
        intervalSec = cfg;
      }
    }
    const intervalMs = intervalSec * 1000;

    // signal は CLI 層が SIGINT/SIGTERM から AbortController に変換して渡す（runDaemon は process に直接触らない）。
    const aborter = new AbortController();
    const onSignal = () => aborter.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const ctrl = runDaemon(root, config, {
      emitPath,
      intervalMs,
      official: values.local ? false : (values.official ?? true),
      signal: aborter.signal,
    });
    try {
      await ctrl.done;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    return;
  }

  if (cmd === "report") {
    const now = Date.now();
    const since = parseSince(values.since);
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
            from !== null
              ? scan.subagentToolEvents.filter((e) => e.ts >= from)
              : scan.subagentToolEvents,
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
