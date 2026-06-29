import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.ts";
import {
  buildEmitPayload,
  emitOnce,
  runDaemon,
  SCHEMA_VERSION,
  serializeSnapshot,
} from "../src/daemon.ts";
import { Scanner } from "../src/scan.ts";
import { buildSnapshot } from "../src/snapshot.ts";

/** Bun 環境で動かしている前提なので process.platform を直接見て darwin/linux 判定。 */
const IS_POSIX = process.platform !== "win32";

const FIX = join(import.meta.dir, "..", "fixtures", "projects");
const NOW = Date.parse("2026-06-18T00:02:00.000Z");

async function makeSnapshot() {
  const sc = new Scanner(FIX);
  const scan = await sc.seed();
  return buildSnapshot(scan, DEFAULTS, NOW, null);
}

/** scratch ディレクトリを作って後始末する。 */
function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "cctok-daemon-test-"));
  return fn(dir).finally(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
}

describe("SCHEMA_VERSION", () => {
  test("contract version is 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

describe("serializeSnapshot", () => {
  test("converts sessionTitles Map into a plain object keyed by sessionId", async () => {
    const snap = await makeSnapshot();
    snap.sessionTitles.set("sess-1", "Title One");
    snap.sessionTitles.set("sess-2", "Title Two");
    const serialized = serializeSnapshot(snap) as unknown as Record<string, unknown>;
    expect(serialized.sessionTitles).toEqual({
      "sess-1": "Title One",
      "sess-2": "Title Two",
    });
    // Map ではなく plain object であること
    expect(serialized.sessionTitles instanceof Map).toBe(false);
  });

  test("preserves the main Snapshot fields", async () => {
    const snap = await makeSnapshot();
    const s = serializeSnapshot(snap) as unknown as Record<string, unknown>;
    expect(s.now).toBe(snap.now);
    expect(s.windowMs).toBe(snap.windowMs);
    expect(s.windowStart).toBe(snap.windowStart);
    expect(s.hasActivity).toBe(snap.hasActivity);
    expect(s.turns).toBe(snap.turns);
    expect(s.totals).toEqual(snap.totals);
    expect(s.usedWeighted).toBe(snap.usedWeighted);
    expect(s.burnWindow).toEqual(snap.burnWindow);
    expect(s.breakdowns).toBeDefined();
  });

  test("round-trips through JSON.stringify without losing sessionTitles", async () => {
    const snap = await makeSnapshot();
    snap.sessionTitles.set("sess-a", "Alpha");
    const payload = buildEmitPayload(snap, Date.now());
    const text = JSON.stringify(payload);
    const decoded = JSON.parse(text);
    expect(decoded.snapshot.sessionTitles).toEqual({ "sess-a": "Alpha" });
  });

  test("JSON round-trip preserves all advertised contract fields (no Map/Set leakage)", async () => {
    // SCHEMA_VERSION=1 のコントラクトに乗っている全フィールドを deep-equal で照合する。
    // Snapshot に新フィールドが入った瞬間に serializeSnapshot の satisfies と本テストの両方が落ちて、
    // SCHEMA_VERSION の bump 判断を促すゲートとして機能する。
    const snap = await makeSnapshot();
    snap.sessionTitles.set("sess-x", "Xray");
    const payload = buildEmitPayload(snap, NOW);
    const decoded = JSON.parse(JSON.stringify(payload));
    // schema_version と generated_at の型保証
    expect(decoded.schema_version).toBe(1);
    expect(typeof decoded.generated_at).toBe("string");
    // snapshot.* の主要フィールドを 1 件ずつ deep-equal で確認（Map/Set 漏れがあると {} になる）
    const s = decoded.snapshot;
    expect(s.now).toBe(snap.now);
    expect(s.windowMs).toBe(snap.windowMs);
    expect(s.windowStart).toBe(snap.windowStart);
    expect(s.hasActivity).toBe(snap.hasActivity);
    expect(s.turns).toBe(snap.turns);
    expect(s.usedWeighted).toBe(snap.usedWeighted);
    expect(s.pct).toBe(snap.pct);
    expect(s.totals).toEqual(snap.totals);
    expect(s.cost).toBe(snap.cost);
    expect(s.burnWindow).toEqual(snap.burnWindow);
    expect(s.burn1m).toEqual(snap.burn1m);
    expect(s.burn10).toEqual(snap.burn10);
    expect(s.burnHour).toEqual(snap.burnHour);
    expect(s.budgetBurnPerMin).toBe(snap.budgetBurnPerMin);
    expect(s.projection).toEqual(snap.projection);
    expect(s.breakdowns).toBeDefined();
    expect(s.sessionTitles).toEqual({ "sess-x": "Xray" });
    expect(s.cumul).toEqual(snap.cumul);
    expect(s.official).toBe(null);
    expect(s.resetTs).toBe(snap.resetTs);
    expect(s.effectiveLimit).toBe(snap.effectiveLimit);
  });
});

describe("buildEmitPayload", () => {
  test("returns { schema_version: 1, generated_at: ISO string, snapshot }", async () => {
    const snap = await makeSnapshot();
    const generatedAtMs = Date.parse("2026-06-18T00:03:00.000Z");
    const payload = buildEmitPayload(snap, generatedAtMs);
    expect(payload.schema_version).toBe(1);
    expect(payload.generated_at).toBe(new Date(generatedAtMs).toISOString());
    expect(payload.snapshot).toBeDefined();
  });
});

describe("emitOnce（atomic write: tmp → rename）", () => {
  test("writes the payload as JSON at the given path", async () => {
    await withTmp(async (dir) => {
      const path = join(dir, "snapshot.json");
      const snap = await makeSnapshot();
      const payload = buildEmitPayload(snap, NOW);
      await emitOnce(payload, path);
      const file = Bun.file(path);
      expect(await file.exists()).toBe(true);
      const data = await file.json();
      expect(data.schema_version).toBe(1);
      expect(data.snapshot.windowMs).toBe(snap.windowMs);
    });
  });

  test("removes the .tmp file once rename completes", async () => {
    await withTmp(async (dir) => {
      const path = join(dir, "snapshot.json");
      const snap = await makeSnapshot();
      const payload = buildEmitPayload(snap, NOW);
      await emitOnce(payload, path);
      const tmp = Bun.file(`${path}.tmp`);
      expect(await tmp.exists()).toBe(false);
    });
  });

  test("overwrites an existing file atomically", async () => {
    await withTmp(async (dir) => {
      const path = join(dir, "snapshot.json");
      const snap = await makeSnapshot();
      await emitOnce(buildEmitPayload(snap, NOW), path);
      const first = await Bun.file(path).json();
      // 2 度目を別 generated_at で書き、上書きが効くこと
      const later = NOW + 60_000;
      await emitOnce(buildEmitPayload(snap, later), path);
      const second = await Bun.file(path).json();
      expect(second.generated_at).not.toBe(first.generated_at);
      expect(second.generated_at).toBe(new Date(later).toISOString());
    });
  });

  test("writes the file with mode 0600 (owner-only readable)", async () => {
    if (!IS_POSIX) return; // Windows では mode bits の意味が違うので skip
    await withTmp(async (dir) => {
      const path = join(dir, "snapshot.json");
      const snap = await makeSnapshot();
      await emitOnce(buildEmitPayload(snap, NOW), path);
      const st = await stat(path);
      // 下位 9 bit のうち owner read/write のみが立っていること（0o600）
      const perm = st.mode & 0o777;
      expect(perm).toBe(0o600);
    });
  });
});

describe("runDaemon", () => {
  test("emits snapshots on the configured interval and stops cleanly", async () => {
    await withTmp(async (dir) => {
      const path = join(dir, "snapshot.json");
      const ctrl = runDaemon(FIX, DEFAULTS, {
        emitPath: path,
        intervalMs: 50,
        official: false,
      });
      // 最初の emit を待つ。100ms 程度あれば 1〜2 回回る。
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (await Bun.file(path).exists()) break;
        await Bun.sleep(20);
      }
      expect(await Bun.file(path).exists()).toBe(true);

      const firstStat = await stat(path);
      const firstMtime = firstStat.mtimeMs;
      // interval を反映するのを確認するため 200ms 程度待ち、mtime が動いていること
      await Bun.sleep(250);
      const secondStat = await stat(path);
      expect(secondStat.mtimeMs).toBeGreaterThan(firstMtime);

      await ctrl.stop();
      // 停止後に .tmp が残らないこと
      expect(await Bun.file(`${path}.tmp`).exists()).toBe(false);
    });
  });

  test("longer interval emits fewer times in the same window", async () => {
    await withTmp(async (dir) => {
      const path = join(dir, "snapshot.json");
      const ctrl = runDaemon(FIX, DEFAULTS, {
        emitPath: path,
        intervalMs: 300,
        official: false,
      });
      // 最初の emit を待つ
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (await Bun.file(path).exists()) break;
        await Bun.sleep(20);
      }
      const firstStat = await stat(path);
      const firstMtime = firstStat.mtimeMs;
      // 100ms（< interval 300ms）では mtime が動かない
      await Bun.sleep(100);
      const midStat = await stat(path);
      expect(midStat.mtimeMs).toBe(firstMtime);
      await ctrl.stop();
    });
  });

  test("stop() resolves and leaves no .tmp behind even on rapid stop", async () => {
    await withTmp(async (dir) => {
      const path = join(dir, "snapshot.json");
      const ctrl = runDaemon(FIX, DEFAULTS, {
        emitPath: path,
        intervalMs: 50,
        official: false,
      });
      // 最初の seed が終わる前に止めにかかる可能性もあるが、stop() は必ず resolve する
      await ctrl.stop();
      expect(await Bun.file(`${path}.tmp`).exists()).toBe(false);
    });
  });

  test("aborted signal before start prevents any emit (no snapshot.json)", async () => {
    // stop シグナルが seed 完了より先に来た場合、spurious な 1 回 emit を出さない。
    // 受理 finding『stop シグナル後でも seed 完了→1 回 emit が走る経路』の退行検知。
    await withTmp(async (dir) => {
      const path = join(dir, "snapshot.json");
      const aborter = new AbortController();
      aborter.abort(); // 開始前に abort 済み
      const ctrl = runDaemon(FIX, DEFAULTS, {
        emitPath: path,
        intervalMs: 50,
        official: false,
        signal: aborter.signal,
      });
      await ctrl.done;
      expect(await Bun.file(path).exists()).toBe(false);
      expect(await Bun.file(`${path}.tmp`).exists()).toBe(false);
    });
  });

  test("AbortSignal stops the loop (no more emits after abort)", async () => {
    await withTmp(async (dir) => {
      const path = join(dir, "snapshot.json");
      const aborter = new AbortController();
      const ctrl = runDaemon(FIX, DEFAULTS, {
        emitPath: path,
        intervalMs: 50,
        official: false,
        signal: aborter.signal,
      });
      // 最初の emit を待つ
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (await Bun.file(path).exists()) break;
        await Bun.sleep(20);
      }
      expect(await Bun.file(path).exists()).toBe(true);
      aborter.abort();
      await ctrl.done;
      // abort 後の mtime は動かない（ループは止まっている）
      const stoppedAt = (await stat(path)).mtimeMs;
      await Bun.sleep(150);
      const laterMtime = (await stat(path)).mtimeMs;
      expect(laterMtime).toBe(stoppedAt);
      expect(await Bun.file(`${path}.tmp`).exists()).toBe(false);
    });
  });
});
