import AVFoundation
import Capacitor
import UIKit

/// Covers the app with a blur while its scene is inactive, so the app switcher
/// snapshot and the switch gesture do not show the page. The choice is kept
/// natively: the cover must be in place when the scene resigns active, without
/// a round trip to the web view. It is on until the listener turns it off.
final class KikotoPrivacyShield {
    static let shared = KikotoPrivacyShield()

    private static let enabledKey = "kikoto.privacy.appSwitcherShield"

    // Accessed only on the main queue.
    private var coverWindow: UIWindow?

    var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: Self.enabledKey) }
    }

    func cover(_ scene: UIWindowScene) {
        guard isEnabled, coverWindow == nil else { return }
        // A separate window above alerts also covers presented sheets and pickers.
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.backgroundColor = .clear
        let controller = UIViewController()
        controller.view.backgroundColor = .clear
        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
        blur.frame = controller.view.bounds
        blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        controller.view.addSubview(blur)
        window.rootViewController = controller
        window.isHidden = false
        coverWindow = window
    }

    func uncover() {
        coverWindow?.isHidden = true
        coverWindow = nil
    }
}

/// Exposes the app switcher cover choice to Settings and pauses the page when
/// the audio output it was using disappears, such as headphones being
/// unplugged or a Bluetooth device disconnecting, so playback does not move to
/// the speaker. Reconnecting never resumes playback.
@objc(KikotoPrivacyPlugin)
public class KikotoPrivacyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KikotoPrivacyPlugin"
    public let jsName = "KikotoPrivacy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "appSwitcherShield", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAppSwitcherShield", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(audioRouteChanged(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc func appSwitcherShield(_ call: CAPPluginCall) {
        call.resolve(["enabled": KikotoPrivacyShield.shared.isEnabled])
    }

    @objc func setAppSwitcherShield(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else {
            call.reject("Missing app switcher choice.")
            return
        }
        KikotoPrivacyShield.shared.isEnabled = enabled
        call.resolve()
    }

    @objc private func audioRouteChanged(_ notification: Notification) {
        guard
            let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
            AVAudioSession.RouteChangeReason(rawValue: rawReason) == .oldDeviceUnavailable
        else { return }
        DispatchQueue.main.async { [weak self] in
            // Stop the page media at once, also while the web player is still
            // loading a source and would otherwise ignore an element pause.
            self?.bridge?.webView?.evaluateJavaScript(
                "document.querySelectorAll('audio,video').forEach(function(media){media.pause();});"
            )
            self?.notifyListeners("audioOutputLost", data: [:])
        }
    }
}
