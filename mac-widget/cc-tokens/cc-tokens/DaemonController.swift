//
//  DaemonController.swift
//  cc-tokens
//
//  メニューバーアプリ起動と同時に cctok daemon を子プロセスとして起動し、
//  終了時に確実に止める。launchd LaunchAgent を別建てするより配布も運用もシンプル。
//
//  ⚠ 重要 (実装の制約):
//  SwiftUI のグラフ初期化 (AppGraph.instantiateOutputs) の最中に Process.waitUntilExit()
//  などの「runloop を spin する API」を呼んではいけない。runloop が再入して
//  SwiftUI の trans observer が走り、グラフ更新の再入で AttributeGraph precondition が
//  発火して abort() する (実機クラッシュで確認済み)。
//  対策: start() の重い処理は Task.detached でバックグラウンドに逃がし、@Published の
//  更新だけ MainActor.run で戻す。
//
//  v1 はパスをハードコード (個人開発前提)。bun と cli.ts の場所が変わった時は
//  この struct を変えるか、将来 Settings UI を足して上書きできるようにする。
//

import Foundation
import AppKit
import Combine

@MainActor
final class DaemonController: ObservableObject {

    /// daemon の生存状態。UI が age badge と別に「直近 spawn は失敗したか」を出すために使う。
    enum Status: Equatable {
        case stopped
        /// pkill 中 / spawn 直前。"Starting…" を出してもいいが UI 上は無音でも違和感はない。
        case starting
        case running(pid: Int32)
        /// 起動に失敗 / プロセスが落ちた。reason は人間向け文字列。
        case crashed(reason: String)
    }

    @Published private(set) var status: Status = .stopped

    /// spawn する子プロセスの設定。
    struct Config: Sendable {
        let bunPath: String
        let cliPath: String
        let emitPath: String
        let logPath: String
    }

    private let config: Config
    private var process: Process?
    /// stop() 経由の終了か (= 意図停止) を terminationHandler に伝えるための flag。
    /// MainActor 隔離なので main thread からのみ書き換える。
    private var isStoppingIntentionally: Bool = false
    private var terminateObserver: NSObjectProtocol?

    init(config: Config) {
        self.config = config
        // willTerminate で確実に SIGTERM → SIGKILL する。
        terminateObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // queue: .main で呼ばれるが MainActor 隔離が必要なので明示する。
            Task { @MainActor in self?.stop() }
        }
    }

    deinit {
        if let observer = terminateObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    /// daemon を起動する。
    ///
    /// pkill (waitUntilExit が runloop を spin する) と Process.run は Task.detached の
    /// バックグラウンドで実行し、UI state の更新だけ MainActor に戻す。
    /// これは @StateObject 初期化クロージャから呼ばれる経路でも安全に動く設計。
    func start() {
        // すでに running / starting なら何もしない。
        if case .running = status { return }
        if case .starting = status { return }
        status = .starting
        isStoppingIntentionally = false

        let config = self.config  // value 型なのでキャプチャ OK
        Task.detached(priority: .userInitiated) { [weak self] in
            // 1. 既存 daemon を pkill (バックグラウンドなら waitUntilExit OK)。
            Self.killExistingDaemonsBackground()

            // 2. ログファイル準備。
            Self.prepareLogFile(at: config.logPath)

            // 3. Process を組み立てて run。run 自体はノンブロッキング。
            await MainActor.run { [weak self] in
                self?.spawnDaemon()
            }
        }
    }

    /// daemon に SIGTERM を送り、3 秒待っても残ればプロセスごと kill する。
    /// アプリ終了時 (willTerminate) の同期的呼び出し前提。
    func stop() {
        guard let proc = process else {
            status = .stopped
            return
        }
        isStoppingIntentionally = true
        proc.terminate()  // SIGTERM
        // willTerminate は同期的に少し待てる。数百ms 待って残っていたら kill。
        // ここは main thread でブロックする必要があるが、willTerminate のタイミングなら
        // 既に view graph は破棄フェーズなので runloop 再入問題は起きない。
        let deadline = Date().addingTimeInterval(3.0)
        while proc.isRunning && Date() < deadline {
            usleep(50_000)
        }
        if proc.isRunning {
            kill(proc.processIdentifier, SIGKILL)
        }
        self.process = nil
        self.status = .stopped
    }

    /// 手動再起動 (panel の Restart ボタン用)。
    func restart() {
        if process != nil {
            stop()
        }
        start()
    }

    // MARK: - private

    /// MainActor で実行: Process を組み立てて run する。
    /// terminationHandler は別スレッドで呼ばれるので state 更新は MainActor 経由で行う。
    private func spawnDaemon() {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: config.bunPath)
        proc.arguments = ["run", config.cliPath, "daemon", "--emit", config.emitPath]

        if let log = try? FileHandle(forWritingTo: URL(fileURLWithPath: config.logPath)) {
            _ = try? log.seekToEnd()
            proc.standardOutput = log
            proc.standardError = log
        }

        proc.terminationHandler = { [weak self] p in
            Task { @MainActor in
                guard let self else { return }
                if self.isStoppingIntentionally {
                    self.status = .stopped
                } else {
                    self.status = .crashed(reason: "daemon exited (code \(p.terminationStatus))")
                }
                self.process = nil
            }
        }

        do {
            try proc.run()
            self.process = proc
            self.status = .running(pid: proc.processIdentifier)
        } catch {
            self.status = .crashed(reason: "spawn failed: \(error.localizedDescription)")
        }
    }

    /// `cli.ts daemon` を含むコマンドラインの既存プロセスを pkill する。
    /// バックグラウンド queue 専用 (waitUntilExit が runloop を spin するので main では呼べない)。
    nonisolated private static func killExistingDaemonsBackground() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        p.arguments = ["-f", "src/cli\\.ts daemon"]
        do {
            try p.run()
            p.waitUntilExit()  // バックグラウンドスレッドなので OK
        } catch {
            // pkill が存在しない macOS は無いので無視 (テスト環境などで run に失敗した場合のみ)。
        }
    }

    nonisolated private static func prepareLogFile(at path: String) {
        let fm = FileManager.default
        let dir = (path as NSString).deletingLastPathComponent
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        if !fm.fileExists(atPath: path) {
            fm.createFile(atPath: path, contents: nil)
        }
    }
}
