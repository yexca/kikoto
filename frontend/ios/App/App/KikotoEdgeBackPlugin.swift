import Capacitor
import UIKit

/// Reports a left screen-edge swipe so the web app can apply its own back
/// order: command palette, sign-in, dialogs, the player, then history. The
/// plugin never navigates or leaves the app by itself.
@objc(KikotoEdgeBackPlugin)
public class KikotoEdgeBackPlugin: CAPPlugin, CAPBridgedPlugin, UIGestureRecognizerDelegate {
    public let identifier = "KikotoEdgeBackPlugin"
    public let jsName = "KikotoEdgeBack"
    public let pluginMethods: [CAPPluginMethod] = []

    private static let minimumDistance: CGFloat = 64
    private static let minimumFlickDistance: CGFloat = 24
    private static let minimumFlickVelocity: CGFloat = 600

    // Accessed only on the main queue.
    private var recognizer: UIScreenEdgePanGestureRecognizer?
    private var startPoint = CGPoint.zero

    override public func load() {
        DispatchQueue.main.async { [weak self] in
            self?.attach()
        }
    }

    private func attach() {
        guard recognizer == nil, let webView = bridge?.webView else { return }
        let edgePan = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdgePan(_:)))
        edgePan.edges = .left
        // The page keeps receiving the touch; it decides whether the swipe
        // belonged to a horizontal control under the finger.
        edgePan.cancelsTouchesInView = false
        edgePan.delaysTouchesBegan = false
        edgePan.delaysTouchesEnded = false
        edgePan.delegate = self
        webView.addGestureRecognizer(edgePan)
        recognizer = edgePan
    }

    @objc private func handleEdgePan(_ recognizer: UIScreenEdgePanGestureRecognizer) {
        guard let view = recognizer.view else { return }
        switch recognizer.state {
        case .began:
            let location = recognizer.location(in: view)
            let translation = recognizer.translation(in: view)
            startPoint = CGPoint(x: location.x - translation.x, y: location.y - translation.y)
        case .ended:
            let translation = recognizer.translation(in: view)
            let velocity = recognizer.velocity(in: view)
            let horizontal = translation.x > abs(translation.y) * 1.5
            let committed = translation.x >= Self.minimumDistance
                || (translation.x >= Self.minimumFlickDistance && velocity.x >= Self.minimumFlickVelocity)
            guard horizontal, committed else { return }
            // WKWebView points match viewport CSS pixels at the page's initial scale.
            notifyListeners("edgeBack", data: ["x": startPoint.x, "y": startPoint.y])
        default:
            break
        }
    }

    public func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }
}
