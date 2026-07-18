import { describe, expect, it } from "vitest";

import { appVersionStatus, compareVersions, githubReleaseURL } from "./versioning";

describe("application versioning", () => {
  it("distinguishes client, server, and minimum-version updates", () => {
    expect(appVersionStatus("v0.2.0", "v0.2.0")).toBe("compatible");
    expect(appVersionStatus("v0.2.0", "")).toBe("compatible");
    expect(appVersionStatus("v0.2.0", "v0.3.0")).toBe("client-update-available");
    expect(appVersionStatus("v0.3.0", "v0.2.0")).toBe("server-update-available");
    expect(appVersionStatus("v0.2.0", "v0.2.0", "v0.2.1")).toBe("client-update-required");
  });

  it("compares normalized semantic versions", () => {
    expect(compareVersions("v0.2.10", "0.2.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  it("builds exact release links and falls back safely for development versions", () => {
    expect(githubReleaseURL("v0.2.0")).toBe("https://github.com/yexca/kikoto/releases/tag/v0.2.0");
    expect(githubReleaseURL("development")).toBe("https://github.com/yexca/kikoto/releases/latest");
  });
});
