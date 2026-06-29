//
//  Snapshot.swift
//  cc-tokens
//
//  cctok daemon が `<path>.tmp` → rename(2) で atomic に書き出す JSON の Swift 側コントラクト。
//  TS 側の Snapshot 型に対応するのは src/snapshot.ts / src/daemon.ts (SerializedSnapshot)。
//  schema_version が増えた時は対応する CodingKey / プロパティを追従させる。
//

import Foundation

struct EmitPayload: Decodable {
    let schemaVersion: Int
    let generatedAt: String
    let snapshot: Snapshot
    /// daemon v1.1 で追加された optional フィールド。古い payload を読む可能性に備えて optional。
    let apiStatus: ApiStatus?

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case generatedAt = "generated_at"
        case snapshot
        case apiStatus = "api_status"
    }
}

/// 公式 API (/api/oauth/usage) の取得状態。429 / 401 / network エラーで
/// % / reset / cumul が null に倒れた理由を panel に表示するために使う。
struct ApiStatus: Decodable {
    /// --official が有効か。--local 起動だと常に false。
    let enabled: Bool
    /// 直近 fetch が成功し、かつ value を保持しているか。
    let ok: Bool
    /// 最終エラーメッセージ。成功時 / 未取得時は null。
    let error: String?
    /// 直近成功 fetch の時刻 (epoch ms)。一度も成功していなければ null。
    let lastFetchAt: Double?
    /// 次回 refresh の予定時刻 (epoch ms)。enabled=false / 起動直後は null。
    let nextRetryAt: Double?

    enum CodingKeys: String, CodingKey {
        case enabled
        case ok
        case error
        case lastFetchAt = "last_fetch_at"
        case nextRetryAt = "next_retry_at"
    }
}

struct Snapshot: Decodable {
    /// 集計の参照時刻 (epoch ms)。
    let now: Double
    let windowMs: Double
    /// ウィンドウ開始 (epoch ms)。official があれば resets_at - 5h、無ければ now - 5h。
    let windowStart: Double
    let hasActivity: Bool
    let turns: Int
    /// 加重消費 (重みは config.weighting に依存。input+output+cache の重み付き合計)。
    let usedWeighted: Double
    /// API の utilization (％)。--official が無効・取得失敗時は null。
    let pct: Double?
    let totals: Totals
    let cost: Double
    let burnWindow: BurnRate
    /// 直近 1 分の瞬間バーン。スパイク検出用。
    let burn1m: BurnRate
    let burn10: BurnRate
    let burnHour: BurnRate
    let budgetBurnPerMin: Double?
    let projection: Projection?
    /// 真のリセット時刻 (epoch ms)。API 取得時のみ。
    let resetTs: Double?
    /// 予測に使う limit。API の utilization と現在消費から逆算。
    let effectiveLimit: Double?
    /// 累積使用率の折れ線データ。effectiveLimit が無いと % に意味がないので null になる。
    let cumul: CumulData?
}

/// cumul チャート用のデータ。
/// x,y は [0..1] 正規化 (x: windowStart=0, windowEnd=1 / y: 0%=0, 100%=1)。
/// start/end は epoch ms。表示時に x → 実時刻に逆変換する。
struct CumulData: Decodable {
    let past: [CumulPoint]
    let prediction: [CumulPoint]
    let start: Double
    let end: Double
}

struct CumulPoint: Decodable, Hashable {
    let x: Double
    let y: Double
}

struct Totals: Decodable {
    let input: Int
    let output: Int
    let cacheCreation: Int
    let cacheRead: Int
}

/// バーンレート (重み付き / 生 token の両方を持つ)。
struct BurnRate: Decodable {
    let weightedPerMin: Double
    let rawPerMin: Double
}

/// 枯渇予測 (このバーンが続いた場合)。
struct Projection: Decodable {
    /// 枯渇予測時刻 (epoch ms)。limit 未設定 or burn=0 の時は null。
    let exhaustionTs: Double?
    /// ウィンドウ終端での加重トークン着地予測。
    let projectedWeightedAtWindowEnd: Double
}
