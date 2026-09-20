import { expect, test, type Page } from "@playwright/test";

const recommendationDefaults = {
  affinityBase: 35,
  unmarkedSlots: 12,
  wantSlots: 4,
  listeningSlots: 4,
  finishedSlots: 2,
  relistenSlots: 2,
  shelvedSlots: 0,
  tagWeight: 5,
  tagCap: 25,
  voiceWeight: 10,
  voiceCap: 20,
  circleWeight: 15,
  circleCap: 15,
  favoriteBonus: 10,
  negativeMinEvidence: 2,
  negativeTagWeight: 2,
  negativeTagCap: 6,
  negativeVoiceWeight: 3,
  negativeVoiceCap: 6,
  negativeCircleWeight: 5,
  negativeCircleCap: 5,
  negativeTotalCap: 15,
  jitterAmplitude: 3,
  explorationAmplitude: 18,
};

async function mockCacheSettings(
  page: Page,
  onCleanup: (payload: unknown) => void,
  onSettings: (payload: Record<string, unknown>) => void = () => undefined,
  onHealthCheck: () => void = () => undefined,
  onSourceUpdate: (payload: Record<string, unknown>) => void = () => undefined,
  initialCacheEnabled = true,
) {
  const transcodeClearRequests: string[] = [];
  let currentSettings = {
    anonymousAccessEnabled: false,
    localScanDepth: 3,
    cacheEnabled: initialCacheEnabled,
    cacheLimitGb: 20,
    transcodeCacheLimitGb: 5,
    remoteDownloadLimitGb: 100,
    fetchStagingRetentionDays: 7,
    remoteSaveTemplate: "/data/<source_code>/<code_prefix>_<code_group>/<work_code>",
    remoteDelayBaseSeconds: 0.5,
    remoteDelayRandomSeconds: 1.5,
    remoteBackoffSeconds: 30,
    remoteMaxBackoffSeconds: 300,
    catalogFreshnessDays: 30,
    dlsiteMetadataLanguage: "ja-jp",
    directoryRoutingRules: [
      { id: "main", label: "Main story", weight: 40, aliases: ["main"], negativeAliases: ["bonus"], enabled: true },
      {
        id: "with_se",
        label: "With sound effects",
        weight: 30,
        aliases: ["with se"],
        negativeAliases: [],
        enabled: true,
      },
      { id: "mp3", label: "MP3", weight: 20, aliases: ["mp3"], negativeAliases: ["wav"], enabled: true },
    ],
    recommendationThreshold: 50,
    recommendationConfig: { ...recommendationDefaults },
    recommendationDefaults: { ...recommendationDefaults },
    dataRoot: "/data",
    cacheRoot: "/cache",
    fileSources: [
      {
        id: 1,
        code: "local",
        displayName: "Main local library",
        sourceType: "local_folder",
        priority: 10,
        enabled: true,
        config: { scanDepth: 3 },
        endpoint: {
          baseUrl: "",
          apiUrl: "",
          fallbackUrl: "",
          workUrlTemplate: "",
          restrictOutboundHosts: false,
          allowedHostPatterns: [],
        },
        healthStatus: "healthy",
        lastCheckedAt: "2026-07-26T00:00:00Z",
      },
      {
        id: 8,
        code: "example-remote",
        displayName: "Example Remote",
        sourceType: "kikoeru_compatible",
        priority: 30,
        enabled: true,
        config: { saveRootTemplate: "/data/<source_name>/<work_code>" },
        endpoint: {
          baseUrl: "https://remote.example",
          apiUrl: "https://api.remote.example",
          fallbackUrl: "",
          workUrlTemplate: "/work/{code}",
          restrictOutboundHosts: false,
          allowedHostPatterns: [],
        },
        healthStatus: "unknown",
        lastCheckedAt: null,
      },
    ],
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: {
          authenticated: true,
          user: {
            id: 1,
            username: "admin",
            displayName: "Admin",
            role: "admin",
            permissions: ["library:read", "sources:write", "downloads:manage", "users:manage"],
            devMode: true,
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({
        json: {
          mode: "development",
          demoMode: false,
          anonymousAccessEnabled: false,
          cacheEnabled: currentSettings.cacheEnabled,
          directoryRoutingRules: [],
          recommendationThreshold: 50,
        },
      });
      return;
    }
    if (url.pathname === "/api/auth/me/preferences") {
      if (route.request().method() === "PATCH") {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        onSettings(payload);
        currentSettings = { ...currentSettings, ...payload };
      }
      await route.fulfill({ json: currentSettings });
      return;
    }
    if (url.pathname === "/api/settings" && route.request().method() === "PATCH") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      onSettings(payload);
      currentSettings = { ...currentSettings, ...payload };
      await route.fulfill({ json: currentSettings });
      return;
    }
    if (url.pathname === "/api/settings") {
      await route.fulfill({ json: currentSettings });
      return;
    }
    if (url.pathname === "/api/recommendation-telemetry") {
      await route.fulfill({ json: { windowDays: 30, eventCounts: {}, scoreBuckets: {} } });
      return;
    }
    if (url.pathname === "/api/file-sources/8/health-check" && route.request().method() === "POST") {
      onHealthCheck();
      const source = {
        ...currentSettings.fileSources[1],
        healthStatus: "healthy",
        lastCheckedAt: "2026-07-26T01:00:00Z",
      };
      currentSettings = { ...currentSettings, fileSources: [currentSettings.fileSources[0], source] };
      await route.fulfill({
        json: { healthy: true, healthStatus: source.healthStatus, lastCheckedAt: source.lastCheckedAt, elapsedMs: 24 },
      });
      return;
    }
    if (url.pathname === "/api/file-sources/8" && route.request().method() === "PATCH") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      onSourceUpdate(payload);
      const source = {
        ...currentSettings.fileSources[1],
        ...payload,
        config: {
          ...currentSettings.fileSources[1].config,
          ...(payload.config as Record<string, unknown>),
        },
      };
      currentSettings = { ...currentSettings, fileSources: [currentSettings.fileSources[0], source] };
      await route.fulfill({ json: source });
      return;
    }
    if (url.pathname === "/api/users") {
      await route.fulfill({
        json: [
          {
            id: 1,
            username: "admin",
            displayName: "Admin",
            role: "admin",
            enabled: true,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      });
      return;
    }
    if (url.pathname === "/api/cache/overview") {
      await route.fulfill({
        json: {
          scannedAt: "2026-07-14T00:00:00Z",
          mediaFiles: 14,
          mediaBytes: 157286400,
          referencedFiles: 10,
          referencedBytes: 125829120,
          orphanFiles: 3,
          orphanBytes: 31457280,
          protectedFiles: 1,
          missingReferences: 2,
          emptyDirectories: 1,
          transcode: {
            files: 4,
            bytes: 25165824,
            limitBytes: 5368709120,
            scannedAt: "2026-07-14T00:00:00Z",
          },
          works: [
            {
              groupKey: "1:remote-a:RJ00000001",
              workId: 1,
              workCode: "RJ00000001",
              sourceId: 1,
              sourceCode: "remote-a",
              sourceName: "Example Remote",
              files: 8,
              bytes: 104857600,
              referencedFiles: 6,
              referencedBytes: 83886080,
              orphanFiles: 2,
              orphanBytes: 20971520,
              emptyDirectories: 1,
              tracked: false,
              local: false,
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/api/cache/cleanup" && route.request().method() === "POST") {
      onCleanup(route.request().postDataJSON());
      await route.fulfill({ status: 202, json: { runId: 52, jobId: 53, status: "queued", queued: 4 } });
      return;
    }
    if (url.pathname === "/api/cache/transcodes" && route.request().method() === "DELETE") {
      transcodeClearRequests.push(url.pathname);
      await route.fulfill({ json: { deletedFiles: 4, freedBytes: 25165824 } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });
  return { transcodeClearRequests };
}

test("@desktop cache settings scan managed media and require cleanup confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const cleanupRequests: unknown[] = [];
  const settingsPayloads: Record<string, unknown>[] = [];
  const mocks = await mockCacheSettings(
    page,
    (payload) => {
      cleanupRequests.push(payload);
    },
    (payload) => {
      settingsPayloads.push(payload);
    },
  );
  await page.goto("/maintenance?tab=cache");

  await expect(page.getByText("Managed media cache", { exact: true })).toBeVisible();
  await expect(page.getByTestId("maintenance-content")).toHaveCSS("max-width", "896px");
  await expect(page.getByTestId("cache-configuration-card")).toHaveCSS("max-width", "none");
  const cacheSections = await page
    .getByTestId("maintenance-content")
    .getByText(/^(Configuration|Transcode cache|Managed media cache)$/)
    .allTextContents();
  expect(cacheSections).toEqual(["Configuration", "Transcode cache", "Managed media cache"]);
  await expect(page.getByText("Save path template", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Per-file download limit")).toHaveValue("100");
  await expect(page.getByLabel("Failed staging retention")).toHaveValue("7");
  await expect(page.getByLabel("Transcode cache limit")).toHaveValue("5");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect.poll(() => settingsPayloads).toHaveLength(1);
  expect(settingsPayloads[0]).not.toHaveProperty("remoteSaveTemplate");
  expect(settingsPayloads[0]).toEqual(
    expect.objectContaining({
      transcodeCacheLimitGb: 5,
      remoteDownloadLimitGb: 100,
      fetchStagingRetentionDays: 7,
    }),
  );
  await expect(page.getByText("24 MB", { exact: true })).toBeVisible();
  const transcodeCache = page.getByRole("region", { name: "Transcode cache" });
  await expect(transcodeCache.getByText("5.0 GB", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Clear transcode cache", exact: true }).click();
  expect(mocks.transcodeClearRequests).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm clear (4 files)", exact: true }).click();
  await expect.poll(() => mocks.transcodeClearRequests).toEqual(["/api/cache/transcodes"]);
  await expect(page.getByText("Removed 4 files and freed 24 MB.", { exact: true })).toBeVisible();
  await expect(page.getByText("150 MB", { exact: true })).toBeVisible();
  await expect(page.getByText("30 MB", { exact: true })).toBeVisible();
  await expect(page.getByText("1 groups · 1 works", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand Example Remote cache group" })).toBeVisible();
  await expect(page.getByText("RJ00000001", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Expand Example Remote cache group" }).click();
  await expect(page.getByText("RJ00000001", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Collapse Example Remote cache group" }).click();
  await expect(page.getByText("RJ00000001", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Expand Example Remote cache group" }).click();
  await page.getByRole("checkbox", { name: "Select all cache in Example Remote" }).click();
  await expect(page.getByRole("button", { name: "Clean selected orphans" })).toHaveClass(/bg-destructive/);
  await page.getByRole("button", { name: "Clean selected orphans" }).click();
  expect(cleanupRequests).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Confirm cleanup (2 files)" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm cleanup (2 files)" }).click();
  await expect.poll(() => cleanupRequests).toHaveLength(1);
  expect(cleanupRequests[0]).toEqual({ mode: "orphans", groupKeys: ["1:remote-a:RJ00000001"] });
  await expect(page.getByText("Cleanup queued in workflow run #52 (4 items).", { exact: true })).toBeVisible();
});

test("enabling global playback cache explains tracked synchronization before changing settings", async ({ page }) => {
  const settingsPayloads: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    (payload) => settingsPayloads.push(payload),
    undefined,
    undefined,
    false,
  );
  await page.goto("/maintenance?tab=cache");

  const cacheSwitch = page.getByRole("switch", { name: "Cache remote playback", exact: true });
  await expect(cacheSwitch).toHaveAttribute("aria-checked", "false");
  await cacheSwitch.click();

  const dialog = page.getByRole("alertdialog", { name: "Enable remote playback cache?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("tracked");
  await expect(dialog).toContainText("directory information");
  expect(settingsPayloads).toHaveLength(0);

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(cacheSwitch).toHaveAttribute("aria-checked", "false");
  await expect(dialog).toBeHidden();

  await cacheSwitch.click();
  await page
    .getByRole("alertdialog", { name: "Enable remote playback cache?" })
    .getByRole("button", { name: "Enable cache", exact: true })
    .click();
  await expect(cacheSwitch).toHaveAttribute("aria-checked", "true");
  expect(settingsPayloads).toHaveLength(0);

  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect.poll(() => settingsPayloads).toHaveLength(1);
  expect(settingsPayloads[0]).toEqual(expect.objectContaining({ cacheEnabled: true }));
});

test("cache settings can clear referenced cache for selected works", async ({ page }) => {
  const cleanupRequests: unknown[] = [];
  await mockCacheSettings(page, (payload) => {
    cleanupRequests.push(payload);
  });
  await page.goto("/maintenance?tab=cache");
  await page.getByRole("button", { name: "Work cache", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select all cache in Example Remote" }).click();
  await page.getByRole("button", { name: "Clean selected works" }).click();
  await page.getByRole("button", { name: "Confirm cleanup (6 files)" }).click();
  await expect.poll(() => cleanupRequests).toHaveLength(1);
  expect(cleanupRequests[0]).toEqual({ mode: "works", workIds: [1] });
});

test("personal settings stay separate from administrator maintenance", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Manage your account and appearance preferences", { exact: true })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Appearance", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Recommendation", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cache & Fetch", exact: true })).toHaveCount(0);

  await page.goto("/users");
  await expect(page.getByRole("heading", { name: "Maintenance", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Users", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("User directory", { exact: true })).toBeVisible();
});

test("personal playback seek intervals use the requested defaults and persist locally", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  await page.goto("/settings");

  await page.getByRole("tab", { name: "Playback", exact: true }).click();

  const forward = page.getByRole("spinbutton", { name: /Forward seek/ });
  const backward = page.getByRole("spinbutton", { name: /Backward seek/ });
  await expect(forward).toHaveValue("30");
  await expect(backward).toHaveValue("10");

  await forward.fill("45");
  await backward.fill("15");
  await page.getByRole("button", { name: "Save playback", exact: true }).click();
  await expect(page.getByText("Playback seek settings updated.", { exact: true })).toBeVisible();

  await page.reload();
  await expect(forward).toHaveValue("45");
  await expect(backward).toHaveValue("15");
});

test("development super administrator can configure production anonymous access", async ({ page }) => {
  let anonymousAccessEnabled = false;
  let runtimeRequests = 0;
  const updates: Array<{ anonymousAccessEnabled: boolean }> = [];
  await mockCacheSettings(page, () => undefined);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          id: 1,
          username: "root",
          displayName: "Root",
          role: "super_admin",
          permissions: ["system:admin"],
          devMode: true,
          demoMode: false,
          passwordManagedBy: "environment",
        },
      },
    }),
  );
  await page.route("**/api/runtime-settings", (route) => {
    runtimeRequests += 1;
    return route.fulfill({
      json: {
        mode: "development",
        demoMode: false,
        anonymousAccessEnabled,
        cacheEnabled: true,
        directoryRoutingRules: [],
      },
    });
  });
  await page.route("**/api/access-policy", async (route) => {
    const payload = route.request().postDataJSON() as { anonymousAccessEnabled: boolean };
    updates.push(payload);
    anonymousAccessEnabled = payload.anonymousAccessEnabled;
    await route.fulfill({ json: payload });
  });

  await page.goto("/maintenance?tab=security");
  await expect(page).toHaveURL(/\/maintenance\?tab=users$/);
  await expect(page.getByRole("button", { name: "Users", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("User directory", { exact: true })).toBeVisible();
  const accessSwitch = page.getByRole("switch", { name: "Anonymous access", exact: true });
  const accessRow = page
    .getByText("Library browsing and playback without an account", { exact: true })
    .locator("xpath=../..");
  const saveAccessPolicy = page.getByRole("button", { name: "Save access policy", exact: true });
  const accessRowBox = await accessRow.boundingBox();
  const saveAccessPolicyBox = await saveAccessPolicy.boundingBox();
  expect(accessRowBox).not.toBeNull();
  expect(saveAccessPolicyBox).not.toBeNull();
  expect(Math.abs(saveAccessPolicyBox!.x - accessRowBox!.x)).toBeLessThanOrEqual(1);
  await expect(accessSwitch).toHaveAttribute("aria-checked", "false");
  await accessSwitch.click();
  await saveAccessPolicy.click();

  await expect.poll(() => updates).toEqual([{ anonymousAccessEnabled: true }]);
  await expect.poll(() => runtimeRequests).toBeGreaterThanOrEqual(2);
  await expect(accessSwitch).toHaveAttribute("aria-checked", "true");
  await expect(saveAccessPolicy).toBeDisabled();
  await expect(page.getByText("Access policy saved.", { exact: true })).toBeVisible();
});

test("work maintenance mounts once and keeps its result region stable while settings load", async ({ page }) => {
  let releaseSettings = () => undefined;
  let releaseWorks = () => undefined;
  const settingsGate = new Promise<void>((resolve) => {
    releaseSettings = resolve;
  });
  const worksGate = new Promise<void>((resolve) => {
    releaseWorks = resolve;
  });
  await mockCacheSettings(page, () => undefined);
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await settingsGate;
    await route.fallback();
  });
  await page.route("**/api/maintenance/works?**", async (route) => {
    await worksGate;
    await route.fulfill({ json: { works: [], page: 1, pageSize: 25, total: 0 } });
  });

  await page.goto("/maintenance?tab=unlinked");
  const heading = page.getByRole("heading", { name: "Pending works", exact: true });
  await expect(heading).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading work maintenance" })).toBeVisible();
  const panel = page.getByRole("region", { name: "Metadata records", exact: true });
  const loadingBox = await panel.boundingBox();

  releaseWorks();
  await expect(page.getByText("No works need attention.", { exact: true })).toBeVisible();
  const emptyBox = await panel.boundingBox();
  expect(loadingBox).not.toBeNull();
  expect(emptyBox).not.toBeNull();
  expect(Math.abs(emptyBox!.height - loadingBox!.height)).toBeLessThanOrEqual(1);
  releaseSettings();
});

test("users mounts before settings and a one-user result does not collapse the page", async ({ page }) => {
  let releaseSettings = () => undefined;
  let releaseUsers = () => undefined;
  const settingsGate = new Promise<void>((resolve) => {
    releaseSettings = resolve;
  });
  const usersGate = new Promise<void>((resolve) => {
    releaseUsers = resolve;
  });
  await mockCacheSettings(page, () => undefined);
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await settingsGate;
    await route.fallback();
  });
  await page.route("**/api/users", async (route) => {
    await usersGate;
    await route.fallback();
  });

  await page.goto("/users");
  await expect(page.getByText("User directory", { exact: true })).toBeVisible();
  const content = page.getByTestId("maintenance-content");
  const loadingBox = await content.boundingBox();

  releaseUsers();
  await expect(page.getByText("@admin", { exact: true }).first()).toBeVisible();
  const loadedBox = await content.boundingBox();
  expect(loadingBox).not.toBeNull();
  expect(loadedBox).not.toBeNull();
  expect(Math.abs(loadedBox!.height - loadingBox!.height)).toBeLessThanOrEqual(2);
  releaseSettings();
});

for (const layout of ["mobile", "@desktop"]) {
  test(`${layout} maintenance sections stay in one scrollable row`, async ({ page }) => {
    await mockCacheSettings(page, () => undefined);
    await page.goto("/maintenance");
    const navigation = page.getByRole("navigation", { name: "Maintenance sections", exact: true });
    await expect(navigation.getByRole("button", { name: "Library", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(navigation.getByRole("button")).toHaveCount(3);
    await expect(navigation.getByRole("button", { name: /^(Overview|Paths|Access)$/ })).toHaveCount(0);
    const rows = await navigation
      .getByRole("button")
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByText("Storage paths", { exact: true })).toBeVisible();
    await navigation.getByRole("button", { name: "Users", exact: true }).click();
    await expect(page.getByText("User directory", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole("switch", { name: "Anonymous access", exact: true })).toHaveCount(0);
  });
}

test("user managers open Users without fetching source settings", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  let settingsRequests = 0;
  await page.route("**/api/settings", async (route) => {
    settingsRequests += 1;
    await route.fulfill({ status: 403, json: { error: "Forbidden" } });
  });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          id: 1,
          username: "synthetic-user",
          displayName: "Example User",
          role: "user",
          permissions: ["users:manage"],
          devMode: false,
        },
      },
    }),
  );
  await page.goto("/maintenance");
  const navigation = page.getByRole("navigation", { name: "Maintenance sections", exact: true });
  await expect(navigation.getByRole("button")).toHaveCount(1);
  await expect(navigation.getByRole("button", { name: "Users", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("@admin", { exact: true }).first()).toBeVisible();
  expect(settingsRequests).toBe(0);
  await expect(page.getByRole("switch", { name: "Anonymous access", exact: true })).toHaveCount(0);
});

test("maintenance combines library sources and exposes read-only paths with health checks", async ({ page }) => {
  let healthChecks = 0;
  const sourceUpdates: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    () => undefined,
    () => {
      healthChecks += 1;
    },
    (payload) => sourceUpdates.push(payload),
  );
  await page.goto("/maintenance?tab=library");

  await expect(page.getByText("Local library", { exact: true })).toBeVisible();
  await expect(page.getByText("Remote sources", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sources", exact: true })).toHaveCount(0);
  const maintenanceHeader = page.getByRole("heading", { name: "Maintenance", exact: true }).locator("..");
  await expect(maintenanceHeader.getByText("Sources", { exact: true })).toHaveCount(0);
  await expect(maintenanceHeader.getByText("Cache", { exact: true })).toHaveCount(0);
  await expect(maintenanceHeader.getByText("Scan", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Check health", exact: true }).click();
  await expect.poll(() => healthChecks).toBe(1);
  await expect(page.getByText("healthy", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Cache Example Remote", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Configure", exact: true }).click();
  const sourceDialog = page.getByRole("dialog", { name: "Edit remote source" });
  await expect(sourceDialog.getByLabel("Save path preview")).toHaveValue("/data/example-remote/RJ00000000");
  await expect(sourceDialog.getByText("Cache GB", { exact: true })).toHaveCount(0);
  await expect(sourceDialog.getByRole("switch", { name: "Cache this source", exact: true })).toHaveCount(0);
  await expect(sourceDialog.getByText("Save path template", { exact: true })).toHaveCount(0);
  await expect(sourceDialog.getByRole("switch", { name: "Restrict outbound hosts" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(sourceDialog.getByLabel("Additional allowed hosts")).toHaveCount(0);
  await sourceDialog.getByRole("switch", { name: "Restrict outbound hosts" }).click();
  await expect(sourceDialog.getByText("https://api.remote.example", { exact: true })).toBeVisible();
  await expect(sourceDialog.getByText("https://remote.example", { exact: true })).toBeVisible();
  await sourceDialog.getByLabel("Additional allowed hosts").fill("cdn.example.invalid\n*.media.example.invalid");
  await sourceDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => sourceUpdates.length).toBe(1);
  expect(sourceUpdates[0]?.endpoint).toEqual(
    expect.objectContaining({
      restrictOutboundHosts: true,
      allowedHostPatterns: ["cdn.example.invalid", "*.media.example.invalid"],
    }),
  );

  await page.getByRole("button", { name: "Delete source", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete remote source" });
  await expect(deleteDialog.getByText("Example Remote", { exact: true })).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deleteDialog).toBeHidden();

  await expect(page.getByRole("button", { name: "Paths", exact: true })).toHaveCount(0);
  await expect(page.getByText("Storage paths", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Remote save path preview")).toHaveValue("/data/source/RJ_000/RJ00000000");
  await expect(page.getByLabel("Example Remote")).toHaveValue("/data/example-remote/RJ00000000");
  await expect(page.getByRole("button", { name: /Save.*path/i })).toHaveCount(0);
});

test("remote source deep links open the requested source configuration", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  await page.goto("/maintenance?tab=library&source=8");

  const sourceDialog = page.getByRole("dialog", { name: "Edit remote source" });
  await expect(sourceDialog).toBeVisible();
  await expect(sourceDialog.getByLabel("Name")).toHaveValue("Example Remote");
  await sourceDialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/maintenance\?tab=library$/);
});

test("routing drag order becomes the saved internal priority", async ({ page }) => {
  const settingsPayloads: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    (payload) => settingsPayloads.push(payload),
  );
  await page.goto("/maintenance?tab=routing");
  await expect(page).toHaveURL(/\/settings\?tab=playback$/);

  await expect(page.getByText("Weight", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Enabled", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Drag Main story" }).dragTo(page.getByRole("button", { name: "Drag MP3" }));
  await expect(page.locator('[data-routing-rule-id="main"]')).not.toHaveClass(/opacity-55/);
  await page.getByRole("button", { name: "Save playback settings" }).click();

  await expect.poll(() => settingsPayloads.length).toBe(1);
  const rules = settingsPayloads[0].directoryRoutingRules as Array<{ id: string; weight: number; enabled: boolean }>;
  expect(rules.map((rule) => rule.id)).toEqual(["with_se", "mp3", "main"]);
  expect(rules.map((rule) => rule.weight)).toEqual([40, 30, 20]);
  expect(rules.every((rule) => rule.enabled)).toBe(true);
});

test("recommendation keeps common controls visible and advanced scoring collapsed", async ({ page }) => {
  const settingsPayloads: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    (payload) => settingsPayloads.push(payload),
  );
  await page.goto("/maintenance?tab=recommendation");
  await expect(page).toHaveURL(/\/settings\?tab=recommendation$/);

  await expect(page.getByRole("button", { name: /Balanced/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Badge threshold")).toBeVisible();
  await expect(page.getByLabel("Result variation")).toBeVisible();
  await expect(page.getByLabel("Positive tag weight")).toBeHidden();
  await page.getByRole("button", { name: /Exploratory/ }).click();
  await expect(page.getByLabel("Result variation")).toHaveValue("8");
  await expect(page.getByLabel("Discovery boost")).toHaveValue("30");
  await page.getByText("Advanced scoring", { exact: true }).click();
  await expect(page.getByLabel("Unmarked")).toHaveValue("16");
  await expect(page.getByRole("spinbutton", { name: "Shelved", exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Positive tag weight")).toBeVisible();
  await page.getByRole("button", { name: "Save recommendation settings" }).click();
  await expect.poll(() => settingsPayloads.length).toBe(1);
  expect((settingsPayloads[0].recommendationConfig as { jitterAmplitude: number }).jitterAmplitude).toBe(8);
  expect((settingsPayloads[0].recommendationConfig as { explorationAmplitude: number }).explorationAmplitude).toBe(30);
  expect(Object.keys(settingsPayloads[0]).sort()).toEqual(["recommendationConfig", "recommendationThreshold"]);
  await page.reload();
  await expect(page.getByLabel("Discovery boost")).toHaveValue("30");
});

test("recommendation restores all default weights and threshold before saving", async ({ page }) => {
  const settingsPayloads: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    (payload) => settingsPayloads.push(payload),
  );
  await page.goto("/settings?tab=recommendation");
  await page.getByRole("button", { name: /Exploratory/ }).click();
  await page.getByLabel("Badge threshold").focus();
  await page.getByLabel("Badge threshold").press("End");
  await expect(page.getByLabel("Badge threshold")).toHaveValue("100");
  await page.getByRole("button", { name: "Save recommendation settings" }).click();
  await expect.poll(() => settingsPayloads.length).toBe(1);
  await page.reload();
  await expect(page.getByLabel("Discovery boost")).toHaveValue("30");

  await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
  await page.getByRole("button", { name: "Save recommendation settings" }).click();
  await expect.poll(() => settingsPayloads.length).toBe(2);
  expect(settingsPayloads[1]).toEqual({
    recommendationConfig: recommendationDefaults,
    recommendationThreshold: 50,
  });
  await page.reload();
  await expect(page.getByLabel("Result variation")).toHaveValue("3");
  await expect(page.getByLabel("Discovery boost")).toHaveValue("18");
  await expect(page.getByLabel("Badge threshold")).toHaveValue("50");
});

test("@desktop work management owns metadata settings and links to the existing workflow", async ({
  page,
}, testInfo) => {
  const saves: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    (payload) => saves.push(payload),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          id: 1,
          username: "admin",
          displayName: "Admin",
          role: "admin",
          permissions: ["library:read", "sources:write", "metadata:sync", "workflows:run"],
        },
      },
    }),
  );
  await page.goto("/maintenance?tab=metadata");
  await expect(page).toHaveURL(/metadata\?tab=settings/);
  await expect(page.getByRole("dialog", { name: "Metadata settings", exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Catalog freshness days", exact: true }).fill("14");
  await page.getByRole("button", { name: "Save metadata settings", exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(Object.keys(saves[0]).sort()).toEqual(["catalogFreshnessDays", "dlsiteMetadataLanguages"]);
  expect(saves[0].catalogFreshnessDays).toBe(14);
  await page.screenshot({ path: testInfo.outputPath("work-management-settings.png") });
  await page
    .getByRole("dialog", { name: "Metadata settings", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "Metadata sync", exact: true }).click();
  await expect(page).toHaveURL(/workflows\?workflow=metadata_sync/);
});

test("ordinary users save folder preferences without instance administration", async ({ page }) => {
  const saves: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    (payload) => saves.push(payload),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          id: 1,
          username: "synthetic-user",
          displayName: "Example User",
          role: "user",
          permissions: ["library:read"],
        },
      },
    }),
  );
  let instanceRequests = 0;
  await page.route("**/api/settings", (route) => {
    instanceRequests++;
    return route.fulfill({ status: 403, json: { error: "Forbidden" } });
  });
  await page.goto("/settings?tab=playback");
  await expect(page.getByRole("heading", { name: /^Folder preference/ })).toBeVisible();
  await page.getByRole("button", { name: "Save playback settings", exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(Object.keys(saves[0])).toEqual(["directoryRoutingRules"]);
  expect(instanceRequests).toBe(0);
});
