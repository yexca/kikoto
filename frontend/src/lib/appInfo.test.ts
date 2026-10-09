import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "v0.0.1";
  return vi.fn(() => "web");
});

vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: platform } }));

import { appClientKind, appClientPlatformName, versionLabel } from "./appInfo";

describe("displayed client kind", () => {
  beforeEach(() => platform.mockReset());

  it("labels the iOS shell as ios rather than android", () => {
    platform.mockReturnValue("ios");
    expect(appClientKind()).toBe("ios");
    expect(versionLabel()).toBe("ios v0.0.1");
    expect(appClientPlatformName()).toBe("iOS");
  });

  it("keeps the Android shell label unchanged", () => {
    platform.mockReturnValue("android");
    expect(versionLabel()).toBe("android v0.0.1");
    expect(appClientPlatformName()).toBe("Android");
  });

  it("labels a browser session as web", () => {
    platform.mockReturnValue("web");
    expect(versionLabel()).toBe("web v0.0.1");
    expect(appClientPlatformName()).toBe("Web");
  });
});
