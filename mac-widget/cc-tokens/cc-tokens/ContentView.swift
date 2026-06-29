//
//  ContentView.swift
//  cc-tokens
//
//  MenuBarExtra(.window) で開かれるパネルの本体。
//  reader.state に応じて 5h ウィンドウの % / バーン / リセット時刻 / 枯渇予測を出す。
//  開いている間も @Published で 1Hz 再描画される (.menu スタイルとの最大の違い)。
//

import SwiftUI
import AppKit

struct ContentView: View {
    @ObservedObject var reader: SnapshotReader

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .padding(14)
        .frame(width: 320)
        .onAppear { reader.refreshNow() }
    }

    // MARK: header

    private var header: some View {
        HStack {
            Image(systemName: "gauge.with.dots.needle.bottom.50percent")
                .foregroundStyle(.tint)
            Text("cctok")
                .font(.system(.headline, design: .rounded))
            Spacer()
            ageBadge
        }
    }

    /// 「Updated 3s ago」表記。古くなったら橙、さらに古くなったら赤。
    @ViewBuilder
    private var ageBadge: some View {
        switch reader.state {
        case .ready(_, let age):
            Text(ageText(age))
                .font(.caption)
                .foregroundStyle(ageColor(age))
        case .error(let msg, _):
            Text(msg)
                .font(.caption)
                .foregroundStyle(.red)
                .lineLimit(1)
                .truncationMode(.tail)
        case .waiting:
            Text("Waiting…")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: content

    @ViewBuilder
    private var content: some View {
        switch reader.state {
        case .waiting(let path):
            setupGuide(path: path)
        case .ready(let payload, _):
            snapshotBody(snap: payload.snapshot)
        case .error(_, let last):
            if let last {
                // エラー時も直前 snapshot は出す (連続性のため)。
                snapshotBody(snap: last.snapshot)
            } else {
                Text("No snapshot available yet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func snapshotBody(snap: Snapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // 大きな % または使用量
            HStack(alignment: .firstTextBaseline) {
                Text(headlineText(snap))
                    .font(.system(size: 32, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                Spacer()
                if let resetTs = snap.resetTs {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text("Resets")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(resetClockText(resetTs))
                            .font(.callout)
                            .monospacedDigit()
                    }
                }
            }

            // 進捗バー (% が取れている時だけ表示)。
            if let pct = snap.pct {
                ProgressView(value: min(max(pct / 100.0, 0), 1))
                    .progressViewStyle(.linear)
                    .tint(pctColor(pct))
            }

            // バーン (1m raw)。
            HStack {
                Image(systemName: "flame.fill")
                    .foregroundStyle(.orange)
                Text(burnText(snap.burn1m.rawPerMin))
                    .monospacedDigit()
                Text("tok/min")
                    .foregroundStyle(.secondary)
                Spacer()
                Text("(1m)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .font(.callout)

            // 枯渇予測 (projection.exhaustionTs があれば)。
            // exhaustionTs は absolute epoch ms なので snap.now との差で残り時間を出す。
            if let proj = snap.projection, let exhaustionTs = proj.exhaustionTs {
                let remainingMs = exhaustionTs - snap.now
                if remainingMs > 0 {
                    HStack {
                        Image(systemName: "hourglass")
                            .foregroundStyle(.secondary)
                        Text("Runs out in \(durationText(remainingMs))")
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                    .font(.callout)
                }
            }

            // トークン内訳 (小さく)。
            HStack(spacing: 12) {
                tokenChip(label: "in",  value: snap.totals.input)
                tokenChip(label: "out", value: snap.totals.output)
                tokenChip(label: "cache w", value: snap.totals.cacheCreation)
                tokenChip(label: "cache r", value: snap.totals.cacheRead)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private func tokenChip(label: String, value: Int) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).foregroundStyle(.tertiary)
            Text(kiloText(Double(value))).monospacedDigit()
        }
    }

    private func setupGuide(path: URL) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Snapshot file not found.")
                .font(.callout)
            Text(path.path)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text("Start the daemon to begin:")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("cctok daemon --emit ~/.cctok/snapshot.json")
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(6)
                .background(Color(NSColor.textBackgroundColor))
                .cornerRadius(4)
        }
    }

    // MARK: footer

    private var footer: some View {
        HStack {
            Button("Refresh") { reader.refreshNow() }
                .buttonStyle(.borderless)
            Spacer()
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
        }
        .font(.caption)
    }

    // MARK: formatting

    /// 大きく見せる値: pct があれば「42%」、無ければ加重消費 (kilo)。
    private func headlineText(_ snap: Snapshot) -> String {
        if let pct = snap.pct {
            return "\(Int(pct.rounded()))%"
        }
        return kiloText(snap.usedWeighted)
    }

    private func pctColor(_ pct: Double) -> Color {
        switch pct {
        case ..<60: .green
        case ..<85: .yellow
        default:    .red
        }
    }

    private func resetClockText(_ ms: Double) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: d)
    }

    private func burnText(_ perMin: Double) -> String {
        kiloText(perMin)
    }

    private func kiloText(_ v: Double) -> String {
        if v >= 1_000_000 {
            return String(format: "%.1fM", v / 1_000_000)
        }
        if v >= 1000 {
            return String(format: "%.1fk", v / 1000)
        }
        return "\(Int(v.rounded()))"
    }

    private func durationText(_ ms: Double) -> String {
        let totalSec = Int(ms / 1000)
        let h = totalSec / 3600
        let m = (totalSec % 3600) / 60
        if h > 0 { return "\(h)h \(m)m" }
        return "\(m)m"
    }

    private func ageText(_ age: TimeInterval) -> String {
        let s = Int(age.rounded())
        if s < 60 { return "Updated \(s)s ago" }
        let m = s / 60
        if m < 60 { return "Updated \(m)m ago" }
        let h = m / 60
        return "Updated \(h)h ago"
    }

    private func ageColor(_ age: TimeInterval) -> Color {
        switch age {
        case ..<15: .secondary
        case ..<60: .orange
        default:    .red
        }
    }
}

#Preview {
    // SnapshotReader の実 IO をプレビューで走らせないよう、preview 用のパスはあえて存在しないものを使う。
    ContentView(reader: SnapshotReader(path: URL(fileURLWithPath: "/tmp/__cctok_preview_does_not_exist.json")))
}
