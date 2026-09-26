import { beforeEach, describe, expect, it, vi } from "vitest";

const isNativeApp = vi.hoisted(() => vi.fn(() => false));
const plugin = vi.hoisted(() => ({ saveExport: vi.fn() }));
const registerPlugin = vi.hoisted(() => vi.fn(() => plugin));

vi.mock("@capacitor/core", () => ({ registerPlugin }));
vi.mock("@/lib/serverConfig", () => ({ isNativeApp }));

import { syntheticWorkCode } from "@/test-support/workCode";

import { saveUserDataExport } from "./userDataExportFile";

const exported = {
  format: "kikoto-user-data",
  version: 1,
  works: [{ primaryCode: syntheticWorkCode("RJ", 0), note: "Example note" }],
};

function browserEnvironment() {
  const link = { href: "", download: "", rel: "", click: vi.fn(), remove: vi.fn() };
  const timers: Array<() => void> = [];
  const environment = {
    document: {
      createElement: vi.fn(() => link),
      body: { append: vi.fn() },
    } as unknown as Pick<Document, "createElement" | "body">,
    url: { createObjectURL: vi.fn((_blob: Blob) => "blob:kikoto-export"), revokeObjectURL: vi.fn() },
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return 0;
    },
  };
  return { environment, link, timers };
}

describe("personal data export file", () => {
  beforeEach(() => {
    isNativeApp.mockReturnValue(false);
    plugin.saveExport.mockReset();
  });

  it("hands compact JSON to the Android save picker and reports a completed save", async () => {
    isNativeApp.mockReturnValue(true);
    plugin.saveExport.mockResolvedValue({ saved: true });
    const { environment } = browserEnvironment();

    await expect(saveUserDataExport(exported, "ignored.json", environment)).resolves.toBe("saved");
    expect(plugin.saveExport).toHaveBeenCalledWith({ data: JSON.stringify(exported) });
    expect(plugin.saveExport.mock.calls[0][0].data).not.toContain("\n");
    expect(environment.url.createObjectURL).not.toHaveBeenCalled();
  });

  it("treats a dismissed Android picker as a cancellation rather than a success", async () => {
    isNativeApp.mockReturnValue(true);
    plugin.saveExport.mockResolvedValue({ saved: false });
    await expect(saveUserDataExport(exported, "ignored.json", browserEnvironment().environment)).resolves.toBe(
      "cancelled",
    );
  });

  it("surfaces a native save failure to the caller", async () => {
    isNativeApp.mockReturnValue(true);
    plugin.saveExport.mockRejectedValue(new Error("write failed"));
    await expect(saveUserDataExport(exported, "ignored.json", browserEnvironment().environment)).rejects.toThrow(
      "write failed",
    );
  });

  it("downloads a compact JSON blob in the browser and releases its URL later", async () => {
    const { environment, link, timers } = browserEnvironment();

    await expect(saveUserDataExport(exported, "kikoto-user-data-2026-01-01.json", environment)).resolves.toBe("saved");
    expect(plugin.saveExport).not.toHaveBeenCalled();
    const blob = environment.url.createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("application/json");
    await expect(blob.text()).resolves.toBe(JSON.stringify(exported));
    expect(link.download).toBe("kikoto-user-data-2026-01-01.json");
    expect(link.click).toHaveBeenCalledOnce();
    expect(environment.url.revokeObjectURL).not.toHaveBeenCalled();
    timers.forEach((callback) => callback());
    expect(environment.url.revokeObjectURL).toHaveBeenCalledWith("blob:kikoto-export");
  });
});
