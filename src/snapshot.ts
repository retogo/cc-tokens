import { byHour, byModel, byProject, bySession } from "./aggregate.ts";
import type { DrillNode, ToolBreakdownRow, ToolEvent } from "./attribute.ts";
import { buildSubagentDrill, buildToolBreakdown } from "./attribute.ts";
import { burnRateOverWindow, projectExhaustion } from "./blocks.ts";
import type { Config } from "./config.ts";
import type { OfficialUsage } from "./official.ts";
import type { PriceOverrides, Weighting } from "./pricing.ts";
import { costOf, weightedOf } from "./pricing.ts";
import type { ScanResult } from "./scan.ts";
import type { BreakdownRow, BurnRate, Projection, TokenUsage, TurnRecord } from "./types.ts";

const MIN = 60_000;

export type Since = "block" | "today" | "24h" | "7d" | "30d" | "all";

/** ある時間範囲のレコード／ツールイベントから組み立てた各軸の内訳セット。 */
export interface RangedBreakdowns {
  byModel: BreakdownRow[];
  bySession: BreakdownRow[];
  byProject: BreakdownRow[];
  byHour: BreakdownRow[];
  tools: ToolBreakdownRow[];
  drill: DrillNode[];
}

export function buildBreakdowns(
  records: TurnRecord[],
  toolEvents: ToolEvent[],
  opts: { weighting?: Weighting; overrides?: PriceOverrides } = {},
): RangedBreakdowns {
  const subRecs = records.filter((r) => r.agentKind !== null);
  return {
    byModel: byModel(records, opts),
    bySession: bySession(records, opts),
    byProject: byProject(records, opts),
    byHour: byHour(records, opts),
    tools: buildToolBreakdown(toolEvents, subRecs),
    drill: buildSubagentDrill(subRecs),
  };
}

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
  /** 現在 5h ウィンドウの各軸内訳。watch / report block で render が再計算せずそのまま使う。 */
  breakdowns: RangedBreakdowns;
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

function _emptyBurn(): BurnRate {
  return { weightedPerMin: 0, rawPerMin: 0 };
}

function emptyTotals(): TokenUsage {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

/** windowStart〜now を buckets 等分し、生トークン量を集計する（スパークライン用）。 */
function sparkBuckets(records: TurnRecord[], from: number, to: number, buckets = 24): number[] {
  const span = Math.max(to - from, 1);
  const out = new Array<number>(buckets).fill(0);
  for (const r of records) {
    if (r.ts < from || r.ts > to) continue;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor(((r.ts - from) / span) * buckets)));
    // idx は [0, buckets) にクランプ済みなので out[idx] は必ず存在する。
    // biome-ignore lint/style/noNonNullAssertion: clamped index, fallback would be unreachable
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
  // 過去になった reset 値は API 失敗中の境界跨ぎで起き得るので無効化（近似モードに退避）。
  // 値を信用すると windowStart が >5h 前、windowEnd < now になり projection が歪む。
  const officialFive =
    official?.fiveHour && official.fiveHour.resetsAt > now ? official.fiveHour : null;

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
  // utilization の API 精度は概ね 1%。0.5% のような極小値ではウィンドウ序盤の単発ターンで
  // 逆算 limit が桁違いに膨らみ projection / budgetBurnPerMin が誤誘導するため、閾値を設ける。
  const MIN_UTILIZATION_FOR_LIMIT = 1.0;
  const effectiveLimit =
    officialFive && officialFive.utilization >= MIN_UTILIZATION_FOR_LIMIT && usedWeighted > 0
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

  const burnWindow = burnRateOverWindow(
    recs,
    now - windowStart,
    now,
    config.weighting,
    config.priceOverrides,
  );
  const burn10 = burnRateOverWindow(recs, 10 * MIN, now, config.weighting, config.priceOverrides);
  const burnHour = burnRateOverWindow(recs, 60 * MIN, now, config.weighting, config.priceOverrides);

  // 枯渇予測は直近(10分)バーンを優先、無ければウィンドウ平均。
  const burnForProj = burn10.weightedPerMin > 0 ? burn10.weightedPerMin : burnWindow.weightedPerMin;
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
  const evs = scan.toolEvents.filter((e) => e.ts >= windowStart && e.ts <= now);
  const breakdowns = buildBreakdowns(recs, evs, opts);

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
    breakdowns,
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
