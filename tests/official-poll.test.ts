import { describe, expect, test } from "bun:test";
import { createOfficialPoller, OFFICIAL_MIN_GAP_MS } from "../src/official-poll.ts";
import type { OfficialUsage } from "../src/official.ts";
import { OfficialFetchError } from "../src/official.ts";

/** 直近 fetchedAt を持つだけの空の OfficialUsage。値の中身はテスト用に最小限。 */
function ok(fetchedAt: number): OfficialUsage {
  return { fiveHour: null, sevenDay: null, limits: [], fetchedAt };
}

describe("createOfficialPoller", () => {
  test("enabled:false ではどの呼び出しも no-op で state は更新されない", async () => {
    const poller = createOfficialPoller({
      enabled: false,
      fetchNow: () => Promise.resolve(ok(123)),
    });
    expect(poller.shouldRefresh(Date.now())).toBe(false);
    await poller.refresh();
    expect(poller.state.official).toBe(null);
    expect(poller.state.error).toBe(null);
  });

  test("成功すると official を更新し error をクリアする", async () => {
    let calls = 0;
    const poller = createOfficialPoller({
      enabled: true,
      fetchNow: async () => {
        calls += 1;
        return ok(1000 + calls);
      },
    });
    await poller.refresh();
    expect(poller.state.official?.fetchedAt).toBe(1001);
    expect(poller.state.error).toBe(null);
    // lastFetchAt / nextRetryAt も成功時に確定する
    expect(poller.state.lastFetchAt).not.toBeNull();
    expect(poller.state.nextRetryAt).not.toBeNull();
  });

  test("失敗時は lastFetchAt は更新せず nextRetryAt は未来時刻に倒す", async () => {
    let n = 0;
    const poller = createOfficialPoller({
      enabled: true,
      fetchNow: async () => {
        n += 1;
        if (n === 1) return ok(7777);
        throw new OfficialFetchError("HTTP 500", 500);
      },
    });
    await poller.refresh(); // 成功
    const fetchedAtOnSuccess = poller.state.lastFetchAt;
    expect(fetchedAtOnSuccess).not.toBeNull();
    await poller.refresh(); // 失敗
    // lastFetchAt は成功時のまま（失敗で更新しない）
    expect(poller.state.lastFetchAt).toBe(fetchedAtOnSuccess);
    // nextRetryAt は再試行予定時刻が入っている
    expect(poller.state.nextRetryAt).not.toBeNull();
    expect(poller.state.nextRetryAt!).toBeGreaterThan(Date.now() - 1);
  });

  test("失敗時は前回値を保持し error を立てる（official は消さない）", async () => {
    let n = 0;
    const poller = createOfficialPoller({
      enabled: true,
      fetchNow: async () => {
        n += 1;
        if (n === 1) return ok(999);
        throw new OfficialFetchError("HTTP 500", 500);
      },
    });
    await poller.refresh(); // 成功
    expect(poller.state.official?.fetchedAt).toBe(999);
    await poller.refresh(); // 失敗
    // official は前回値が残る
    expect(poller.state.official?.fetchedAt).toBe(999);
    expect(poller.state.error).toContain("500");
  });

  test("Retry-After: 0 は明示的に尊重し、MIN_GAP（30s）を最低値として待つ（180s 待たない）", async () => {
    // Retry-After=0 を falsy 扱いしてバックオフ 180s で潰す古い実装の退行検知。
    const poller = createOfficialPoller({
      enabled: true,
      fetchNow: async () => {
        throw new OfficialFetchError("HTTP 429", 429, 0); // Retry-After: 0
      },
    });
    const before = Date.now();
    await poller.refresh();
    // nextAt は MIN_GAP（30s）程度であって、180s（OFFICIAL_REFRESH_MS）になっていないこと。
    // shouldRefresh(before + MIN_GAP + 100) で true になる == 30s 過ぎたら再試行 OK。
    expect(poller.shouldRefresh(before + OFFICIAL_MIN_GAP_MS + 100)).toBe(true);
    // ただし MIN_GAP より前は false（暴走防止）。
    expect(poller.shouldRefresh(before + OFFICIAL_MIN_GAP_MS / 2)).toBe(false);
  });

  test("成功直後は OFFICIAL_REFRESH_MS（180s）まで shouldRefresh が false", async () => {
    const poller = createOfficialPoller({
      enabled: true,
      fetchNow: async () => ok(1),
    });
    const before = Date.now();
    await poller.refresh();
    expect(poller.shouldRefresh(before + 60_000)).toBe(false);
    expect(poller.shouldRefresh(before + 180_001)).toBe(true);
  });

  test("refreshManually は backoff をリセットして即座に再試行できる", async () => {
    let n = 0;
    const poller = createOfficialPoller({
      enabled: true,
      fetchNow: async () => {
        n += 1;
        if (n === 1) throw new OfficialFetchError("HTTP 500", 500);
        return ok(42);
      },
    });
    await poller.refresh();
    expect(poller.state.error).not.toBe(null);
    await poller.refreshManually();
    expect(poller.state.official?.fetchedAt).toBe(42);
    expect(poller.state.error).toBe(null);
  });

  test("並列 refresh 呼び出しは 1 回の fetch にまとまる（同時実行を抑える）", async () => {
    let calls = 0;
    let resolveFetch: (v: OfficialUsage) => void = () => {};
    const poller = createOfficialPoller({
      enabled: true,
      fetchNow: () => {
        calls += 1;
        return new Promise<OfficialUsage>((resolve) => {
          resolveFetch = resolve;
        });
      },
    });
    const p1 = poller.refresh();
    const p2 = poller.refresh();
    // 1 度しか fetch が始まらない
    expect(calls).toBe(1);
    resolveFetch(ok(7));
    await Promise.all([p1, p2]);
    expect(poller.state.official?.fetchedAt).toBe(7);
  });

  test("onError コールバックは失敗時のメッセージで呼ばれる", async () => {
    const messages: string[] = [];
    const poller = createOfficialPoller({
      enabled: true,
      fetchNow: async () => {
        throw new OfficialFetchError("HTTP 503");
      },
      onError: (msg) => messages.push(msg),
    });
    await poller.refresh();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("503");
  });
});
