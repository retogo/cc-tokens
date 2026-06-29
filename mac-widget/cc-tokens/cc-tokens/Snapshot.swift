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

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case generatedAt = "generated_at"
        case snapshot
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
