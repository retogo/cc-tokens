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

/** 折れ線 1 本ぶんの入力。x, y は [0..1] の正規化座標。 */
export interface PolylineSeries {
  points: Array<{ x: number; y: number }>;
  /** 線を 3 ドット幅にして実線感を出すか。 */
  thick?: boolean;
  /** 出力する braille char に当てる ANSI 装飾（c.dim など）。 */
  decorate?: (s: string) => string;
}

/**
 * 複数の折れ線を 1 つの braille チャートに合成する。
 * - 各 series の点灯ビットを別グリッドに記録 → セル毎にビット OR → braille 化
 * - overlap セルでは series 配列の先頭側が "色決定権" を取る（過去線を先頭に置けば優先される）
 * - thick=true は描画方向の直交方向 ±1 ドットを追加点灯し、線が実線らしく見える 3 ドット幅にする
 */
export function brailleChart(
  series: PolylineSeries[],
  width: number,
  height: number,
): string[] {
  const subW = 2 * width;
  const subH = 4 * height;
  if (series.length === 0 || width <= 0 || height <= 0) {
    return Array.from({ length: Math.max(0, height) }, () => " ".repeat(Math.max(0, width)));
  }

  const grids: number[][][] = series.map(() =>
    Array.from({ length: subH }, () => Array.from({ length: subW }, () => 0)),
  );

  // braille のドット配置（左列 row0..3 → 0x01,0x02,0x04,0x40 / 右列 → 0x08,0x10,0x20,0x80）
  const dotBit = (col: number, row: number): number => {
    if (row === 3) return col === 0 ? 0x40 : 0x80;
    return col === 0 ? 1 << row : 1 << (row + 3);
  };

  const plotInto = (gridIdx: number, x: number, y: number): void => {
    if (y < 0 || y >= subH || x < 0 || x >= subW) return;
    // biome-ignore lint/style/noNonNullAssertion: 範囲ガード済み
    grids[gridIdx]![y]![x] = 1;
  };

  const toSubX = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * (subW - 1));
  const toSubY = (y: number): number =>
    Math.round((1 - Math.max(0, Math.min(1, y))) * (subH - 1));

  const lineInto = (
    gridIdx: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    thick: boolean,
  ): void => {
    const dx = Math.abs(x2 - x1);
    const sx = x1 < x2 ? 1 : -1;
    const dy = -Math.abs(y2 - y1);
    const sy = y1 < y2 ? 1 : -1;
    // 主軸方向: 横優位なら垂直方向に太らせ、縦優位なら水平方向に太らせる（線の太さが斜めでも均一に近づく）
    const mostlyHorizontal = dx >= -dy;
    let err = dx + dy;
    let x = x1;
    let y = y1;
    const maxSteps = dx - dy + 2;
    let steps = 0;
    while (steps < maxSteps) {
      plotInto(gridIdx, x, y);
      if (thick) {
        if (mostlyHorizontal) {
          plotInto(gridIdx, x, y - 1);
          plotInto(gridIdx, x, y + 1);
        } else {
          plotInto(gridIdx, x - 1, y);
          plotInto(gridIdx, x + 1, y);
        }
      }
      if (x === x2 && y === y2) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
      steps++;
    }
  };

  series.forEach((s, idx) => {
    if (s.points.length === 0) return;
    if (s.points.length === 1) {
      // biome-ignore lint/style/noNonNullAssertion: length===1 ガード
      plotInto(idx, toSubX(s.points[0]!.x), toSubY(s.points[0]!.y));
      return;
    }
    for (let i = 1; i < s.points.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: i は 1..length-1
      const p1 = s.points[i - 1]!;
      // biome-ignore lint/style/noNonNullAssertion: 同上
      const p2 = s.points[i]!;
      lineInto(idx, toSubX(p1.x), toSubY(p1.y), toSubX(p2.x), toSubY(p2.y), s.thick ?? false);
    }
  });

  const lines: string[] = [];
  for (let cy = 0; cy < height; cy++) {
    let line = "";
    for (let cx = 0; cx < width; cx++) {
      let bits = 0;
      let chosenIdx: number | null = null;
      for (let g = 0; g < grids.length; g++) {
        let seriesBits = 0;
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 2; c++) {
            const sy = cy * 4 + r;
            const sx = cx * 2 + c;
            // biome-ignore lint/style/noNonNullAssertion: ループ範囲は grid 内
            if (grids[g]![sy]![sx] === 1) seriesBits |= dotBit(c, r);
          }
        }
        if (seriesBits !== 0) {
          bits |= seriesBits;
          if (chosenIdx === null) chosenIdx = g;
        }
      }
      if (bits === 0) {
        line += " ";
      } else {
        const ch = String.fromCharCode(0x2800 + bits);
        // biome-ignore lint/style/noNonNullAssertion: chosenIdx は bits!=0 のとき必ず非 null
        const dec = chosenIdx !== null ? series[chosenIdx]!.decorate : undefined;
        line += dec ? dec(ch) : ch;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * brailleChart の単一系列ラッパ。values を等間隔配置で 1 本の折れ線として描く（後方互換）。
 * 値は [0..1] のフラクション（クランプ）。values.length ≥ 2 を想定。
 */
export function lineChartBraille(values: number[], width: number, height: number): string[] {
  if (values.length === 0) {
    return Array.from({ length: Math.max(0, height) }, () => " ".repeat(Math.max(0, width)));
  }
  const denom = Math.max(1, values.length - 1);
  // biome-ignore lint/style/noNonNullAssertion: values は length>0 確認済み
  const points = values.map((y, i) => ({ x: values.length === 1 ? 0.5 : i / denom, y: y! }));
  return brailleChart([{ points }], width, height);
}

/**
 * 値配列を多行の line chart に展開する。各列の値は [0..1] のフラクション。
 * 1 行あたり 8 サブステップ（▁▂▃▄▅▆▇█）使って高さを表現するので、5 行構成なら 40 段階の精度が出る。
 * 戻り値は height 行ぶんの文字列。呼び出し側で y軸ラベルや軸線を付ける前提。
 */
export function lineChart(values: number[], height: number): string[] {
  // 1/8〜8/8 の塗り。インデックス 0..7 でサブステップ 1..8 に対応。
  const BLOCKS = "▁▂▃▄▅▆▇█";
  const lines: string[] = [];
  for (let row = 0; row < height; row++) {
    // row=0 が上端。各 cell が担当するサブステップ範囲は [rowBottom, rowBottom+8)。
    const rowBottom = (height - 1 - row) * 8;
    let line = "";
    for (const raw of values) {
      const v = Math.max(0, Math.min(1, raw));
      const totalSubs = Math.round(v * height * 8);
      const sub = totalSubs - rowBottom; // この行内での塗り量（0..8 想定、それ未満/超過は空 or 満タン）
      if (sub >= 8) line += "█";
      else if (sub <= 0) line += " ";
      else {
        // sub は 1..7、BLOCKS[sub-1] で対応する partial block を取る。
        // biome-ignore lint/style/noNonNullAssertion: sub is constrained to 1..7, BLOCKS has 8 chars
        line += BLOCKS[sub - 1]!;
      }
    }
    lines.push(line);
  }
  return lines;
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
