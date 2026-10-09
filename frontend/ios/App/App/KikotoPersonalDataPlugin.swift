import Capacitor
import UIKit

/// Saves only a user-requested personal export to the system-selected document.
@objc(KikotoPersonalDataPlugin)
public class KikotoPersonalDataPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "KikotoPersonalDataPlugin"
    public let jsName = "KikotoPersonalData"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveExport", returnType: CAPPluginReturnPromise)
    ]

    private static let maxExportBytes = 10 * 1024 * 1024
    private static let exportFileName = "kikoto-user-data.json"

    // Accessed only on the main queue.
    private var pendingCall: CAPPluginCall?
    private var pendingDirectory: URL?

    @objc func saveExport(_ call: CAPPluginCall) {
        let data = Data((call.getString("data") ?? "").utf8)
        if data.count > Self.maxExportBytes {
            call.reject("Personal export is too large.")
            return
        }
        guard
            let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            call.reject("Invalid personal export.")
            return
        }
        guard document["format"] as? String == "kikoto-user-data", document["version"] as? Int == 1 else {
            call.reject("Unsupported personal export.")
            return
        }

        DispatchQueue.main.async {
            if self.pendingCall != nil {
                call.reject("An export is already open.")
                return
            }
            guard let presenter = self.bridge?.viewController else {
                call.reject("Unable to open the document picker.")
                return
            }
            // The picker copies this private staging file to the destination the
            // user chooses; no filesystem path is accepted from JavaScript.
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            let file = directory.appendingPathComponent(Self.exportFileName)
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: file, options: [.atomic, .completeFileProtection])
            } catch {
                try? FileManager.default.removeItem(at: directory)
                call.reject("Unable to save the personal export.")
                return
            }
            self.pendingCall = call
            self.pendingDirectory = directory
            let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finishExport(saved: !urls.isEmpty)
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finishExport(saved: false)
    }

    private func finishExport(saved: Bool) {
        if let directory = pendingDirectory {
            try? FileManager.default.removeItem(at: directory)
        }
        pendingDirectory = nil
        let call = pendingCall
        pendingCall = nil
        call?.resolve(["saved": saved])
    }
}
