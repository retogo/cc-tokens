import type { PriceOverrides, Weighting } from "./pricing.ts";
import { weightedOf } from "./pricing.ts";
import type { BurnRate, Projection, TurnRecord } from "./types.ts";

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

function weightedSum(
  records: TurnRecord[],
  weighting: Weighting | undefined,
  overrides: PriceOverrides | undefined,
): { weighted: number; raw: number } {
  let weighted = 0;
  let raw = 0;
  for (const r of records) {
    weighted += weightedOf(r.usage, r.model, weighting, overrides);
    raw += r.usage.input + r.usage.output + r.usage.cacheCreation;
  }
  return { weighted, raw };
}

/** (now-windowMs, now] のターンから算出するバーンレート。 */
export function burnRateOverWindow(
  records: TurnRecord[],
  windowMs: number,
  now: number,
  weighting?: Weighting,
  overrides?: PriceOverrides,
): BurnRate {
  const from = now - windowMs;
  const inWindow = records.filter((r) => r.ts >= from && r.ts <= now);
  const { weighted, raw } = weightedSum(inWindow, weighting, overrides);
  const minutes = Math.max(windowMs / 60000, 1e-9);
  return { weightedPerMin: weighted / minutes, rawPerMin: raw / minutes };
}

/**
 * 枯渇予測。limit（加重単位）に対する枯渇時刻と、ウィンドウ終端での着地予測。
 * burnPerMin は加重単位/分（直近バーンを渡す）。
 */
export function projectExhaustion(
  usedWeighted: number,
  limit: number | null,
  burnPerMin: number,
  now: number,
  windowEnd: number,
): Projection {
  let exhaustionTs: number | null = null;
  if (limit !== null && burnPerMin > 0) {
    const remaining = limit - usedWeighted;
    exhaustionTs = remaining <= 0 ? now : now + (remaining / burnPerMin) * 60000;
  }
  const remainingMin = Math.max((windowEnd - now) / 60000, 0);
  return {
    exhaustionTs,
    projectedWeightedAtWindowEnd: usedWeighted + burnPerMin * remainingMin,
  };
}
