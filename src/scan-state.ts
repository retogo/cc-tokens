import type { ScanResult } from "./scan.ts";

/**
 * 別の poll/seed 結果 `more` を `into` に統合する。
 * sessionTitles は Scanner 内部で累積された最新スナップショットなので、空でなければ採用する。
 * watch / daemon の両方が同じロジックを共有する（render/ 非依存）。
 */
export function merge(into: ScanResult, more: ScanResult): void {
  for (const r of more.records) into.records.push(r);
  for (const e of more.toolEvents) into.toolEvents.push(e);
  for (const e of more.subagentToolEvents) into.subagentToolEvents.push(e);
  if (more.sessionTitles.size > 0) into.sessionTitles = more.sessionTitles;
}

/**
 * 長期稼働で state 配列が単調増加するのを抑える。
 * 表示は 5h ウィンドウのみなので、cutoffMs より古い要素は捨ててもどの算出にも影響しない。
 * scan.poll() は複数ファイルから append するため ts 単調増加は保証されず、
 * 頭だけ見て早期 return すると後続に潜む古い要素が永続滞留する。空配列のみスキップする。
 * sessionTitles も同様に、cutoff 後に出現しなくなった sessionId を削除して file size 肥大を抑える
 * （daemon は exit しないので、watch と違い titles が単調増加する問題が顕在化する）。
 */
export function pruneState(state: ScanResult, cutoffMs: number): void {
  if (state.records.length > 0) {
    state.records = state.records.filter((r) => r.ts >= cutoffMs);
  }
  if (state.toolEvents.length > 0) {
    state.toolEvents = state.toolEvents.filter((e) => e.ts >= cutoffMs);
  }
  if (state.subagentToolEvents.length > 0) {
    state.subagentToolEvents = state.subagentToolEvents.filter((e) => e.ts >= cutoffMs);
  }
  // pruning 後に残ったレコードに出現する sessionId 集合に sessionTitles を絞り込む。
  // 5h ウィンドウから完全に消えたセッションのタイトル文字列は表示に使われないので捨ててよい。
  if (state.sessionTitles.size > 0) {
    const active = new Set<string>();
    for (const r of state.records) active.add(r.sessionId);
    if (active.size < state.sessionTitles.size) {
      const next = new Map<string, string>();
      for (const [sid, title] of state.sessionTitles) {
        if (active.has(sid)) next.set(sid, title);
      }
      state.sessionTitles = next;
    }
  }
}
