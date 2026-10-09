import AVFoundation
import Capacitor
import UIKit

/// Covers the app with a blur while its scene is inactive, so the app switcher
/// snapshot and the switch gesture do not show the page, and while the screen
/// is recorded, mirrored, or otherwise captured. The choices are kept
/// natively: the cover must be in place when the scene resigns active or a
/// capture begins, without a round trip to the web view. Both are on until the
/// listener turns them off.
@MainActor
final class KikotoPrivacyShield {
    static let shared = KikotoPrivacyShield()
    /// Posted on the main queue when a screen capture begins while its cover is enabled.
    nonisolated static let screenCaptureDidBegin = Notification.Name("KikotoScreenCaptureDidBegin")

    private static let inactiveKey = "kikoto.privacy.appSwitcherShield"
    private static let captureKey = "kikoto.privacy.screenCaptureShield"

    private weak var scene: UIWindowScene?
    private var captureObservation: Any?
    private var coverWindow: UIWindow?
    private var captureIcon: UIView?
    private var inactive = false
    private var captured = false

    var coversInactive: Bool {
        get { UserDefaults.standard.object(forKey: Self.inactiveKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.inactiveKey)
            refresh()
        }
    }

    var coversScreenCapture: Bool {
        get { UserDefaults.standard.object(forKey: Self.captureKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.captureKey)
            refresh()
            if newValue && captured { NotificationCenter.default.post(name: Self.screenCaptureDidBegin, object: nil) }
        }
    }

    /// Starts following the scene's capture state.
    func attach(_ scene: UIWindowScene) {
        guard self.scene !== scene else { return }
        self.scene = scene
        if #available(iOS 17.0, *) {
            captureObservation = scene.registerForTraitChanges([UITraitSceneCaptureState.self]) {
                [weak self] (scene: UIWindowScene, _: UITraitCollection) in
                self?.setCaptured(scene.traitCollection.sceneCaptureState == .active)
            }
            setCaptured(scene.traitCollection.sceneCaptureState == .active)
        } else {
            let screen = scene.screen
            captureObservation = NotificationCenter.default.addObserver(
                forName: UIScreen.capturedDidChangeNotification,
                object: screen,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.setCaptured(screen.isCaptured) }
            }
            setCaptured(screen.isCaptured)
        }
    }

    func setInactive(_ inactive: Bool) {
        self.inactive = inactive
        refresh()
    }

    private func setCaptured(_ captured: Bool) {
        let began = captured && !self.captured
        self.captured = captured
        refresh()
        if began && coversScreenCapture {
            NotificationCenter.default.post(name: Self.screenCaptureDidBegin, object: nil)
        }
    }

    private func refresh() {
        let forCapture = captured && coversScreenCapture
        guard forCapture || (inactive && coversInactive), let scene else {
            coverWindow?.isHidden = true
            coverWindow = nil
            captureIcon = nil
            return
        }
        if coverWindow == nil { coverWindow = makeCover(in: scene) }
        // The capture cover stays while the app is in use, so it says why the page is hidden.
        captureIcon?.isHidden = !forCapture
    }

    private func makeCover(in scene: UIWindowScene) -> UIWindow {
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
        let icon = UIImageView(image: UIImage(systemName: "eye.slash"))
        icon.tintColor = .secondaryLabel
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 44, weight: .regular)
        icon.translatesAutoresizingMaskIntoConstraints = false
        blur.contentView.addSubview(icon)
        NSLayoutConstraint.activate([
            icon.centerXAnchor.constraint(equalTo: blur.contentView.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: blur.contentView.centerYAnchor),
        ])
        captureIcon = icon
        window.rootViewController = controller
        window.isHidden = false
        return window
    }
}

/// Exposes the privacy cover choices to Settings and reports the audio output:
/// whether playback would use the device's own speaker, and when the output in
/// use disappears, such as headphones being unplugged or a Bluetooth device
/// disconnecting. On that loss the page pauses at once, so playback does not
/// move to the speaker. Reconnecting never resumes playback.
@objc(KikotoPrivacyPlugin)
public class KikotoPrivacyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KikotoPrivacyPlugin"
    public let jsName = "KikotoPrivacy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "appSwitcherShield", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAppSwitcherShield", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "screenCaptureShield", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setScreenCaptureShield", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "audioOutput", returnType: CAPPluginReturnPromise),
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
        DispatchQueue.main.async {
            call.resolve(["enabled": KikotoPrivacyShield.shared.coversInactive])
        }
    }

    @objc func setAppSwitcherShield(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else {
            call.reject("Missing app switcher choice.")
            return
        }
        DispatchQueue.main.async {
            KikotoPrivacyShield.shared.coversInactive = enabled
            call.resolve()
        }
    }

    @objc func screenCaptureShield(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["enabled": KikotoPrivacyShield.shared.coversScreenCapture])
        }
    }

    @objc func setScreenCaptureShield(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else {
            call.reject("Missing screen capture choice.")
            return
        }
        DispatchQueue.main.async {
            KikotoPrivacyShield.shared.coversScreenCapture = enabled
            call.resolve()
        }
    }

    @objc func audioOutput(_ call: CAPPluginCall) {
        call.resolve(Self.outputState())
    }

    /// Whether audio would play through the device's own speaker.
    private static func outputState() -> [String: Any] {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        let speaker = outputs.contains { $0.portType == .builtInSpeaker || $0.portType == .builtInReceiver }
        return ["speaker": speaker]
    }

    @objc private func audioRouteChanged(_ notification: Notification) {
        let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        let lost = rawReason.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:)) == .oldDeviceUnavailable
        let state = Self.outputState()
        DispatchQueue.main.async { [weak self] in
            if lost {
                // Stop the page media at once, also while the web player is still
                // loading a source and would otherwise ignore an element pause.
                self?.bridge?.webView?.evaluateJavaScript(
                    "document.querySelectorAll('audio,video').forEach(function(media){media.pause();});"
                )
                self?.notifyListeners("audioOutputLost", data: [:])
            }
            self?.notifyListeners("audioOutputChange", data: state)
        }
    }
}
