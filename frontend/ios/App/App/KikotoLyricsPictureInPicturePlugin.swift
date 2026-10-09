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
        presenter.onSeek = { [weak self] positionMs in
            self?.notifyListeners("seek", data: ["positionMs": positionMs])
        }
        return presenter
    }()

    override public func load() {
        // Screen recordings and mirrored displays would show the floating window.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenCaptureDidBegin),
            name: KikotoPrivacyShield.screenCaptureDidBegin,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func screenCaptureDidBegin() {
        presenter.close()
    }

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
        let appearance = Self.appearance(call.getObject("appearance"))
        let playback = Self.playback(call)
        DispatchQueue.main.async {
            guard KikotoLyricsPictureInPicture.isSupported, let container = self.bridge?.viewController?.view else {
                call.reject("Picture-in-Picture is unavailable.")
                return
            }
            self.presenter.show(
                title: title,
                lines: lines,
                appearance: appearance,
                positionMs: playback.positionMs,
                playing: playback.playing,
                playbackRate: playback.rate,
                durationMs: playback.durationMs,
                in: container
            )
            call.resolve()
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        let playback = Self.playback(call)
        DispatchQueue.main.async {
            self.presenter.update(
                positionMs: playback.positionMs,
                playing: playback.playing,
                playbackRate: playback.rate,
                durationMs: playback.durationMs
            )
            call.resolve()
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.presenter.hide()
            call.resolve()
        }
    }

    private static func playback(_ call: CAPPluginCall) -> (positionMs: Double, playing: Bool, rate: Double, durationMs: Double) {
        let position = call.getDouble("positionMs") ?? 0
        let rate = call.getDouble("playbackRate") ?? 1
        let duration = call.getDouble("durationMs") ?? 0
        return (
            position.isFinite ? position : 0,
            call.getBool("playing") ?? false,
            rate.isFinite && rate > 0 && rate <= 16 ? rate : 1,
            duration.isFinite && duration > 0 ? duration : 0
        )
    }

    /// Theme colors as `#rrggbb`; any missing or malformed color keeps the default look.
    private static func appearance(_ object: JSObject?) -> KikotoLyricsAppearance {
        guard
            let object,
            let background = color(object["background"] as? String),
            let foreground = color(object["foreground"] as? String),
            let accent = color(object["accent"] as? String)
        else { return .fallback }
        return KikotoLyricsAppearance(background: background, foreground: foreground, accent: accent)
    }

    private static func color(_ hex: String?) -> UIColor? {
        guard let hex, hex.count == 7, hex.hasPrefix("#"),
              hex.dropFirst().allSatisfy(\.isHexDigit),
              let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        return UIColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }

    private static func bounded(_ text: String) -> String {
        String(text.prefix(maxTextLength))
    }
}
