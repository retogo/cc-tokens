//
//  SnapshotReader.swift
//  cc-tokens
//
//  cctok daemon が atomic に書き出す snapshot JSON を 1Hz で読み直して @Published で配信する。
//  daemon が `<path>.tmp` → rename(2) するので元 fd の DispatchSource は毎回切れる。
//  ファイルウォッチではなく polling にしているのは:
//   (a) 5s 間隔の更新に対し 1Hz polling のコストは無視できる (数 KB の read+decode)
//   (b) rename 後の再アタッチを書くより素直
//   (c) ファイル不在 → 存在に切り替わるエッジを 1 つのループで扱える
//

import Foundation
import Combine

@MainActor
final class SnapshotReader: ObservableObject {

    enum ReaderState {
        /// 初回 read 前 / 直前にファイルが見つからない。
        case waiting(path: URL)
        /// 直近の payload を保持。`ageSec` は generatedAt からの経過秒。
        case ready(payload: EmitPayload, ageSec: TimeInterval)
        /// decode に失敗。前回 payload があれば fallback として保持しておく方が良いが、
        /// 初回 decode 失敗もあり得るので nil 許容にしておく。
        case error(message: String, last: EmitPayload?)
    }

    @Published private(set) var state: ReaderState

    /// 監視対象ファイル。デフォルトは `~/.cctok/snapshot.json`。
    let path: URL

    /// 直近成功した payload (decode 失敗時のフォールバック表示用)。
    private var lastPayload: EmitPayload?
    /// 直近読み取り時の mtime。変化が無ければ decode を skip する。
    private var lastMtime: Date?
    /// 経過秒の更新用に毎ループで現在時刻も使うので、age は別タイマーでも更新する想定だが
    /// 1Hz の polling と同じ周期なので state 更新時にだけ計算する。
    private var task: Task<Void, Never>?
    private let pollInterval: TimeInterval

    init(path: URL, pollInterval: TimeInterval = 1.0) {
        self.path = path
        self.pollInterval = pollInterval
        self.state = .waiting(path: path)
        start()
    }

    deinit {
        task?.cancel()
    }

    /// 手動 refresh。ユーザが panel を開いた瞬間に呼ぶ用途を想定。
    func refreshNow() {
        Task { @MainActor in
            await pollOnce()
        }
    }

    private func start() {
        task = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.pollOnce()
                try? await Task.sleep(for: .seconds(self.pollInterval))
            }
        }
    }

    private func pollOnce() async {
        // 存在チェック → mtime 比較 → 必要時のみ read+decode。
        let fm = FileManager.default
        guard fm.fileExists(atPath: path.path) else {
            // 直前まで ready だったとしても daemon が止まっただけかもしれないので
            // last payload は捨てない (error にせず waiting に戻す)。
            if case .ready(let payload, _) = state {
                state = .error(message: "Snapshot file disappeared", last: payload)
            } else if case .error = state {
                // すでに error 状態。
            } else {
                state = .waiting(path: path)
            }
            lastMtime = nil
            return
        }

        // mtime 取得 (Date 型)。
        let attrs: [FileAttributeKey: Any]
        do {
            attrs = try fm.attributesOfItem(atPath: path.path)
        } catch {
            state = .error(message: "Stat failed: \(error.localizedDescription)", last: lastPayload)
            return
        }
        let mtime = attrs[.modificationDate] as? Date

        // mtime に変化が無く既に ready なら age だけ更新して終わる。
        if let mtime, mtime == lastMtime, let last = lastPayload {
            state = .ready(payload: last, ageSec: ageOf(last))
            return
        }
        lastMtime = mtime

        do {
            let data = try Data(contentsOf: path)
            let payload = try JSONDecoder().decode(EmitPayload.self, from: data)
            // schema_version 未来バージョン警告 (current の知識は 1)。
            if payload.schemaVersion != 1 {
                // 未知バージョンでも decode はできているので ready 扱いだが、
                // フィールドが欠けている可能性がある旨を将来 UI で出せるよう注釈は別の経路で。
            }
            lastPayload = payload
            state = .ready(payload: payload, ageSec: ageOf(payload))
        } catch {
            // decode 失敗。前回 payload があれば error に last を載せて表示継続。
            state = .error(message: "Decode failed: \(error.localizedDescription)", last: lastPayload)
        }
    }

    /// generated_at (ISO8601) と now の差分 (秒)。decode 失敗時は 0。
    private func ageOf(_ payload: EmitPayload) -> TimeInterval {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: payload.generatedAt) {
            return Date().timeIntervalSince(d)
        }
        // フラクションなしフォーマットも受ける (将来書式変更への保険)。
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: payload.generatedAt) {
            return Date().timeIntervalSince(d)
        }
        return 0
    }
}
