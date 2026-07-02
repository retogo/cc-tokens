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
    @ObservedObject var daemon: DaemonController

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Divider()
            daemonStatusBanner
            content
            Divider()
            footer
        }
        .padding(14)
        .frame(width: 320)
        .onAppear { reader.refreshNow() }
    }

    /// 子プロセスとして起動した daemon が crashed なら専用バナー。
    /// running / stopped は無音 (panel の age badge と %  値が「動いている」を示すので冗長を避ける)。
    @ViewBuilder
    private var daemonStatusBanner: some View {
        if case .crashed(let reason) = daemon.status {
            HStack(spacing: 8) {
                Image(systemName: "bolt.trianglebadge.exclamationmark")
                    .foregroundStyle(.red)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Daemon stopped")
                        .font(.caption)
                    Text(reason)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer()
                Button("Restart") { daemon.restart() }
                    .controlSize(.small)
                    .buttonStyle(.bordered)
            }
            .padding(8)
            .background(Color.red.opacity(0.10))
            .cornerRadius(6)
        }
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
            VStack(alignment: .leading, spacing: 10) {
                apiStatusBanner(payload.apiStatus)
                snapshotBody(snap: payload.snapshot)
            }
        case .error(_, let last):
            if let last {
                // エラー時も直前 snapshot は出す (連続性のため)。
                VStack(alignment: .leading, spacing: 10) {
                    apiStatusBanner(last.apiStatus)
                    snapshotBody(snap: last.snapshot)
                }
            } else {
                Text("No snapshot available yet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// API が rate-limited / 認証切れ / network 失敗等で % が消えた理由を見せる。
    /// 表示条件: apiStatus.enabled かつ !ok。enabled=false (--local) 時は何も出さない。
    @ViewBuilder
    private func apiStatusBanner(_ apiStatus: ApiStatus?) -> some View {
        if let status = apiStatus, status.enabled, !status.ok {
            HStack(spacing: 8) {
                Image(systemName: apiStatusIcon(status))
                    .foregroundStyle(apiStatusTint(status))
                VStack(alignment: .leading, spacing: 1) {
                    Text(apiStatusHeadline(status))
                        .font(.caption)
                        .foregroundStyle(.primary)
                    if let retryText = apiStatusRetryText(status) {
                        Text(retryText)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .padding(8)
            .background(apiStatusTint(status).opacity(0.12))
            .cornerRadius(6)
        }
    }

    private func apiStatusIcon(_ s: ApiStatus) -> String {
        if let err = s.error {
            if err.contains("401") { return "lock.trianglebadge.exclamationmark" }
            if err.contains("429") { return "hourglass.tophalf.filled" }
        }
        return "antenna.radiowaves.left.and.right.slash"
    }

    private func apiStatusTint(_ s: ApiStatus) -> Color {
        if let err = s.error, err.contains("401") { return .red }
        return .orange
    }

    private func apiStatusHeadline(_ s: ApiStatus) -> String {
        guard let err = s.error else {
            // enabled だが error も official も無い = 起動直後で初回 fetch 前。
            return "API: waiting for first fetch…"
        }
        if err.contains("401") { return "API auth expired — run `claude` to refresh" }
        if err.contains("429") { return "API rate-limited" }
        return "API unavailable"
    }

    /// next_retry_at が未来なら "retrying in <duration>" / "retrying at HH:mm" を返す。
    /// 過ぎている場合は nil（次の poll で更新されるまで表示しない）。
    private func apiStatusRetryText(_ s: ApiStatus) -> String? {
        guard let nextMs = s.nextRetryAt else { return nil }
        let nowMs = Date().timeIntervalSince1970 * 1000
        let remainingMs = nextMs - nowMs
        guard remainingMs > 0 else { return nil }
        if remainingMs < 90_000 {
            return "retrying in \(Int(remainingMs / 1000))s"
        }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return "retrying at \(f.string(from: Date(timeIntervalSince1970: nextMs / 1000)))"
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

            // 進捗バー (% が取れている時だけ表示)。pct は 0-1 比率なのでそのまま渡せる。
            if let pct = snap.pct {
                ProgressView(value: min(max(pct, 0), 1))
                    .progressViewStyle(.linear)
                    .tint(pctColor(pct))
            }

            // 累積使用率のチャート (cumul が取れている時のみ)。
            // effectiveLimit が無いと % に意味がないので TS 側で cumul は null になる。
            if let cumul = snap.cumul {
                CumulChartView(cumul: cumul)
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

            // Session / model 別内訳。cacheRead は除外した raw トークンで並べる（headline と揃える）。
            breakdownSection(
                title: "By model",
                rows: snap.breakdowns.byModel,
                nameFor: { $0.key }
            )
            breakdownSection(
                title: "By session",
                rows: snap.breakdowns.bySession,
                nameFor: { row in snap.sessionTitles[row.key] ?? String(row.key.prefix(8)) }
            )
        }
    }

    /// 内訳セクション（model / session 共通）。上位 5 件のみ表示し、それ以外は "and N more" にまとめる。
    /// share は weighted ベースなので daemon 既定の raw モードでは表示 tok と整合する。
    @ViewBuilder
    private func breakdownSection(
        title: String,
        rows: [BreakdownRow],
        nameFor: @escaping (BreakdownRow) -> String
    ) -> some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .textCase(.uppercase)
                let top = Array(rows.prefix(5))
                ForEach(top) { row in
                    breakdownRow(name: nameFor(row), row: row)
                }
                if rows.count > top.count {
                    Text("and \(rows.count - top.count) more")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func breakdownRow(name: String, row: BreakdownRow) -> some View {
        HStack(spacing: 8) {
            Text(name)
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(kiloText(Double(row.rawTokens)))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Text(sharePctText(row.share))
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .frame(width: 38, alignment: .trailing)
        }
    }

    /// share (0..1) を "12%" 表記に。1% 未満は "<1%"。
    private func sharePctText(_ share: Double) -> String {
        if share <= 0 { return "0%" }
        let pct = share * 100
        if pct < 1 { return "<1%" }
        return "\(Int(pct.rounded()))%"
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
    /// pct は 0-1 比率なので表示時に ×100 する。
    private func headlineText(_ snap: Snapshot) -> String {
        if let pct = snap.pct {
            return "\(Int((pct * 100).rounded()))%"
        }
        return kiloText(snap.usedWeighted)
    }

    /// しきい値は 0-1 比率で。60%=0.6 / 85%=0.85。
    private func pctColor(_ pct: Double) -> Color {
        switch pct {
        case ..<0.60: .green
        case ..<0.85: .yellow
        default:      .red
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
    // Preview では daemon を spawn したくないので start() を呼ばない controller を直接渡す。
    let previewDaemon = DaemonController(config: DaemonController.Config(
        bunPath: "/usr/bin/false",
        cliPath: "/dev/null",
        emitPath: "/tmp/__cctok_preview.json",
        logPath: "/tmp/__cctok_preview.log"
    ))
    return ContentView(
        reader: SnapshotReader(path: URL(fileURLWithPath: "/tmp/__cctok_preview_does_not_exist.json")),
        daemon: previewDaemon
    )
}
