import Capacitor
import UIKit

/// Shows screen lyrics in Picture-in-Picture with the same contract as the
/// Android lyrics overlay: status, show the timed track, update playback,
/// hide, and a closed event. Play or pause from the window is reported back
/// so the web player stays the only media session.
@objc(KikotoLyricsPictureInPicturePlugin)
public class KikotoLyricsPictureInPicturePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KikotoLyricsPictureInPicturePlugin"
    public let jsName = "KikotoLyricsPictureInPicture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
    ]

    private static let maxLines = 5000
    private static let maxTextLength = 300

    // Accessed only on the main queue.
    private lazy var presenter: KikotoLyricsPictureInPicture = {
        let presenter = KikotoLyricsPictureInPicture()
        presenter.onClosed = { [weak self] in
            self?.notifyListeners("closed", data: [:])
        }
        presenter.onPlaybackControl = { [weak self] playing in
            self?.notifyListeners("playbackControl", data: ["playing": playing])
        }
        return presenter
    }()

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["supported": KikotoLyricsPictureInPicture.isSupported, "permitted": true])
        }
    }

    @objc func show(_ call: CAPPluginCall) {
        let title = Self.bounded(call.getString("title") ?? "")
        let lines = (call.getArray("lines") ?? [])
            .prefix(Self.maxLines)
            .compactMap { item -> KikotoLyricLine? in
                guard
                    let line = item as? [String: Any],
                    let time = (line["timeMs"] as? NSNumber)?.doubleValue,
                    time.isFinite
                else { return nil }
                return KikotoLyricLine(timeMs: time, text: Self.bounded(line["text"] as? String ?? ""))
            }
            .sorted { $0.timeMs < $1.timeMs }
        let playback = Self.playback(call)
        DispatchQueue.main.async {
            guard KikotoLyricsPictureInPicture.isSupported, let container = self.bridge?.viewController?.view else {
                call.reject("Picture-in-Picture is unavailable.")
                return
            }
            self.presenter.show(
                title: title,
                lines: lines,
                positionMs: playback.positionMs,
                playing: playback.playing,
                playbackRate: playback.rate,
                in: container
            )
            call.resolve()
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        let playback = Self.playback(call)
        DispatchQueue.main.async {
            self.presenter.update(positionMs: playback.positionMs, playing: playback.playing, playbackRate: playback.rate)
            call.resolve()
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.presenter.hide()
            call.resolve()
        }
    }

    private static func playback(_ call: CAPPluginCall) -> (positionMs: Double, playing: Bool, rate: Double) {
        let position = call.getDouble("positionMs") ?? 0
        let rate = call.getDouble("playbackRate") ?? 1
        return (
            position.isFinite ? position : 0,
            call.getBool("playing") ?? false,
            rate.isFinite && rate > 0 && rate <= 16 ? rate : 1
        )
    }

    private static func bounded(_ text: String) -> String {
        String(text.prefix(maxTextLength))
    }
}
