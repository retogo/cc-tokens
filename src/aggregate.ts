import type { BreakdownRow, TokenUsage, TurnRecord } from "./types.ts";
import type { PriceOverrides, Weighting } from "./pricing.ts";
import { costOf, weightedOf } from "./pricing.ts";

export interface AggregateOptions {
  weighting?: Weighting;
  overrides?: PriceOverrides;
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

interface Acc {
  usage: TokenUsage;
  weighted: number;
  cost: number;
  count: number;
}

/**
 * TurnRecord 列を keyFn でグループ化し、weighted 降順・share 付きの行に集計する。
 * weighted/cost は各レコードを自身の model で評価して合算する。
 */
export function groupBy(
  records: TurnRecord[],
  keyFn: (r: TurnRecord) => string,
  opts: AggregateOptions = {},
): BreakdownRow[] {
  const map = new Map<string, Acc>();
  let totalWeighted = 0;

  for (const r of records) {
    const key = keyFn(r);
    let acc = map.get(key);
    if (!acc) {
      acc = { usage: emptyUsage(), weighted: 0, cost: 0, count: 0 };
      map.set(key, acc);
    }
    acc.usage.input += r.usage.input;
    acc.usage.output += r.usage.output;
    acc.usage.cacheCreation += r.usage.cacheCreation;
    acc.usage.cacheRead += r.usage.cacheRead;
    const w = weightedOf(r.usage, r.model, opts.weighting, opts.overrides);
    acc.weighted += w;
    acc.cost += costOf(r.usage, r.model, opts.overrides);
    acc.count += 1;
    totalWeighted += w;
  }

  const rows: BreakdownRow[] = [];
  for (const [key, acc] of map) {
    rows.push({
      key,
      usage: acc.usage,
      weighted: acc.weighted,
      cost: acc.cost,
      count: acc.count,
      share: totalWeighted > 0 ? acc.weighted / totalWeighted : 0,
    });
  }
  rows.sort((a, b) => b.weighted - a.weighted);
  return rows;
}

export const byModel = (r: TurnRecord[], o?: AggregateOptions) =>
  groupBy(r, (x) => x.model, o);

export const bySession = (r: TurnRecord[], o?: AggregateOptions) =>
  groupBy(r, (x) => x.sessionId, o);

export const byProject = (r: TurnRecord[], o?: AggregateOptions) =>
  groupBy(r, (x) => x.project, o);

/** ローカル時刻の時（00..23）で集計。 */
export const byHour = (r: TurnRecord[], o?: AggregateOptions) =>
  groupBy(r, (x) => String(new Date(x.ts).getHours()).padStart(2, "0"), o);
