import { configPath } from "./paths.ts";
import type { PriceOverrides, Weighting } from "./pricing.ts";

export interface Config {
  /** 加重指標（既定は生トークン）。 */
  weighting: Weighting;
  /** watch の再描画間隔（秒）。 */
  intervalSec: number;
  /** ウィンドウ長（時間）。 */
  windowHours: number;
  /** モデル別料金の上書き。 */
  priceOverrides: PriceOverrides;
}

export const DEFAULTS: Config = {
  // 既定はトークン基準（サブスク利用ではコスト$は目安に留め、主指標をトークンにする）。
  weighting: { mode: "raw" },
  // データ更新の cadence。再描画自体は別途 1Hz で動くので、ここは "scanner.poll を回す頻度" の意味。
  intervalSec: 5,
  windowHours: 5,
  priceOverrides: {},
};

/**
 * 設定を読み込む。存在しない/壊れている場合は DEFAULTS。
 * ユーザーが手で編集するための読み取り専用設定（weighting / interval / 料金上書き）。
 */
export async function loadConfig(path: string = configPath()): Promise<Config> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return { ...DEFAULTS };
    const data = (await file.json()) as Partial<Config>;
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}
