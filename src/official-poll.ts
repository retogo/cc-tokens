import type { OfficialUsage } from "./official.ts";
import { fetchOfficialUsage, OfficialFetchError } from "./official.ts";

/** 通常の再取得周期（ミリ秒）。成功後はこの間隔まで間を空けて再取得する。 */
export const OFFICIAL_REFRESH_MS = 180_000;
/** 失敗時バックオフの上限（ミリ秒）。指数バックオフはここでクランプする。 */
export const OFFICIAL_BACKOFF_MAX_MS = 15 * 60_000;
/**
 * 失敗時バックオフの初期値（ミリ秒）。
 * OFFICIAL_REFRESH_MS（180s）と同じ値だと初回失敗で 3 分間 official=null が続くため、
 * 初期は短くしておいて指数バックオフで上限まで伸ばす設計（連続失敗だけ間を空ける）。
 */
export const OFFICIAL_BACKOFF_INITIAL_MS = 5_000;
/**
 * 失敗時の『最低 fetch 間隔』。Retry-After: 0 などのサーバ指示でもこれより短くは再試行しない。
 * 通常周期 OFFICIAL_REFRESH_MS とは別のセマンティクス（レートリミット意図）。
 */
export const OFFICIAL_MIN_GAP_MS = 30_000;

/** 取得状態のスナップショット（読み取り専用ビュー）。watch の rebuild で表示するため。 */
export interface OfficialPollerState {
  /** 直近成功時の取得値（前回値を残す。失敗中でも消さない）。 */
  official: OfficialUsage | null;
  /** 直近失敗のエラーメッセージ。成功時は null にリセットされる。 */
  error: string | null;
}

/** poller の制御 API。watch / daemon の両方が同じインタフェースを使う。 */
export interface OfficialPoller {
  /** 現在の状態（official 値と最終エラー）。 */
  readonly state: OfficialPollerState;
  /**
   * 次回 refresh が必要か。「最後の成功 or 失敗」から計算した次回時刻を今が過ぎたかを返す。
   * ループ側はこれで refresh() を呼ぶかどうかだけ判断する。
   */
  shouldRefresh(now: number): boolean;
  /** API を叩き、成功なら state を更新、失敗なら error を更新して次回時刻を後ろにずらす。 */
  refresh(): Promise<void>;
  /**
   * 手動 refresh（watch の "r" キー用）。失敗時のバックオフをリセットして即時 refresh する。
   * 多重呼び出しは内部で直列化される（同時 fetch を抑える）。
   */
  refreshManually(): Promise<void>;
}

/**
 * createOfficialPoller: /api/oauth/usage の取得と失敗時バックオフを 1 箇所に集約する factory。
 * - 成功すると nextAt = now + OFFICIAL_REFRESH_MS
 * - 失敗すると Retry-After（あれば、0 を含む明示値も尊重）と OFFICIAL_MIN_GAP_MS の大きい方を待つ
 * - 401 は backoff を伸ばさず（ユーザの再ログイン直後に古い表示が残らないよう短間隔で再試行）
 * - その他のエラーは指数バックオフ（初期 OFFICIAL_BACKOFF_INITIAL_MS → 上限 OFFICIAL_BACKOFF_MAX_MS）
 *
 * onError は watch のように UI 注記が必要な場合に渡す（daemon は stderr に書くハンドラを渡す）。
 */
export function createOfficialPoller(opts: {
  enabled: boolean;
  fetchNow?: () => Promise<OfficialUsage>;
  onError?: (msg: string) => void;
}): OfficialPoller {
  const fetchFn = opts.fetchNow ?? (() => fetchOfficialUsage(Date.now()));
  const state: OfficialPollerState = { official: null, error: null };
  let nextAt = 0;
  let backoffMs = OFFICIAL_BACKOFF_INITIAL_MS;
  // 並列 refresh を抑制するロック（手動 r キー連打や race を防ぐ）。
  let inflight: Promise<void> | null = null;

  const doRefresh = async (): Promise<void> => {
    if (!opts.enabled) return;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        state.official = await fetchFn();
        state.error = null;
        backoffMs = OFFICIAL_BACKOFF_INITIAL_MS;
        nextAt = Date.now() + OFFICIAL_REFRESH_MS;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        state.error = msg;
        if (opts.onError) opts.onError(msg);
        const is401 = e instanceof OfficialFetchError && e.status === 401;
        // Retry-After: 0 はサーバが「今すぐ良い」を意味するので falsy 扱いしない。
        // 明示的に !== undefined で見分ける。
        const retryAfter =
          e instanceof OfficialFetchError && e.retryAfterMs !== undefined
            ? e.retryAfterMs
            : undefined;
        if (!is401) {
          backoffMs = Math.min(backoffMs * 2, OFFICIAL_BACKOFF_MAX_MS);
        }
        // 待ち時間: 401 は通常周期 / 他はサーバヒント or 指数バックオフ。
        // どのケースでも MIN_GAP を最低保証して暴走を防ぐ。
        let wait: number;
        if (is401) {
          wait = OFFICIAL_REFRESH_MS;
        } else if (retryAfter !== undefined) {
          wait = Math.max(retryAfter, OFFICIAL_MIN_GAP_MS);
        } else {
          wait = Math.max(backoffMs, OFFICIAL_MIN_GAP_MS);
        }
        nextAt = Date.now() + wait;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  return {
    state,
    shouldRefresh: (now) => opts.enabled && now >= nextAt,
    refresh: doRefresh,
    refreshManually: async () => {
      backoffMs = OFFICIAL_BACKOFF_INITIAL_MS;
      nextAt = 0;
      await doRefresh();
    },
  };
}
