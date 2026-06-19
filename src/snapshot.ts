import type {
  BreakdownRow,
  BurnRate,
  Projection,
  TokenUsage,
  TurnRecord,
} from "./types.ts";
import type { Config } from "./config.ts";
import type { ScanResult } from "./scan.ts";
import type { ToolBreakdownRow } from "./attribute.ts";
import type { OfficialUsage } from "./official.ts";
import { buildToolBreakdown } from "./attribute.ts";
import { burnRateOverWindow, projectExhaustion } from "./blocks.ts";
import { byHour, byModel, byProject, bySession } from "./aggregate.ts";
import { costOf, weightedOf } from "./pricing.ts";

const MIN = 60_000;

export type Since = "block" | "today" | "24h" | "7d" | "30d" | "all";

/** since 指定の開始時刻（epoch ms）。block/all は null（範囲制限なし or ブロック）。 */
export function rangeStart(since: Since, now: number): number | null {
  switch (since) {
    case "today": {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "24h":
      return now - 24 * 3600_000;
    case "7d":
      return now - 7 * 24 * 3600_000;
    case "30d":
      return now - 30 * 24 * 3600_000;
    case "block":
    case "all":
    default:
      return null;
  }
}

export interface Snapshot {
  now: number;
  windowMs: number;
  /** 現在ウィンドウの開始時刻（公式 resets_at-5h、無ければ now-5h）。 */
  windowStart: number;
  /** ウィンドウ内にアクティビティがあるか。 */
  hasActivity: boolean;
  /** ウィンドウ内のターン数。 */
  turns: number;
  /** 現在ウィンドウの加重消費（既定はトークン）。 */
  usedWeighted: number;
  /** 使用率（API の utilization のみ。取得できなければ null）。 */
  pct: number | null;
  totals: TokenUsage;
  /** 参考のコスト換算（$）。サブスクでは目安。 */
  cost: number;
  /** ウィンドウ平均バーン。 */
  burnWindow: BurnRate;
  burn10: BurnRate;
  burnHour: BurnRate;
  /**
   * リセットまでに残り（effectiveLimit-used）をちょうど使い切るバーンレート（加重/分）。
   * これを超えると reset 前に枯渇、下回れば余裕。limit か reset が無ければ null。
   */
  budgetBurnPerMin: number | null;
  projection: Projection | null;
  byModel: BreakdownRow[];
  bySession: BreakdownRow[];
  byProject: BreakdownRow[];
  byHour: BreakdownRow[];
  tools: ToolBreakdownRow[];
  /** sessionId → 表示名（custom-title 優先、無ければ ai-title）。 */
  sessionTitles: Map<string, string>;
  /** ウィンドウ開始〜now を48分割したバケット毎の生トークン（スパークライン用）。 */
  spark: number[];
  /** 直近10分を10秒幅×60個のバケットに分けた生トークン（watch 用、左スクロール表示）。 */
  sparkRecent: number[];
  /** 公式 usage（取得できた場合）。 */
  official: OfficialUsage | null;
  /** 真のリセット時刻（API のみ。無ければ null）。 */
  resetTs: number | null;
  /** 予測に使う limit（API の utilization と現在消費から逆算。取得できなければ null）。 */
  effectiveLimit: number | null;
}

function costSum(records: TurnRecord[], overrides: Config["priceOverrides"]) {
  let c = 0;
  for (const r of records) c += costOf(r.usage, r.model, overrides);
  return c;
}

function emptyBurn(): BurnRate {
  return { weightedPerMin: 0, rawPerMin: 0 };
}

function emptyTotals(): TokenUsage {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

/** windowStart〜now を buckets 等分し、生トークン量を集計する（スパークライン用）。 */
function sparkBuckets(
  records: TurnRecord[],
  from: number,
  to: number,
  buckets = 24,
): number[] {
  const span = Math.max(to - from, 1);
  const out = new Array<number>(buckets).fill(0);
  for (const r of records) {
    if (r.ts < from || r.ts > to) continue;
    const idx = Math.min(
      buckets - 1,
      Math.max(0, Math.floor(((r.ts - from) / span) * buckets)),
    );
    out[idx]! += r.usage.input + r.usage.output + r.usage.cacheCreation;
  }
  return out;
}

/**
 * scan 結果から現在 5h ウィンドウのスナップショットを作る。
 * ウィンドウは公式 resets_at（あれば）から resets_at-5h に確定し、無ければ直近 5h。
 * 内訳・ツール帰属はこのウィンドウ範囲で計算する。
 */
export function buildSnapshot(
  scan: ScanResult,
  config: Config,
  now: number,
  official: OfficialUsage | null = null,
): Snapshot {
  const windowMs = config.windowHours * 3600_000;
  const opts = { weighting: config.weighting, overrides: config.priceOverrides };
  const officialFive = official?.fiveHour ?? null;

  // ウィンドウ確定: 公式 reset があれば reset-5h、無ければ直近 5h（近似 reset は出さない）。
  const resetTs = officialFive?.resetsAt ?? null;
  const windowStart = resetTs !== null ? resetTs - windowMs : now - windowMs;
  const windowEnd = resetTs ?? windowStart + windowMs;

  const recs = scan.records.filter((r) => r.ts >= windowStart && r.ts <= now);
  const usedWeighted = recs.reduce(
    (s, r) => s + weightedOf(r.usage, r.model, config.weighting, config.priceOverrides),
    0,
  );

  // limit/%/reset はすべて API のみに寄せる（取れなければ表示しない）。
  // effectiveLimit: API の utilization と現在消費から逆算。
  const effectiveLimit =
    officialFive && officialFive.utilization > 0 && usedWeighted > 0
      ? usedWeighted / (officialFive.utilization / 100)
      : null;

  // pct: API の utilization のみ。
  const pct = officialFive ? officialFive.utilization / 100 : null;

  const totals = recs.reduce((acc, r) => {
    acc.input += r.usage.input;
    acc.output += r.usage.output;
    acc.cacheCreation += r.usage.cacheCreation;
    acc.cacheRead += r.usage.cacheRead;
    return acc;
  }, emptyTotals());

  const burnWindow = burnRateOverWindow(recs, now - windowStart, now, config.weighting, config.priceOverrides);
  const burn10 = burnRateOverWindow(recs, 10 * MIN, now, config.weighting, config.priceOverrides);
  const burnHour = burnRateOverWindow(recs, 60 * MIN, now, config.weighting, config.priceOverrides);

  // 枯渇予測は直近(10分)バーンを優先、無ければウィンドウ平均。
  const burnForProj =
    burn10.weightedPerMin > 0 ? burn10.weightedPerMin : burnWindow.weightedPerMin;
  const projection =
    recs.length > 0
      ? projectExhaustion(usedWeighted, effectiveLimit, burnForProj, now, windowEnd)
      : null;

  // リセットまでに残りをちょうど使い切るペース（reset 時刻と limit が必要）。
  // remaining が実質0なら非表示（既に100%到達している状態では無意味）。
  let budgetBurnPerMin: number | null = null;
  if (effectiveLimit !== null && resetTs !== null && resetTs > now) {
    const remaining = Math.max(effectiveLimit - usedWeighted, 0);
    // remaining が 1% 未満なら「使い切りペース」は表示しない
    if (remaining > effectiveLimit * 0.01) {
      budgetBurnPerMin = remaining / ((resetTs - now) / MIN);
    }
  }

  // ツール帰属: ウィンドウ内の main toolEvents + ウィンドウ内 subagent records。
  const evs = scan.toolEvents.filter(
    (e) => e.ts === null || (e.ts >= windowStart && e.ts <= now),
  );
  const subRecs = recs.filter((r) => r.agentKind !== null);
  const tools = buildToolBreakdown(evs, subRecs);

  return {
    now,
    windowMs,
    windowStart,
    hasActivity: recs.length > 0,
    turns: recs.length,
    usedWeighted,
    pct,
    totals,
    cost: costSum(recs, config.priceOverrides),
    burnWindow,
    burn10,
    burnHour,
    budgetBurnPerMin,
    projection,
    byModel: byModel(recs, opts),
    bySession: bySession(recs, opts),
    byProject: byProject(recs, opts),
    byHour: byHour(recs, opts),
    tools,
    sessionTitles: scan.sessionTitles,
    spark: sparkBuckets(recs, windowStart, now, 48),
    // バケット境界を絶対時刻（10秒粒度）に揃え、未完了バケットを含めないことで「ティックが進んでも形が変わらず、境界をまたいだ瞬間だけ左に1個ずれる」純粋な左スクロールを実現する。
    sparkRecent: (() => {
      const bucketMs = 10_000;
      const buckets = 60;
      const bucketEnd = Math.floor(now / bucketMs) * bucketMs;
      return sparkBuckets(recs, bucketEnd - bucketMs * buckets, bucketEnd, buckets);
    })(),
    official,
    resetTs,
    effectiveLimit,
  };
}
