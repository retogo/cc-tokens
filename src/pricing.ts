import type { TokenUsage } from "./types.ts";

/** $/Mtok 単価。 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** 入力単価から cache 単価（write×1.25 / read×0.1）を導出する。 */
function fromBase(input: number, output: number): ModelPrice {
  return { input, output, cacheWrite: input * 1.25, cacheRead: input * 0.1 };
}

/**
 * モデル別の $/Mtok 単価。サブスク利用では実課金ではないが、5h 制限の加重指標
 * として最も相関が良いコスト換算の基準に使う。値は config で上書き可能。
 */
export const PRICES: Record<string, ModelPrice> = {
  opus: fromBase(5, 25),
  sonnet: fromBase(3, 15),
  haiku: fromBase(1, 5),
  fable: fromBase(10, 50),
};

/** 未知モデルの fallback（opus 相当）。 */
const FALLBACK: ModelPrice = fromBase(5, 25);

export type PriceOverrides = Partial<Record<string, Partial<ModelPrice>>>;

/** モデル文字列を部分一致でファミリ単価に解決する。overrides が最優先。 */
export function priceFor(model: string, overrides?: PriceOverrides): ModelPrice {
  const m = model.toLowerCase();
  let family: string | null = null;
  for (const key of Object.keys(PRICES)) {
    if (m.includes(key)) {
      family = key;
      break;
    }
  }
  // family は Object.keys(PRICES) 由来なので PRICES[family] は必ず存在する。
  // biome-ignore lint/style/noNonNullAssertion: key derived from Object.keys(PRICES)
  const base = family ? PRICES[family]! : FALLBACK;
  if (family && overrides?.[family]) {
    return { ...base, ...overrides[family] };
  }
  return base;
}

/** usage のコスト（ドル）。 */
export function costOf(usage: TokenUsage, model: string, overrides?: PriceOverrides): number {
  const p = priceFor(model, overrides);
  return (
    (usage.input * p.input +
      usage.output * p.output +
      usage.cacheCreation * p.cacheWrite +
      usage.cacheRead * p.cacheRead) /
    1_000_000
  );
}

/** 加重指標の定義。cost = コスト換算、raw = 生トークン（既定で cache_read 除外）。 */
export type Weighting = { mode: "cost" } | { mode: "raw"; includeCacheRead?: boolean };

/**
 * limit ゲージ・バーンレートに使う単一スカラー指標。
 * cost: costOf（ドル）。raw: 生トークン合計（既定で cache_read 除外）。
 * 既定は呼び出し側（Config 経由）に委ねる。引数既定値は持たない
 * （Config の DEFAULTS.weighting と pricing 側の暗黙既定値が乖離するのを避ける）。
 */
export function weightedOf(
  usage: TokenUsage,
  model: string,
  weighting: Weighting,
  overrides?: PriceOverrides,
): number {
  if (weighting.mode === "raw") {
    const base = usage.input + usage.output + usage.cacheCreation;
    return weighting.includeCacheRead ? base + usage.cacheRead : base;
  }
  return costOf(usage, model, overrides);
}
