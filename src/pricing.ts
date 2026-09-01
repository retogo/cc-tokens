import type { PricingAttributes, TokenUsage } from "./types.ts";

/** $/Mtok 単価（webSearch のみ $/リクエスト）。 */
export interface ModelPrice {
  input: number;
  output: number;
  /** 5 分 TTL の cache write。 */
  cacheWrite: number;
  /** 1 時間 TTL の cache write。 */
  cacheWrite1h: number;
  cacheRead: number;
  /** web search 1 リクエストあたりのドル。 */
  webSearch: number;
}

/** web search は全モデル共通で $0.01/リクエスト。 */
const WEB_SEARCH = 0.01;

/** 入力単価から cache 単価（write 5m ×1.25 / write 1h ×2 / read ×0.1）を導出する。 */
function fromBase(input: number, output: number): ModelPrice {
  return {
    input,
    output,
    cacheWrite: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead: input * 0.1,
    webSearch: WEB_SEARCH,
  };
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

/**
 * fast mode（`speed: "fast"`）の専用価格行。opus 系のみで、世代によって単価が違う。
 * 部分一致の順序が結果を変えるので、より具体的な id を先に並べる。
 */
const FAST_PRICES: ReadonlyArray<readonly [string, ModelPrice]> = [
  ["opus-5", fromBase(10, 50)],
  ["opus-4-8", fromBase(10, 50)],
  ["opus-4-7", fromBase(30, 150)],
  ["opus-4-6", fromBase(30, 150)],
];

export type PriceOverrides = Partial<Record<string, Partial<ModelPrice>>>;

/** `inference_geo: "us"` のときのトークン費用の倍率。 */
const US_GEO_MULTIPLIER = 1.1;

/** モデル文字列を部分一致でファミリ単価に解決する。overrides が最優先。 */
export function priceFor(
  model: string,
  ctx: PricingAttributes,
  overrides?: PriceOverrides,
): ModelPrice {
  const m = model.toLowerCase();
  if (ctx.speed === "fast") {
    for (const [id, price] of FAST_PRICES) {
      if (m.includes(id)) return price;
    }
  }
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

/**
 * cache write の費用。1h TTL 分は cacheWrite1h、残りは 5m 単価で課金する。
 * 内訳（cacheCreation1h）は総量（cacheCreation）を超え得ないので頭打ちにする。
 */
function cacheWriteCost(usage: TokenUsage, ctx: PricingAttributes, p: ModelPrice): number {
  const oneHour = Math.min(ctx.cacheCreation1h, usage.cacheCreation);
  return (oneHour * p.cacheWrite1h + (usage.cacheCreation - oneHour) * p.cacheWrite) / 1_000_000;
}

/** usage のコスト（ドル）。 */
export function costOf(
  usage: TokenUsage,
  model: string,
  ctx: PricingAttributes,
  overrides?: PriceOverrides,
): number {
  const p = priceFor(model, ctx, overrides);
  const tokens =
    (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cacheRead) / 1_000_000 +
    cacheWriteCost(usage, ctx, p);
  const geo = ctx.inferenceGeo === "us" ? US_GEO_MULTIPLIER : 1;
  return tokens * geo + ctx.webSearchRequests * p.webSearch;
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
  ctx: PricingAttributes,
  overrides?: PriceOverrides,
): number {
  if (weighting.mode === "raw") {
    const base = usage.input + usage.output + usage.cacheCreation;
    return weighting.includeCacheRead ? base + usage.cacheRead : base;
  }
  return costOf(usage, model, ctx, overrides);
}
