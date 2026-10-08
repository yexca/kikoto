import Capacitor

@objc(KikotoAssetTransportPlugin)
public class KikotoAssetTransportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KikotoAssetTransportPlugin"
    public let jsName = "KikotoAssetTransport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    @objc func configure(_ call: CAPPluginCall) {
        let configured = KikotoAssetSchemeHandler.shared.configure(
            serverURL: call.getString("serverUrl") ?? "",
            credential: call.getString("sessionToken") ?? ""
        )
        if configured {
            call.resolve()
        } else {
            call.reject("Invalid mobile server configuration.")
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        KikotoAssetSchemeHandler.shared.clear()
        call.resolve()
    }
}
