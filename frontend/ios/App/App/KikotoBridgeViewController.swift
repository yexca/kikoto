import Capacitor
import UIKit
import WebKit

/// Registers the app-local plugins that are not distributed as npm packages.
class KikotoBridgeViewController: CAPBridgeViewController {
    override open func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        let handler = KikotoAssetSchemeHandler.shared
        if let scheme = instanceConfiguration.localURL.scheme, let host = instanceConfiguration.localURL.host {
            handler.appOrigin = "\(scheme)://\(host)"
        }
        configuration.setURLSchemeHandler(handler, forURLScheme: KikotoAssetSchemeHandler.scheme)
        return configuration
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(KikotoAssetTransportPlugin())
        bridge?.registerPluginInstance(KikotoPersonalDataPlugin())
    }
}
