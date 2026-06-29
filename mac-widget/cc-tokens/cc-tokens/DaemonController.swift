//
//  DaemonController.swift
//  cc-tokens
//
//  メニューバーアプリ起動と同時に cctok daemon を子プロセスとして起動し、
//  終了時に確実に止める。launchd LaunchAgent を別建てするより配布も運用もシンプル。
//
//  v1 はパスをハードコードしている (個人開発前提)。bun と cli.ts の場所が変わった時は
//  この struct を変えるか、将来 Settings UI を足して上書きできるようにする。
//

import Foundation
import AppKit
import Combine

@MainActor
final class DaemonController: ObservableObject {

    /// daemon の生存状態。UI が age badge と別に「直近 spawn は失敗したか」を出すために使う。
    enum Status {
        case stopped
        case running(pid: Int32)
        /// 起動に失敗 / プロセスが落ちた。reason は人間向け文字列。
        case crashed(reason: String)
    }

    @Published private(set) var status: Status = .stopped

    /// spawn する子プロセスの設定。
    struct Config {
        /// bun の絶対パス。
        let bunPath: String
        /// cctok の cli.ts 絶対パス (bun run の引数)。
        let cliPath: String
        /// daemon の --emit 引数 (snapshot.json の出力先)。
        let emitPath: String
        /// stdout/stderr を流すログファイル (~/.cctok/daemon.log を推奨)。
        let logPath: String
    }

    private let config: Config
    private var process: Process?
    private var terminateObserver: NSObjectProtocol?

    init(config: Config) {
        self.config = config
        // willTerminate で確実に SIGTERM → SIGKILL する。observer は self 強参照すると
        // deinit が呼ばれないので [weak self] で安全側に。
        terminateObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.stop()
        }
    }

    deinit {
        if let observer = terminateObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    /// daemon を起動する。既存の daemon (このアプリ管理外も含む) は事前に pkill する。
    /// 同じ snapshot.json を二重 write する事故を避けるため。
    func start() {
        killExistingDaemons()

        // ログファイルを (なければ) 作る。FileHandle(forWritingAtPath:) は存在前提。
        let fm = FileManager.default
        let logDir = (config.logPath as NSString).deletingLastPathComponent
        try? fm.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        if !fm.fileExists(atPath: config.logPath) {
            fm.createFile(atPath: config.logPath, contents: nil)
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: config.bunPath)
        proc.arguments = ["run", config.cliPath, "daemon", "--emit", config.emitPath]

        // ログは append モードで開く。crash 時の出力を残す。
        if let log = try? FileHandle(forWritingTo: URL(fileURLWithPath: config.logPath)) {
            _ = try? log.seekToEnd()
            proc.standardOutput = log
            proc.standardError = log
        }

        // プロセス終了時のハンドラ。意図停止 (stop()) と異常終了を区別したいので、
        // stop() 経由なら status は .stopped を残し、それ以外は crashed に倒す。
        var isStopping = false
        self.isStopping = { isStopping }
        self.markStopping = { isStopping = true }

        proc.terminationHandler = { [weak self] p in
            Task { @MainActor in
                guard let self else { return }
                if isStopping {
                    self.status = .stopped
                } else {
                    let code = p.terminationStatus
                    self.status = .crashed(reason: "daemon exited (code \(code))")
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

    /// daemon に SIGTERM を送り、3 秒待っても残ればプロセスごと kill する。
    /// アプリ終了時 (willTerminate) の同期的呼び出し前提。
    func stop() {
        guard let proc = process else { return }
        markStopping?()
        proc.terminate()  // SIGTERM 相当
        // willTerminate は同期的に少し待てる (NSTerminate 直前)。
        // 数百ms 待って残っていたら kill。
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

    /// 手動再起動 (panel から触れるように)。crashed 後の復旧用。
    func restart() {
        stop()
        start()
    }

    // MARK: - 既存 daemon の掃除

    /// `cli.ts daemon` を含むコマンドラインの既存プロセスを pkill する。
    /// このアプリ管理外の (例: ユーザがターミナルから起動した) daemon と二重 write しないため。
    private func killExistingDaemons() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        // -f はフル command line マッチ。aikido-bun のような supervisor も含めて止めたい時は別パターンが要る。
        p.arguments = ["-f", "src/cli\\.ts daemon"]
        do {
            try p.run()
            p.waitUntilExit()
        } catch {
            // pkill が無い環境は想定外なので無視 (macOS では必ず /usr/bin/pkill がある)。
        }
    }

    // stop() と terminationHandler の競合を解消するためのフラグ参照経路。
    // クロージャ越しのキャプチャだけで、外部からは触らない。
    private var isStopping: (() -> Bool)?
    private var markStopping: (() -> Void)?
}
