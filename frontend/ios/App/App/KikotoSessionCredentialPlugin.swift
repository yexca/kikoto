import Capacitor
import Foundation
import Security

/// Keeps the configured server's bearer session in the Keychain. The item is
/// readable after the first unlock, so background playback can still reach the
/// server, and is never restored from a backup or moved to another device.
@objc(KikotoSessionCredentialPlugin)
public class KikotoSessionCredentialPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KikotoSessionCredentialPlugin"
    public let jsName = "KikotoSessionCredential"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    private static let account = "session"
    private static let maxCredentialBytes = 4096

    private static func itemQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "\(Bundle.main.bundleIdentifier ?? "kikoto").session",
            kSecAttrAccount as String: account,
        ]
    }

    @objc func read(_ call: CAPPluginCall) {
        var query = Self.itemQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
                call.reject("Unable to read the stored session.")
                return
            }
            call.resolve(["value": value])
        case errSecItemNotFound:
            call.resolve(["value": ""])
        default:
            call.reject("Unable to read the stored session.")
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        let data = Data((call.getString("value") ?? "").utf8)
        guard !data.isEmpty, data.count <= Self.maxCredentialBytes else {
            call.reject("Invalid session.")
            return
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(Self.itemQuery() as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let item = Self.itemQuery().merging(attributes) { _, new in new }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Unable to store the session.")
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        let status = SecItemDelete(Self.itemQuery() as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Unable to remove the stored session.")
        }
    }
}
