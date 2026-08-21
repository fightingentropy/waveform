import ExpoModulesCore
import AVFoundation
import Foundation
import MediaPlayer
import UIKit

// Native AVFoundation playback engine, ported 1:1 from the Capacitor plugin
// (ios/App/App/AudioEnginePlugin.swift) to an Expo Module. The JS player keeps
// all orchestration (queue, scrobble, podcast resume, *when* to crossfade); this
// module owns audio output so it survives a locked screen — two AVPlayer "decks"
// (A/B) for crossfade, the AVAudioSession, the equal-power crossfade ramp, and
// the lock-screen Now Playing info + remote commands. See docs/native-audio-engine.md.
public class AudioEngineModule: Module {
    // MARK: - Deck

    private final class Deck {
        let id: String
        let player = AVPlayer()
        var item: AVPlayerItem?
        var songId: String?
        var desiredRate: Float = 1.0
        var wantsPlaying = false
        var volume: Float = 1.0
        var startAt: Double = 0
        var timeObserver: Any?
        var statusObs: NSKeyValueObservation?
        var rateObs: NSKeyValueObservation?
        var endObserver: NSObjectProtocol?
        var lastDuration: Double = 0

        init(id: String) {
            self.id = id
            player.volume = 1.0
            player.automaticallyWaitsToMinimizeStalling = true
        }
    }

    private var decks: [String: Deck] = [:]
    private var activeDeck = "A"
    private var configured = false
    private var rampTimer: DispatchSourceTimer?
    private var artworkTask: URLSessionDataTask?
    private var artworkGeneration = 0
    // AVAudioSession category/activation calls can synchronously wait on the
    // system audio daemon. iOS 27 reports a runtime hang risk when those calls
    // run on the main thread, so serialize them on a dedicated queue and return
    // to main only for AVPlayer/UI-facing work.
    private let audioSessionQueue = DispatchQueue(
        label: "xyz.streamarena.spotify.audio-session",
        qos: .userInitiated
    )

    // Keeps a strong reference to the interruption observer target. The @objc
    // selector below stays on the module instance, so it's a NotificationCenter
    // selector-based observer (no token needed).

    // MARK: - Module definition

    public func definition() -> ModuleDefinition {
        Name("AudioEngine")

        Events("time", "loaded", "ended", "seeked", "error", "crossfadeComplete", "playing", "waiting", "remote")

        // Equivalent of Capacitor's load() — runs during module init on the main
        // thread, before any JS method, so the decks exist before first prepare().
        OnCreate {
            self.ensureConfigured()
        }

        OnDestroy {
            for deck in self.decks.values {
                self.teardownDeck(deck)
            }
            NotificationCenter.default.removeObserver(self)
        }

        // MARK: Lifecycle

        AsyncFunction("configure") {
            DispatchQueue.main.async {
                self.ensureConfigured()
            }
        }

        // Public: just put the shared AVAudioSession into .playback + active. Used by
        // the M1a path where audio still plays from the WebView <audio> element — this
        // keeps that audio alive when the screen locks (combined with UIBackgroundModes).
        AsyncFunction("activateSession") {
            DispatchQueue.main.async {
                self.configureSession()
            }
        }

        // MARK: Load / transport

        AsyncFunction("prepare") { (deck: String, url: String, id: String?, startAt: Double?) in
            guard let deckObj = self.decks[deck] else {
                throw Exception(name: "AudioEngine", description: "deck not configured")
            }
            let urlString = url
            let songId = id ?? ""
            let startAtValue = startAt ?? 0
            // URL handling (spec §7.3 hazard #4): accept a bare leading-"/" path
            // (local file), a "file://" URI (offline-cached local files), and
            // normal http(s) URLs.
            let resolvedUrl: URL
            if urlString.hasPrefix("/") {
                resolvedUrl = URL(fileURLWithPath: urlString)
            } else if urlString.hasPrefix("file://") {
                if let parsed = URL(string: urlString) {
                    resolvedUrl = parsed
                } else {
                    // Fall back to treating the percent-decoded path as a file path.
                    let path = String(urlString.dropFirst("file://".count)).removingPercentEncoding ?? String(urlString.dropFirst("file://".count))
                    resolvedUrl = URL(fileURLWithPath: path)
                }
            } else if let parsed = URL(string: urlString) {
                resolvedUrl = parsed
            } else {
                throw Exception(name: "AudioEngine", description: "bad url")
            }

            DispatchQueue.main.async {
                self.cancelRamp()
                deckObj.statusObs?.invalidate()
                deckObj.statusObs = nil
                if let obs = deckObj.endObserver {
                    NotificationCenter.default.removeObserver(obs)
                    deckObj.endObserver = nil
                }

                let item = AVPlayerItem(url: resolvedUrl)
                // Buffer enough of progressive HTTP audio to ride through short
                // signal gaps before the JS queue-ahead file cache takes over at
                // the next track boundary. Local files need no forward buffer.
                if resolvedUrl.isFileURL {
                    item.preferredForwardBufferDuration = 0
                } else {
                    item.preferredForwardBufferDuration = 45
                }
                deckObj.item = item
                deckObj.songId = songId
                deckObj.startAt = startAtValue
                deckObj.lastDuration = 0
                deckObj.player.replaceCurrentItem(with: item)
                deckObj.player.volume = deckObj.volume
                self.setupDeckObservers(deckObj)

                deckObj.statusObs = item.observe(\.status, options: [.new]) { [weak self, weak deckObj] item, _ in
                    guard let self = self, let deckObj = deckObj else { return }
                    guard deckObj.item === item else { return }
                    if item.status == .readyToPlay {
                        let dur = item.duration.isNumeric ? item.duration.seconds : 0
                        deckObj.lastDuration = dur.isFinite ? dur : 0
                        self.sendEvent("loaded", ["deck": deckObj.id, "songId": songId, "duration": deckObj.lastDuration])
                        if deckObj.startAt > 0.5 {
                            item.seek(to: CMTime(seconds: deckObj.startAt, preferredTimescale: 600)) { _ in }
                            deckObj.startAt = 0
                        }
                        if deckObj.wantsPlaying {
                            self.startPlayback(deckObj)
                        }
                    } else if item.status == .failed {
                        let nsError = item.error as NSError?
                        var message = nsError?.localizedDescription ?? "load failed"
                        if let nsError = nsError {
                            message += " [\(nsError.domain) \(nsError.code)]"
                            if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError {
                                message += " under(\(underlying.domain) \(underlying.code))"
                            }
                        }
                        self.sendEvent("error", ["deck": deckObj.id, "songId": songId, "message": message])
                    }
                }

                deckObj.endObserver = NotificationCenter.default.addObserver(
                    forName: .AVPlayerItemDidPlayToEndTime,
                    object: item,
                    queue: .main
                ) { [weak self, weak deckObj, weak item] _ in
                    guard let self = self, let deckObj = deckObj, let item = item else { return }
                    guard deckObj.item === item else { return }
                    self.sendEvent("ended", ["deck": deckObj.id, "songId": songId])
                }
            }
        }

        AsyncFunction("play") { (deck: String) in
            guard let deckObj = self.decks[deck] else {
                throw Exception(name: "AudioEngine", description: "deck not configured")
            }
            DispatchQueue.main.async {
                deckObj.wantsPlaying = true
                self.startPlayback(deckObj)
            }
        }

        AsyncFunction("pause") { (deck: String) in
            guard let deckObj = self.decks[deck] else {
                throw Exception(name: "AudioEngine", description: "deck not configured")
            }
            DispatchQueue.main.async {
                deckObj.wantsPlaying = false
                self.cancelRamp()
                deckObj.player.pause()
            }
        }

        AsyncFunction("stop") { (deck: String) in
            guard let deckObj = self.decks[deck] else {
                throw Exception(name: "AudioEngine", description: "deck not configured")
            }
            DispatchQueue.main.async {
                self.teardownDeck(deckObj)
            }
        }

        AsyncFunction("seek") { (deck: String, position: Double?) in
            guard let deckObj = self.decks[deck] else {
                throw Exception(name: "AudioEngine", description: "deck not configured")
            }
            let pos = max(0, position ?? 0)
            DispatchQueue.main.async {
                self.cancelRamp()
                let songId = deckObj.songId ?? ""
                let target = CMTime(seconds: pos, preferredTimescale: 600)
                deckObj.player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self, weak deckObj] _ in
                    guard let self = self, let deckObj = deckObj else { return }
                    self.sendEvent("seeked", ["deck": deckObj.id, "songId": songId, "currentTime": pos])
                }
            }
        }

        AsyncFunction("setVolume") { (deck: String, volume: Double?) in
            guard let deckObj = self.decks[deck] else {
                throw Exception(name: "AudioEngine", description: "deck not configured")
            }
            let vol = max(0, min(1, Float(volume ?? 1.0)))
            DispatchQueue.main.async {
                self.cancelRamp()
                deckObj.volume = vol
                deckObj.player.volume = vol
            }
        }

        AsyncFunction("setRate") { (deck: String, rate: Double?) in
            guard let deckObj = self.decks[deck] else {
                throw Exception(name: "AudioEngine", description: "deck not configured")
            }
            let rateValue = Float(rate ?? 1.0)
            DispatchQueue.main.async {
                deckObj.desiredRate = rateValue
                if deckObj.player.timeControlStatus != .paused {
                    deckObj.player.rate = rateValue
                }
            }
        }

        AsyncFunction("setActiveDeck") { (deck: String?) in
            if let deckId = deck {
                DispatchQueue.main.async {
                    self.activeDeck = deckId
                }
            }
        }

        // MARK: Crossfade (native equal-power ramp, background-safe)

        AsyncFunction("crossfade") { (from: String, to: String, durationMs: Double?, peak: Double?) in
            guard let fromDeck = self.decks[from], let toDeck = self.decks[to] else {
                throw Exception(name: "AudioEngine", description: "bad decks")
            }
            let durationMsValue = max(1, durationMs ?? 4000)
            let peakValue = max(0, Float(peak ?? 1.0))

            DispatchQueue.main.async {
                self.cancelRamp()
                let startFrom = fromDeck.volume
                let fromSongId = fromDeck.songId ?? ""
                let toSongId = toDeck.songId ?? ""
                toDeck.volume = 0
                toDeck.player.volume = 0
                toDeck.wantsPlaying = true
                self.startPlayback(toDeck)

                let startNanos = DispatchTime.now().uptimeNanoseconds
                let timer = DispatchSource.makeTimerSource(queue: .main)
                timer.schedule(deadline: .now(), repeating: 0.033)
                timer.setEventHandler { [weak self, weak fromDeck, weak toDeck] in
                    guard let self = self, let fromDeck = fromDeck, let toDeck = toDeck else { return }
                    let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - startNanos) / 1_000_000
                    let progress = max(0, min(1, elapsedMs / durationMsValue))
                    let outGain = Float(cos(progress * 0.5 * Double.pi))
                    let inGain = Float(sin(progress * 0.5 * Double.pi))
                    fromDeck.volume = startFrom * outGain
                    fromDeck.player.volume = fromDeck.volume
                    toDeck.volume = peakValue * inGain
                    toDeck.player.volume = toDeck.volume
                    if progress >= 1 {
                        self.cancelRamp()
                        fromDeck.volume = 0
                        fromDeck.player.volume = 0
                        fromDeck.player.pause()
                        fromDeck.wantsPlaying = false
                        toDeck.volume = peakValue
                        toDeck.player.volume = peakValue
                        self.activeDeck = toDeck.id
                        self.sendEvent("crossfadeComplete", [
                            "from": fromDeck.id,
                            "to": toDeck.id,
                            "fromSongId": fromSongId,
                            "toSongId": toSongId,
                        ])
                    }
                }
                self.rampTimer = timer
                timer.resume()
            }
        }

        // MARK: Now Playing / lock screen

        AsyncFunction("setNowPlaying") { (title: String?, artist: String?, album: String?, duration: Double?, artworkUrl: String?) in
            let titleValue = title ?? ""
            let artistValue = artist ?? ""
            let albumValue = album ?? ""
            let durationValue = duration ?? 0
            let artworkUrlValue = artworkUrl

            DispatchQueue.main.async {
                self.artworkGeneration += 1
                let artworkGeneration = self.artworkGeneration
                self.artworkTask?.cancel()
                self.artworkTask = nil
                var info: [String: Any] = [
                    MPMediaItemPropertyTitle: titleValue,
                    MPMediaItemPropertyArtist: artistValue,
                    MPMediaItemPropertyAlbumTitle: albumValue,
                    MPNowPlayingInfoPropertyElapsedPlaybackTime: 0.0,
                    MPNowPlayingInfoPropertyPlaybackRate: 0.0,
                ]
                if durationValue > 0 {
                    info[MPMediaItemPropertyPlaybackDuration] = durationValue
                }
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                self.loadArtwork(artworkUrlValue, generation: artworkGeneration)
            }
        }

        AsyncFunction("updateNowPlaying") { (position: Double?, rate: Double?, playing: Bool?) in
            let positionValue = position ?? 0
            let rateValue = rate ?? 1
            let playingValue = playing ?? false

            DispatchQueue.main.async {
                var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = positionValue
                info[MPNowPlayingInfoPropertyPlaybackRate] = playingValue ? rateValue : 0.0
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                MPNowPlayingInfoCenter.default().playbackState = playingValue ? .playing : .paused
            }
        }

        AsyncFunction("releaseDeck") { (deck: String) in
            guard let deckObj = self.decks[deck] else {
                return
            }
            DispatchQueue.main.async {
                self.teardownDeck(deckObj)
            }
        }
    }

    // MARK: - Configuration / setup

    private func ensureConfigured() {
        if configured { return }
        let a = Deck(id: "A")
        let b = Deck(id: "B")
        decks["A"] = a
        decks["B"] = b
        setupDeckObservers(a)
        setupDeckObservers(b)
        configureSession()
        setupRemoteCommands()
        setupInterruptionObserver()
        configured = true
    }

    private func configureSession() {
        activateSession()
    }

    private func setupDeckObservers(_ deck: Deck) {
        clearDeckObservers(deck)
        let interval = CMTime(seconds: 0.25, preferredTimescale: 600)
        deck.timeObserver = deck.player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self, weak deck] _ in
            self?.emitTime(deck)
        }
        deck.rateObs = deck.player.observe(\.timeControlStatus, options: [.new]) { [weak self, weak deck] player, _ in
            guard let self = self, let deck = deck else { return }
            switch player.timeControlStatus {
            case .playing:
                self.sendEvent("playing", ["deck": deck.id, "songId": deck.songId ?? ""])
            case .waitingToPlayAtSpecifiedRate:
                self.sendEvent("waiting", ["deck": deck.id, "songId": deck.songId ?? ""])
            default:
                break
            }
        }
    }

    private func clearDeckObservers(_ deck: Deck) {
        if let observer = deck.timeObserver {
            deck.player.removeTimeObserver(observer)
            deck.timeObserver = nil
        }
        deck.rateObs?.invalidate()
        deck.rateObs = nil
    }

    // MARK: - Playback helpers

    private func startPlayback(_ deck: Deck) {
        activateSession { [weak deck] in
            guard let deck = deck, deck.wantsPlaying else { return }
            if deck.desiredRate != 1.0 {
                deck.player.playImmediately(atRate: deck.desiredRate)
            } else {
                deck.player.play()
            }
        }
    }

    private func activateSession(completion: (() -> Void)? = nil) {
        audioSessionQueue.async {
            let session = AVAudioSession.sharedInstance()
            do {
                if session.category != .playback ||
                    session.mode != .default ||
                    !session.categoryOptions.isEmpty {
                    try session.setCategory(.playback, mode: .default, options: [])
                }
                try session.setActive(true)
            } catch {
                // Preserve the previous best-effort behavior: AVPlayer still gets
                // a chance to start even if explicit session activation fails.
                print("[AudioEngine] session activation failed: \(error)")
            }
            guard let completion = completion else { return }
            DispatchQueue.main.async {
                completion()
            }
        }
    }

    private func teardownDeck(_ deck: Deck) {
        deck.wantsPlaying = false
        deck.player.pause()
        deck.player.replaceCurrentItem(with: nil)
        deck.statusObs?.invalidate()
        deck.statusObs = nil
        if let obs = deck.endObserver {
            NotificationCenter.default.removeObserver(obs)
            deck.endObserver = nil
        }
        clearDeckObservers(deck)
        deck.item = nil
        deck.songId = nil
    }

    private func cancelRamp() {
        rampTimer?.cancel()
        rampTimer = nil
    }

    private func loadArtwork(_ urlString: String?, generation: Int) {
        guard let urlString = urlString, let url = URL(string: urlString) else { return }
        if url.isFileURL {
            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard let data = try? Data(contentsOf: url) else { return }
                self?.applyArtwork(data, generation: generation)
            }
            return
        }
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data = data else { return }
            self?.applyArtwork(data, generation: generation)
        }
        artworkTask = task
        task.resume()
    }

    private func applyArtwork(_ data: Data, generation: Int) {
        guard let image = UIImage(data: data) else { return }
        DispatchQueue.main.async {
            guard generation == self.artworkGeneration else { return }
            guard var info = MPNowPlayingInfoCenter.default().nowPlayingInfo else { return }
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            self.artworkTask = nil
        }
    }

    private func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in self?.emitRemote("play"); return .success }
        center.pauseCommand.addTarget { [weak self] _ in self?.emitRemote("pause"); return .success }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in self?.emitRemote("toggle"); return .success }
        center.nextTrackCommand.addTarget { [weak self] _ in self?.emitRemote("next"); return .success }
        center.previousTrackCommand.addTarget { [weak self] _ in self?.emitRemote("prev"); return .success }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.sendEvent("remote", ["action": "seek", "value": event.positionTime])
            return .success
        }
        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true
        center.nextTrackCommand.isEnabled = true
        center.previousTrackCommand.isEnabled = true
        center.changePlaybackPositionCommand.isEnabled = true
    }

    private func emitRemote(_ action: String) {
        sendEvent("remote", ["action": action])
    }

    private func setupInterruptionObserver() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
        if type == .began {
            emitRemote("pause")
        } else if type == .ended {
            if let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt,
               AVAudioSession.InterruptionOptions(rawValue: optionsValue).contains(.shouldResume) {
                emitRemote("play")
            }
        }
    }

    // MARK: - Helpers

    private func emitTime(_ deck: Deck?) {
        guard let deck = deck else { return }
        let player = deck.player
        guard deck.id == activeDeck || player.timeControlStatus == .playing else { return }
        let current = player.currentTime().seconds
        guard current.isFinite else { return }
        var duration = 0.0
        if let itemDuration = deck.item?.duration, itemDuration.isNumeric {
            let seconds = itemDuration.seconds
            if seconds.isFinite { duration = seconds }
        }
        sendEvent("time", [
            "deck": deck.id,
            "songId": deck.songId ?? "",
            "currentTime": current,
            "duration": duration,
        ])
    }
}
