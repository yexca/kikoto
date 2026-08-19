import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getStoredServerURL = vi.hoisted(() => vi.fn(() => ""));
const isNativeApp = vi.hoisted(() => vi.fn(() => false));

vi.mock("@/lib/appInfo", () => ({
  APP_CLIENT_VERSION: "v0.4.1",
  versionLabel: () => "android v0.4.1",
}));
vi.mock("@/lib/serverConfig", () => ({ getStoredServerURL, isNativeApp }));

async function loadDiagnostics() {
  vi.resetModules();
  return import("./mobileDiagnostics");
}

describe("mobile diagnostics", () => {
  beforeEach(() => {
    getStoredServerURL.mockReset();
    getStoredServerURL.mockReturnValue("https://server.example.invalid");
    isNativeApp.mockReset();
    isNativeApp.mockReturnValue(false);
    vi.stubGlobal("navigator", { onLine: true });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("does not retain diagnostics in a browser session", async () => {
    const diagnostics = await loadDiagnostics();
    diagnostics.recordApiError({ method: "GET", path: "/api/works", status: 503, message: "Unavailable" });

    const text = diagnostics.buildMobileDiagnosticsText({ serverVersion: "v0.4.1", user: "synthetic-user" });
    expect(text).toContain("Server: https://server.example.invalid");
    expect(text).toContain("- none");
    expect(text).not.toContain("GET /api/works");
  });

  it("keeps only the newest bounded set of native diagnostic events", async () => {
    isNativeApp.mockReturnValue(true);
    const diagnostics = await loadDiagnostics();
    for (let index = 0; index < 31; index++) {
      diagnostics.recordDiagnostic({ kind: "runtime", message: `Synthetic event ${index}` });
    }

    const text = diagnostics.buildMobileDiagnosticsText({ connection: "online" });
    expect(text).toContain("Client: android v0.4.1");
    expect(text).toContain("Connection: online");
    expect(text).not.toContain("Synthetic event 0");
    expect(text).toContain("Synthetic event 1");
    expect(text).toContain("Synthetic event 30");
  });
});
