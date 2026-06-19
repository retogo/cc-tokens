import { join } from "node:path";
import { claudeConfigDir } from "./paths.ts";

/**
 * Claude Code の `/usage` が叩く公式エンドポイント。
 * GET /api/oauth/usage（OAuth Bearer）。five_hour / seven_day の utilization と
 * resets_at（真のリセット時刻）を返す。
 */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const BETA = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface OfficialWindow {
  utilization: number;
  resetsAt: number;
}

export interface OfficialLimit {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resetsAt: number | null;
  /** scope.model.display_name など（無ければ null）。 */
  scopeLabel: string | null;
  isActive: boolean;
}

export interface OfficialUsage {
  fiveHour: OfficialWindow | null;
  sevenDay: OfficialWindow | null;
  limits: OfficialLimit[];
  fetchedAt: number;
}

function parseTs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseWindow(v: unknown): OfficialWindow | null {
  if (!isRecord(v) || typeof v.utilization !== "number") return null;
  const resetsAt = parseTs(v.resets_at);
  if (resetsAt === null) return null;
  return { utilization: v.utilization, resetsAt };
}

/** /api/oauth/usage のレスポンス JSON を正規化する（null/欠落に強い）。 */
export function parseOfficialUsage(raw: unknown, fetchedAt: number): OfficialUsage {
  const r = isRecord(raw) ? raw : {};
  const limits: OfficialLimit[] = Array.isArray(r.limits)
    ? r.limits.map((l: unknown) => {
        const lr = isRecord(l) ? l : {};
        const scope = isRecord(lr.scope) ? lr.scope : {};
        const model = isRecord(scope.model) ? scope.model : {};
        return {
          kind: String(lr.kind ?? ""),
          group: String(lr.group ?? ""),
          percent: typeof lr.percent === "number" ? lr.percent : 0,
          severity: String(lr.severity ?? "normal"),
          resetsAt: parseTs(lr.resets_at),
          scopeLabel: typeof model.display_name === "string" ? model.display_name : null,
          isActive: lr.is_active === true,
        };
      })
    : [];
  return {
    fiveHour: parseWindow(r.five_hour),
    sevenDay: parseWindow(r.seven_day),
    limits,
    fetchedAt,
  };
}

/**
 * OAuth アクセストークンを取得する。
 * macOS は Keychain（"Claude Code-credentials"）を優先し、無ければ
 * ~/.claude/.credentials.json にフォールバックする。
 */
export async function getOAuthToken(): Promise<string | null> {
  // 1) macOS Keychain
  if (process.platform === "darwin") {
    try {
      const proc = Bun.spawn(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      const token = tokenFromJson(out);
      if (token) return token;
    } catch {
      // フォールバックへ
    }
  }
  // 2) credentials.json
  try {
    const file = Bun.file(join(claudeConfigDir(), ".credentials.json"));
    if (await file.exists()) {
      const token = tokenFromJson(await file.text());
      if (token) return token;
    }
  } catch {
    // なし
  }
  return null;
}

function tokenFromJson(text: string): string | null {
  try {
    const d = JSON.parse(text);
    const o = d?.claudeAiOauth ?? d;
    return o?.accessToken ?? o?.access_token ?? null;
  } catch {
    return null;
  }
}

export class OfficialFetchError extends Error {
  constructor(
    message: string,
    /** HTTP ステータス（あれば）。 */
    readonly status?: number,
    /** 429 の Retry-After（ミリ秒、あれば）。 */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Retry-After ヘッダ（秒 or HTTP-date）をミリ秒に。無ければ undefined。 */
function parseRetryAfter(res: Response): number | undefined {
  const v = res.headers.get("retry-after");
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** API usage をライブ取得する。トークン無し/401/429/ネットワーク不可は例外。 */
export async function fetchOfficialUsage(now: number): Promise<OfficialUsage> {
  const token = await getOAuthToken();
  if (!token) {
    throw new OfficialFetchError("OAuth token not found (Keychain / ~/.claude/.credentials.json)");
  }
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "anthropic-beta": BETA,
      "User-Agent": "cctok/0.1.0",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new OfficialFetchError(
        "401 Unauthorized (token expired — launch claude once to refresh)",
        401,
      );
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res);
      const hint = retryAfterMs ? ` (retry in ${Math.ceil(retryAfterMs / 1000)}s)` : "";
      throw new OfficialFetchError(`HTTP 429 rate limited${hint}`, 429, retryAfterMs);
    }
    throw new OfficialFetchError(`HTTP ${res.status}`, res.status);
  }
  return parseOfficialUsage(await res.json(), now);
}
