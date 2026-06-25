/** 端末描画用の純粋な整形ヘルパ。 */

const SPARK = "▁▂▃▄▅▆▇█";
const FILL = "█";
const EMPTY = "░";
// 内訳テーブル用の軽量バー: 主シグナルは数値とパーセントなので、empty は最小の点で済ませる。
const LIGHT_EMPTY = "·";

/** トークン数を 12.3k / 1.25M に丸める。 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** ドル表記。小額は 3 桁、$1 以上は 2 桁。 */
export function formatUSD(n: number): string {
  return n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

/** 経過/残り時間を h/m/s に整形。0 以下は "now"。 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** 充填バー。fraction は 0..1 にクランプ。 */
export function bar(fraction: number, width: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return FILL.repeat(filled) + EMPTY.repeat(width - filled);
}

/**
 * 内訳テーブル用の軽量バー。filled / empty を分離して返すので、呼び出し側で
 * 塗り部分だけ強調色を当てて空白部分は dim にできる（視覚的な階層を作るため）。
 */
export function barParts(fraction: number, width: number): { filled: string; empty: string } {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return {
    filled: FILL.repeat(filled),
    empty: LIGHT_EMPTY.repeat(width - filled),
  };
}

/** 値配列を 8 段階のスパークラインへ。 */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  return values
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (SPARK.length - 1));
      return SPARK[idx];
    })
    .join("");
}

/** ANSI 色（NO_COLOR / 非 TTY で自動無効）。 */
const useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false;
function wrap(code: number): (s: string) => string {
  return (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
}
export const color = {
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  bold: wrap(1),
};

/** 使用率に応じた色（緑→黄→赤）。 */
export function gaugeColor(fraction: number): (s: string) => string {
  if (fraction >= 0.9) return color.red;
  if (fraction >= 0.7) return color.yellow;
  return color.green;
}

/**
 * 株価ティッカー風の変化色付け。フレーム間で同一キーの値を比較し、
 * 増加=緑▲ / 減少=赤▼ / 不変=そのまま で着色する。初回（前回値なし）は着色しない。
 * 各キーは 1 フレームにつき 1 回だけ fmt を呼ぶ前提（呼んだ時点で前回値を更新）。
 *
 * arrow=true のときは「変化マーカーのスロット（1 文字幅）」を常に確保する。
 * 不変時はスロットをスペースで埋めるので、▲/▼ が出ても後続テキストが右にズレない。
 */
export class Ticker {
  private prev = new Map<string, number>();

  fmt(key: string, value: number, text: string, arrow = true): string {
    const p = this.prev.get(key);
    this.prev.set(key, value);
    if (p === undefined || value === p) {
      // 初回 or 変化無し: 三角と同じ 1 文字幅のスペースを足してレイアウトを固定する。
      return arrow ? `${text} ` : text;
    }
    const up = value > p;
    if (!arrow) return (up ? color.green : color.red)(text);
    return (up ? color.green : color.red)(text + (up ? "▲" : "▼"));
  }
}
