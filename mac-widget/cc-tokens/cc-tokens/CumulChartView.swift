//
//  CumulChartView.swift
//  cc-tokens
//
//  Snapshot.cumul (past + prediction の折れ線) を Swift Charts で描く。
//  TUI 版 (render/bars.ts の Cumul) の文字セル表現を、smooth な線・面・閾値線で再構成する。
//  Past は塗りつぶしエリア + 実線、Prediction はダッシュ、100% は赤の点線。
//

import SwiftUI
import Charts

struct CumulChartView: View {

    let cumul: CumulData

    var body: some View {
        Chart {
            // Past: 塗りつぶしエリア (累積使用率のボリュームを視覚化)。
            ForEach(cumul.past, id: \.x) { p in
                AreaMark(
                    x: .value("Time", time(at: p.x)),
                    y: .value("Usage", p.y * 100)
                )
                .foregroundStyle(
                    LinearGradient(
                        colors: [Color.accentColor.opacity(0.35), Color.accentColor.opacity(0.03)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .interpolationMethod(.monotone)
            }

            // Past: 実線。series を明示しないと AreaMark と統合されて線が消える。
            ForEach(cumul.past, id: \.x) { p in
                LineMark(
                    x: .value("Time", time(at: p.x)),
                    y: .value("Usage", p.y * 100),
                    series: .value("series", "past")
                )
                .foregroundStyle(Color.accentColor)
                .lineStyle(StrokeStyle(lineWidth: 2))
                .interpolationMethod(.monotone)
            }

            // Prediction: 将来軌道を破線で。past とは別 series として独立した線にする。
            ForEach(cumul.prediction, id: \.x) { p in
                LineMark(
                    x: .value("Time", time(at: p.x)),
                    y: .value("Usage", p.y * 100),
                    series: .value("series", "prediction")
                )
                .foregroundStyle(.orange)
                .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                .interpolationMethod(.monotone)
            }

            // 100% 閾値の赤い点線。
            RuleMark(y: .value("Limit", 100.0))
                .foregroundStyle(.red.opacity(0.55))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 2]))

            // "now" 位置のドット (past 最後の点)。境界を明示する。
            if let last = cumul.past.last {
                PointMark(
                    x: .value("Now", time(at: last.x)),
                    y: .value("Usage", last.y * 100)
                )
                .foregroundStyle(Color.accentColor)
                .symbolSize(48)
            }
        }
        .chartYScale(domain: 0...110)
        .chartXAxis {
            // 5h ウィンドウなら 5-6 個程度の hour mark が出る。
            AxisMarks(values: .stride(by: .hour)) { _ in
                AxisGridLine()
                    .foregroundStyle(Color.gray.opacity(0.18))
                AxisTick()
                    .foregroundStyle(Color.gray.opacity(0.3))
                AxisValueLabel(format: .dateTime.hour(.defaultDigits(amPM: .omitted)))
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
        }
        .chartYAxis {
            AxisMarks(values: [0, 50, 100]) { value in
                AxisGridLine()
                    .foregroundStyle(Color.gray.opacity(0.18))
                AxisValueLabel {
                    if let v = value.as(Double.self) {
                        Text("\(Int(v))%")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .frame(height: 110)
    }

    /// 正規化 x (windowStart=0, windowEnd=1) を実時刻 (Date) に逆変換する。
    /// start/end は epoch ms。
    private func time(at x: Double) -> Date {
        let ms = cumul.start + x * (cumul.end - cumul.start)
        return Date(timeIntervalSince1970: ms / 1000)
    }
}
