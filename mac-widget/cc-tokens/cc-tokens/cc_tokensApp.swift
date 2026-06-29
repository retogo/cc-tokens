//
//  cc_tokensApp.swift
//  cc-tokens
//
//  MenuBarExtra(.window) の常駐アプリ。クリックでパネルが開き、開いたまま 1Hz で再描画される。
//  デフォルトで Dock アイコンも出る。Dock を消して純メニューバーアプリ化したい場合は
//  Info.plist に LSUIElement = YES を足す (Build Settings: INFOPLIST_KEY_LSUIElement = YES)。
//

import SwiftUI

@main
struct cc_tokensApp: App {

    /// v1 はパスをハードコード (個人開発前提)。bun / cli.ts の置き場所が変わったらここを直す。
    /// 将来は Settings UI または `bun build --compile` で .app に同梱する形に置き換える。
    private static let daemonConfig = DaemonController.Config(
        bunPath: "/Users/hirokigoto/.nix-profile/bin/bun",
        cliPath: "/Users/hirokigoto/git/repos/github.com/retogo/cc-tokens/src/cli.ts",
        emitPath: FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".cctok/snapshot.json").path,
        logPath: FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".cctok/daemon.log").path
    )

    /// SnapshotReader は App スコープで生存させる (パネル開閉で破棄しない)。
    @StateObject private var reader: SnapshotReader = {
        let path = URL(fileURLWithPath: daemonConfig.emitPath)
        return SnapshotReader(path: path)
    }()

    /// daemon の子プロセスもアプリと同じライフサイクルで管理する。
    /// start() は次の runloop tick に倒す: @StateObject 初期化クロージャは
    /// SwiftUI の AppGraph 構築中に走るので、その最中に @Published を変更しても
    /// 観測者がいないとはいえ、Process spawn 含む副作用は AppGraph が確定した後で動かす。
    @StateObject private var daemon: DaemonController = {
        let controller = DaemonController(config: daemonConfig)
        Task { @MainActor in controller.start() }
        return controller
    }()

    var body: some Scene {
        MenuBarExtra {
            ContentView(reader: reader, daemon: daemon)
        } label: {
            MenuBarLabel(state: reader.state)
        }
        .menuBarExtraStyle(.window)
    }
}

/// メニューバー上の常時表示部分。% が取れていれば数字、無ければアイコン。
/// MenuBarExtra の label に置ける View は文字 / 画像 / それらの組み合わせ程度。
private struct MenuBarLabel: View {
    let state: SnapshotReader.ReaderState

    var body: some View {
        switch state {
        case .ready(let payload, _):
            if let pct = payload.snapshot.pct {
                // pct は 0-1 の比率 (TS 側で utilization/100 してある)。表示は ×100 して整数 %。
                Text("\(Int((pct * 100).rounded()))%")
            } else if payload.snapshot.hasActivity {
                // local-only モード: % が無いので使用量だけ kilo 表記。
                Text(kiloText(payload.snapshot.usedWeighted))
            } else {
                Image(systemName: "gauge.with.dots.needle.0percent")
            }
        case .waiting:
            Image(systemName: "ellipsis.circle")
        case .error(_, let last):
            // 直前 payload があれば残りの値を出しつつエラーアイコン重ねる。
            if let last, let pct = last.snapshot.pct {
                HStack(spacing: 2) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text("\(Int((pct * 100).rounded()))%")
                }
            } else {
                Image(systemName: "exclamationmark.triangle.fill")
            }
        }
    }

    private func kiloText(_ v: Double) -> String {
        if v >= 1000 {
            return String(format: "%.1fk", v / 1000)
        }
        return "\(Int(v.rounded()))"
    }
}
