import { registerPlugin } from "@capacitor/core";

import { isNativeApp } from "@/lib/serverConfig";

type KikotoPersonalDataPlugin = {
  /** Opens the Android document picker for `kikoto-user-data.json`; `saved` is false when the user cancels. */
  saveExport(options: { data: string }): Promise<{ saved: boolean }>;
};

const KikotoPersonalData = registerPlugin<KikotoPersonalDataPlugin>("KikotoPersonalData");

export type UserDataExportSaveResult = "saved" | "cancelled";

type BrowserDownloadEnvironment = {
  document: Pick<Document, "createElement" | "body">;
  url: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
};

/**
 * Saves an exported personal-data document. The Android app hands the JSON to
 * the system document picker and waits for the user's choice; a browser
 * downloads it as a file. The JSON is compact so a large export stays within
 * the import size limit when it is imported again.
 */
export async function saveUserDataExport(
  exportedDocument: unknown,
  fileName: string,
  environment: BrowserDownloadEnvironment = {
    document,
    url: URL,
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  },
): Promise<UserDataExportSaveResult> {
  const data = JSON.stringify(exportedDocument);
  if (isNativeApp()) {
    const result = await KikotoPersonalData.saveExport({ data });
    return result?.saved === true ? "saved" : "cancelled";
  }
  downloadInBrowser(data, fileName, environment);
  return "saved";
}

function downloadInBrowser(data: string, fileName: string, environment: BrowserDownloadEnvironment) {
  const url = environment.url.createObjectURL(new Blob([data], { type: "application/json" }));
  const link = environment.document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  environment.document.body.append(link);
  link.click();
  link.remove();
  // The download reads the object URL asynchronously; release it once it has started.
  environment.setTimeout(() => environment.url.revokeObjectURL(url), 60_000);
}
