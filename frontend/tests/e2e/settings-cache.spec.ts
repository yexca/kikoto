import { expect, test, type Page } from "@playwright/test";

import type {
  AccessPolicy,
  api,
  AppSettings,
  CacheMaintenanceResult,
  CacheOverview,
  DatabaseCleanupResult,
  DatabaseMaintenanceOverview,
  FileSource,
  FileSourceDetectResult,
  FileSourceHealthCheckResult,
  LibraryLayout,
  LocalWorkCleanupPage,
  MaintenanceWorkPage,
  ManagedUser,
  RecommendationConfig,
  RecordRoot,
  RecommendationTelemetrySummary,
  TranscodeCacheClearResult,
  UserPreferences,
  WorkflowDefinition,
  WorkflowTrigger,
} from "../../src/lib/api";
import {
  type ApiErrorBody,
  authenticatedStateFixture,
  fileSourceFixture,
  fixtureTimestamp,
  runtimeSettingsFixture,
} from "./fixtures/api";

type SettingsUpdate = Parameters<typeof api.updateSettings>[0];
type ProxyPayload = NonNullable<SettingsUpdate["proxy"]>;
type PreferencesUpdate = Parameters<typeof api.updateUserPreferences>[0];
type FileSourceWrite = Parameters<typeof api.updateFileSource>[1];

function managedUserFixture(overrides: Partial<ManagedUser> = {}): ManagedUser {
  return {
    id: 1,
    username: "admin",
    displayName: "Admin",
    role: "admin",
    enabled: true,
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
    ...overrides,
  };
}

const forbidden: ApiErrorBody = { error: "Forbidden" };

const recommendationDefaults: RecommendationConfig = {
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
  ratingFiveWeight: 150,
  ratingFourWeight: 100,
  ratingTwoWeight: 75,
  ratingOneWeight: 125,
  relistenWeight: 50,
  shelvedWeight: 35,
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
  const databaseCleanupRequests: unknown[] = [];
  let currentSettings: AppSettings = {
    anonymousAccessEnabled: false,
    localScanDepth: 3,
    cacheEnabled: initialCacheEnabled,
    cacheLimitGb: 20,
    transcodeCacheLimitGb: 5,
    transcodeSlots: 2,
    remoteDownloadLimitGb: 100,
    fetchStagingRetentionDays: 7,
    remoteSaveTemplate: "/data/<source_code>/<code_prefix>_<code_group>/<work_code>",
    remoteDelayBaseSeconds: 0.5,
    remoteDelayRandomSeconds: 1.5,
    remoteBackoffSeconds: 30,
    remoteMaxBackoffSeconds: 300,
    catalogFreshnessDays: 30,
    proxy: {
      hostAddress: "host.docker.internal",
      proxies: [
        {
          id: "lan",
          name: "",
          kind: "custom",
          scheme: "http",
          host: "192.0.2.10",
          port: 8080,
          username: "",
          hasPassword: false,
        },
      ],
      routes: {
        dlsite: { enabled: false, proxyIds: [] },
        remote: { enabled: false, proxyIds: [] },
        ai: { enabled: false, proxyIds: [] },
        other: { enabled: false, proxyIds: [] },
        sources: {},
      },
      directFallback: false,
      bypass: ["localhost", "192.168.0.0/16"],
      defaultBypass: ["localhost", "192.168.0.0/16"],
    },
    kikoeruImportPrivateAddresses: false,
    hideRemoteSourceAddresses: true,
    folderLyricsMode: "copy",
    recordLibraryEnabled: false,
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
      fileSourceFixture({
        displayName: "Main local library",
        sourceType: "local_folder",
        priority: 10,
        config: { scanDepth: 3 },
        lastCheckedAt: "2026-07-26T00:00:00Z",
      }),
      fileSourceFixture({
        id: 8,
        code: "example-remote",
        displayName: "Example Remote",
        sourceType: "kikoeru_compatible",
        priority: 30,
        config: { saveRootTemplate: "/data/<source_name>/<work_code>" },
        endpoint: {
          ...fileSourceFixture().endpoint,
          baseUrl: "https://remote.example",
          apiUrl: "https://api.remote.example",
          workUrlTemplate: "/work/{code}",
        },
        healthStatus: "unknown",
      }),
    ],
  };
  let metadataLanguages: string[] | null = null;
  let timeZone: string | null = null;
  const currentPreferences = (): UserPreferences => ({
    directoryRoutingRules: currentSettings.directoryRoutingRules,
    recommendationConfig: currentSettings.recommendationConfig,
    recommendationThreshold: currentSettings.recommendationThreshold,
    recommendationDefaults: currentSettings.recommendationDefaults,
    metadataLanguages,
    timeZone,
    forYouTemperature: "balanced",
  });
  const replaceRemoteSource = (source: FileSource) => {
    currentSettings = { ...currentSettings, fileSources: [currentSettings.fileSources[0], source] };
  };
  let recordRoot: RecordRoot = { id: 1, displayName: "Record", state: "unconfigured", scanGeneration: 0 };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: authenticatedStateFixture({
          username: "admin",
          displayName: "Admin",
          role: "admin",
          permissions: ["library:read", "sources:write", "downloads:manage", "users:manage"],
          devMode: true,
        }),
      });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({
        json: runtimeSettingsFixture({
          anonymousAccessEnabled: false,
          cacheEnabled: currentSettings.cacheEnabled,
          recordLibraryEnabled: currentSettings.recordLibraryEnabled,
        }),
      });
      return;
    }
    if (url.pathname.startsWith("/api/records")) {
      // Like the server: Record answers only while it is on.
      if (!currentSettings.recordLibraryEnabled) {
        await route.fulfill({ status: 404, json: { error: "The record library is turned off." } });
        return;
      }
      if (url.pathname === "/api/records/root/initialize" && route.request().method() === "POST") {
        recordRoot = { ...recordRoot, state: "online" };
      }
      await route.fulfill({ json: { root: recordRoot } });
      return;
    }
    if (url.pathname === "/api/auth/me/preferences") {
      if (route.request().method() === "PATCH") {
        const { metadataLanguages: languages, ...payload } = route.request().postDataJSON() as PreferencesUpdate;
        onSettings(languages === undefined ? payload : { ...payload, metadataLanguages: languages });
        if (languages !== undefined) metadataLanguages = languages;
        if (payload.timeZone !== undefined) timeZone = payload.timeZone;
        currentSettings = { ...currentSettings, ...payload };
      }
      await route.fulfill({ json: currentPreferences() });
      return;
    }
    if (url.pathname === "/api/settings" && route.request().method() === "PATCH") {
      const { proxy, ...payload } = route.request().postDataJSON() as SettingsUpdate;
      onSettings(proxy ? { ...payload, proxy } : payload);
      currentSettings = { ...currentSettings, ...payload };
      if (payload.videoHardwareAcceleration !== undefined || payload.videoHardwareDevice !== undefined) {
        // Like the server: saving the encoder answers while its test encode is still
        // running, and a later read reports the result, which fails without a GPU.
        currentSettings.videoHardwareStatus =
          currentSettings.videoHardwareAcceleration === "none" ? { state: "disabled" } : { state: "checking" };
      }
      if (proxy) {
        // Like the server: passwords are write-only and an omitted one is kept.
        const previous = new Map(currentSettings.proxy.proxies.map((candidate) => [candidate.id, candidate]));
        currentSettings.proxy = {
          hostAddress: currentSettings.proxy.hostAddress,
          routes: proxy.routes,
          directFallback: proxy.directFallback,
          bypass: proxy.bypass,
          defaultBypass: currentSettings.proxy.defaultBypass,
          proxies: proxy.proxies.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            kind: candidate.kind,
            scheme: candidate.scheme,
            host: candidate.host,
            port: candidate.port,
            username: candidate.username,
            hasPassword:
              candidate.password === undefined
                ? Boolean(previous.get(candidate.id)?.hasPassword)
                : candidate.password !== "",
          })),
        };
      }
      await route.fulfill({ json: currentSettings });
      return;
    }
    if (url.pathname === "/api/settings") {
      await route.fulfill({ json: currentSettings });
      if (currentSettings.videoHardwareStatus?.state === "checking") {
        currentSettings.videoHardwareStatus = { state: "unavailable", reason: "device_missing" };
      }
      return;
    }
    if (url.pathname === "/api/recommendation-telemetry") {
      await route.fulfill({
        json: {
          windowDays: 30,
          totalEvents: 0,
          eventCounts: {},
          scoreBuckets: {},
          generatedAt: fixtureTimestamp,
        } satisfies RecommendationTelemetrySummary,
      });
      return;
    }
    if (url.pathname === "/api/file-sources/8/health-check" && route.request().method() === "POST") {
      onHealthCheck();
      const source: FileSource = {
        ...currentSettings.fileSources[1],
        healthStatus: "healthy",
        lastCheckedAt: "2026-07-26T01:00:00Z",
      };
      replaceRemoteSource(source);
      await route.fulfill({
        json: {
          healthy: true,
          healthStatus: source.healthStatus,
          lastCheckedAt: source.lastCheckedAt,
          elapsedMs: 24,
        } satisfies FileSourceHealthCheckResult,
      });
      return;
    }
    if (url.pathname === "/api/file-sources/8" && route.request().method() === "PATCH") {
      const payload = route.request().postDataJSON() as FileSourceWrite;
      onSourceUpdate(payload);
      const source: FileSource = {
        ...currentSettings.fileSources[1],
        ...payload,
        config: { ...currentSettings.fileSources[1].config, ...payload.config },
      };
      replaceRemoteSource(source);
      await route.fulfill({ json: source });
      return;
    }
    if (url.pathname === "/api/file-sources/detect" && route.request().method() === "POST") {
      const { url: address } = route.request().postDataJSON() as { url: string };
      const detected = address.includes("compatible");
      await route.fulfill({
        json: {
          detected,
          sourceType: "kikoeru_compatible",
          displayName: "compatible.example.invalid",
          baseUrl: "https://compatible.example.invalid",
          apiUrl: detected ? "https://api.compatible.example.invalid" : "",
          tried: ["https://compatible.example.invalid"],
        } satisfies FileSourceDetectResult,
      });
      return;
    }
    if (url.pathname === "/api/file-sources" && route.request().method() === "POST") {
      const payload = route.request().postDataJSON() as FileSourceWrite;
      onSourceUpdate(payload);
      await route.fulfill({
        status: 201,
        json: { ...currentSettings.fileSources[1], ...payload, id: 9 } satisfies FileSource,
      });
      return;
    }
    if (url.pathname === "/api/users") {
      await route.fulfill({ json: [managedUserFixture()] });
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
        } satisfies CacheOverview,
      });
      return;
    }
    if (url.pathname === "/api/cache/cleanup" && route.request().method() === "POST") {
      onCleanup(route.request().postDataJSON());
      await route.fulfill({
        status: 202,
        json: { runId: 52, jobId: 53, status: "queued", queued: 4 } satisfies CacheMaintenanceResult,
      });
      return;
    }
    if (url.pathname === "/api/cache/transcodes" && route.request().method() === "DELETE") {
      transcodeClearRequests.push(url.pathname);
      await route.fulfill({ json: { deletedFiles: 4, freedBytes: 25165824 } satisfies TranscodeCacheClearResult });
      return;
    }
    if (url.pathname === "/api/maintenance/database" && route.request().method() === "GET") {
      await route.fulfill({
        json: {
          scannedAt: "2026-07-14T00:00:00Z",
          databaseBytes: 5767168,
          freeBytes: 102400,
          walBytes: 0,
          dataRootAvailable: true,
          tasks: [
            { key: "missing_folders", count: 2, available: true },
            { key: "missing_files", count: 12, available: true },
            { key: "empty_media_items", count: 0, available: true },
            { key: "missing_presence", count: 0, available: true },
            { key: "orphan_snapshots", count: 0, available: true },
            { key: "unused_tags", count: 0, available: true },
            { key: "expired_sessions", count: 3, available: true },
            { key: "dismissed_notifications", count: 0, available: true },
            { key: "old_runs", count: 0, available: true },
            { key: "old_recommendation_events", count: 0, available: true },
            { key: "stale_recommendation_generations", count: 0, available: true },
          ],
        } satisfies DatabaseMaintenanceOverview,
      });
      return;
    }
    if (url.pathname === "/api/maintenance/database/cleanup" && route.request().method() === "POST") {
      databaseCleanupRequests.push(route.request().postDataJSON());
      await route.fulfill({ json: { removed: 17, results: [] } satisfies DatabaseCleanupResult });
      return;
    }
    if (url.pathname === "/api/library/layout") {
      await route.fulfill({
        json: {
          mode: "standard",
          configured: true,
          locked: true,
          onboardingCompleted: true,
          hasLegacyWorkflows: false,
          pools: [{ path: "", online: true, canReconnect: false }],
          candidates: [],
          fetchPool: "",
          localScanTriggers: { startupScan: true, watchFolders: false },
        } satisfies LibraryLayout,
      });
      return;
    }
    if (url.pathname === "/api/maintenance/works") {
      await route.fulfill({ json: { works: [], page: 1, pageSize: 25, total: 4 } satisfies MaintenanceWorkPage });
      return;
    }
    if (url.pathname === "/api/maintenance/local-works/cleanup" && route.request().method() === "GET") {
      await route.fulfill({ json: { works: [], page: 1, pageSize: 50, total: 0 } satisfies LocalWorkCleanupPage });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } satisfies ApiErrorBody });
  });
  return { transcodeClearRequests, databaseCleanupRequests };
}

test("@desktop a cache setting saves on its own when its edit finishes and links to Cleanup", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const settingsPayloads: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    (payload) => {
      settingsPayloads.push(payload);
    },
  );
  await page.goto("/system?tab=cache");

  await expect(page.getByText("Managed media cache", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Save path template", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Per-file download limit")).toHaveValue("100");
  await expect(page.getByLabel("Failed staging retention")).toHaveValue("7");
  await expect(page.getByLabel("Transcode cache limit")).toHaveValue("5");
  await expect(page.getByRole("button", { name: /^Save/ })).toHaveCount(0);
  await page.getByLabel("Transcode cache limit").fill("6");
  // Typing alone sends nothing; finishing the edit saves that field and no other.
  expect(settingsPayloads).toHaveLength(0);
  await page.getByLabel("Transcode cache limit").press("Tab");
  await expect.poll(() => settingsPayloads).toEqual([{ transcodeCacheLimitGb: 6 }]);
  await expect(page.getByRole("region", { name: "Cache policy" }).getByRole("status")).toHaveText("Saved");
  // Leaving an unchanged field saves nothing.
  await page.getByLabel("Per-file download limit").focus();
  await page.getByLabel("Per-file download limit").press("Tab");
  expect(settingsPayloads).toHaveLength(1);
  await page.getByTestId("cache-configuration-card").getByRole("button", { name: "Cleanup", exact: true }).click();
  await expect(page).toHaveURL(/\/cleanup\?tab=cache$/);
  await expect(
    page.getByRole("tablist", { name: "Cleanup", exact: true }).getByRole("tab", { name: "Cache", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Transcode cache" })).toBeVisible();
});

test("@desktop video conversion saves its slots and encoder and follows the encoder check", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const settingsPayloads: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    (payload) => {
      settingsPayloads.push(payload);
    },
  );
  await page.goto("/system?tab=cache");

  const section = page.getByRole("region", { name: "Video conversion" });
  await expect(section.getByRole("combobox", { name: "Hardware encoder", exact: true })).toHaveText("Off (CPU)");
  await expect(section.getByLabel("Render device")).toHaveCount(0);
  await expect(section.getByLabel("Simultaneous conversions")).toHaveValue("2");

  await section.getByLabel("Simultaneous conversions").fill("3");
  await section.getByLabel("Simultaneous conversions").press("Enter");
  await expect.poll(() => settingsPayloads).toEqual([{ transcodeSlots: 3 }]);
  await section.getByRole("combobox", { name: "Hardware encoder", exact: true }).click();
  await page.getByRole("option", { name: "Intel VA-API", exact: true }).click();
  await expect.poll(() => settingsPayloads.at(-1)).toEqual({ videoHardwareAcceleration: "vaapi" });
  await expect(section.getByLabel("Render device")).toHaveValue("/dev/dri/renderD128");
  await section.getByLabel("Render device").fill("/dev/dri/renderD129");
  await section.getByLabel("Render device").press("Enter");
  await expect.poll(() => settingsPayloads.at(-1)).toEqual({ videoHardwareDevice: "/dev/dri/renderD129" });
  // The save answers while the test encode runs; the page reads its result afterwards.
  await expect(section.getByText("Checking", { exact: true })).toBeVisible();
  await expect(section.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(
    section.getByText("The render device is not in the container. Pass /dev/dri to the container."),
  ).toBeVisible();
});

test("@desktop cleanup page scans managed media and requires cleanup confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const cleanupRequests: unknown[] = [];
  const mocks = await mockCacheSettings(page, (payload) => {
    cleanupRequests.push(payload);
  });
  await page.goto("/cleanup?tab=cache");

  const transcodeCache = page.getByRole("region", { name: "Transcode cache" });
  await expect(transcodeCache.getByText("24 MB", { exact: true })).toBeVisible();
  await expect(transcodeCache.getByText("of 5.0 GB", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear transcode cache", exact: true }).click();
  expect(mocks.transcodeClearRequests).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm clear (4 files)", exact: true }).click();
  await expect.poll(() => mocks.transcodeClearRequests).toEqual(["/api/cache/transcodes"]);
  await expect(page.getByText("Removed 4 files and freed 24 MB.", { exact: true })).toBeVisible();
  const managedCache = page.getByRole("region", { name: "Managed media cache" });
  await expect(managedCache.getByText("150 MB", { exact: true })).toBeVisible();
  await expect(managedCache.getByText("30 MB", { exact: true })).toBeVisible();
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

test("cleanup page removes only the selected database records after confirmation", async ({ page }) => {
  const mocks = await mockCacheSettings(page, () => undefined);
  await page.goto("/cleanup?tab=database");

  const database = page.getByRole("region", { name: "Database records" });
  const libraryGroup = database.getByRole("button", { name: "Library records", exact: true });
  await expect(libraryGroup).toHaveAttribute("aria-expanded", "false");
  await expect(database.getByRole("checkbox", { name: "Missing work folders", exact: true })).toBeHidden();
  await libraryGroup.click();
  await database.getByRole("button", { name: "History and sessions", exact: true }).click();
  await expect(database.getByRole("checkbox", { name: "Unused tags", exact: true })).toBeDisabled();
  await database.getByRole("checkbox", { name: "Missing work folders", exact: true }).click();
  await database.getByRole("checkbox", { name: "Expired sign-in sessions", exact: true }).click();
  await expect(database.getByText("2 selected · 5 records", { exact: true })).toBeVisible();
  await database.getByRole("button", { name: "Clean selected", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Clean database records?" });
  expect(mocks.databaseCleanupRequests).toHaveLength(0);
  await dialog.getByRole("button", { name: "Remove 5 records", exact: true }).click();
  await expect.poll(() => mocks.databaseCleanupRequests).toEqual([{ tasks: ["missing_folders", "expired_sessions"] }]);
  await expect(page.getByText("Removed 17 records.", { exact: true })).toBeVisible();
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
  await page.goto("/system?tab=cache");

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
  await expect.poll(() => settingsPayloads).toEqual([{ cacheEnabled: true }]);
});

test("cleanup page can clear referenced cache for selected works", async ({ page }) => {
  const cleanupRequests: unknown[] = [];
  await mockCacheSettings(page, (payload) => {
    cleanupRequests.push(payload);
  });
  await page.goto("/cleanup?tab=cache");
  await page.getByRole("button", { name: "Work cache", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select all cache in Example Remote" }).click();
  await page.getByRole("button", { name: "Clean selected works" }).click();
  await page.getByRole("button", { name: "Confirm cleanup (6 files)" }).click();
  await expect.poll(() => cleanupRequests).toHaveLength(1);
  expect(cleanupRequests[0]).toEqual({ mode: "works", workIds: [1] });
});

test("personal settings are one page of the account's own sections and no administration", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Manage your account and appearance preferences", { exact: true })).toBeHidden();
  await expect(page.getByRole("tablist", { name: "Settings", exact: true })).toHaveCount(0);
  for (const name of ["Account", "Time zone", "Playback", "Your data"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "Recommendation tuning", exact: true })).toHaveCount(0);
});

test.describe("on a device in another time zone", () => {
  test.use({ timezoneId: "Asia/Tokyo" });

  test("an account follows its device's time zone until it fixes one", async ({ page }) => {
    const updates: unknown[] = [];
    await mockCacheSettings(
      page,
      () => undefined,
      (payload) => updates.push(payload),
    );
    await page.goto("/settings");
    const zone = page.getByRole("combobox", { name: "Time zone", exact: true });
    await expect(zone.locator("option").first()).toHaveText("Automatic (Asia/Tokyo)");
    await expect(zone).toHaveValue("");
    await zone.selectOption("Europe/Berlin");
    await expect(page.getByRole("region", { name: "Time zone" }).getByRole("status")).toHaveText("Saved");
    expect(updates.at(-1)).toEqual({ timeZone: "Europe/Berlin" });

    // The fixed zone is the saved choice on the next visit, and automatic clears it.
    await page.reload();
    await expect(zone).toHaveValue("Europe/Berlin");
    await zone.selectOption("");
    await expect.poll(() => updates.at(-1)).toEqual({ timeZone: null });
  });
});

test("Settings links land on their section and System keeps its open tab in the address", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/settings?tab=playback");
  await expect(page.getByRole("region", { name: "Playback", exact: true })).toBeInViewport();
  await expect(page.getByRole("heading", { name: "Account", exact: true })).not.toBeInViewport();

  // Recommendation tuning is For you's settings.
  await page.goto("/settings?tab=recommendation");
  await expect(page).toHaveURL(/\/for-you\?panel=tuning$/);
  await expect(page.getByRole("tab", { name: "Tuning", selected: true })).toBeVisible();

  // A link to an administration tab of Settings opens it on the System page.
  await page.goto("/settings?tab=cache");
  await expect(page).toHaveURL(/\/system\?tab=cache$/);
  await expect(page.getByRole("heading", { name: "System", exact: true, level: 1 })).toBeVisible();
  const systemTabs = page.getByRole("tablist", { name: "System", exact: true });
  await expect(systemTabs.getByRole("tab")).toHaveText(["Library", "Cache & Fetch", "Proxy", "ASR & LLM", "Users"]);
  await expect(systemTabs.getByRole("tab", { name: "Cache & Fetch", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await systemTabs.getByRole("tab", { name: "Users", exact: true }).click();
  await expect(page).toHaveURL(/\/system\?tab=users$/);
  await systemTabs.getByRole("tab", { name: "Library", exact: true }).click();
  await expect(page).toHaveURL(/\/system$/);
});

test("Cleanup is its own page with Works, Cache, and Database tabs", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  // A link to the former System tab opens the page.
  await page.goto("/system?tab=cleanup");
  await expect(page).toHaveURL(/\/cleanup$/);
  await expect(page.getByRole("heading", { name: "Cleanup", exact: true, level: 1 })).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "Cleanup", exact: true });
  await expect(tabs.getByRole("tab")).toHaveText(["Works", "Cache", "Database"]);
  await expect(tabs.getByRole("tab", { name: "Works", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Local works by rating" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Transcode cache" })).toHaveCount(0);

  await tabs.getByRole("tab", { name: "Cache", exact: true }).click();
  await expect(page).toHaveURL(/\/cleanup\?tab=cache$/);
  await expect(page.getByRole("region", { name: "Transcode cache" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Managed media cache" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Database records" })).toHaveCount(0);

  await tabs.getByRole("tab", { name: "Database", exact: true }).click();
  await expect(page).toHaveURL(/\/cleanup\?tab=database$/);
  await expect(page.getByRole("region", { name: "Database records" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Local works by rating" })).toHaveCount(0);
});

test("Cleanup offers only the tabs the account may use", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authenticatedStateFixture({
        username: "synthetic-user",
        displayName: "Example User",
        permissions: ["sources:write"],
      }),
    }),
  );
  await page.goto("/cleanup?tab=cache");
  const tabs = page.getByRole("tablist", { name: "Cleanup", exact: true });
  await expect(tabs.getByRole("tab")).toHaveText(["Database"]);
  await expect(tabs.getByRole("tab", { name: "Database", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Database records" })).toBeVisible();
});

test("@desktop System and Cleanup tabs sit above the content with an icon and a name", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  // Browser storage left by the former row and column options changes nothing.
  await page.addInitScript(() => {
    localStorage.setItem("kikoto:settings-rail-orientation", "vertical");
    localStorage.setItem("kikoto:settings-rail-labels-shown", "false");
  });
  for (const [path, label, names] of [
    ["/system", "System", ["Library", "Cache & Fetch", "Proxy", "ASR & LLM", "Users"]],
    ["/cleanup", "Cleanup", ["Works", "Cache", "Database"]],
  ] as const) {
    await page.goto(path);
    const tabs = page.getByRole("tablist", { name: label, exact: true });
    await expect(tabs).toHaveAttribute("aria-orientation", "horizontal");
    for (const name of names) {
      const tab = tabs.getByRole("tab", { name, exact: true });
      await expect(tab.getByText(name)).toBeVisible();
      await expect(tab.locator("svg")).toBeVisible();
    }
    await expect(page.getByRole("button", { name: /Show tabs|tab names/ })).toHaveCount(0);

    // The row sits above the panel, and every tab's text shows without a toggle.
    const layout = await tabs.getByRole("tab").evaluateAll((buttons) => {
      const panel = document.querySelector('[role="tabpanel"]')!.getBoundingClientRect();
      const boxes = buttons.map((button) => button.getBoundingClientRect());
      return {
        abovePanel: boxes.every((box) => box.bottom <= panel.top),
        oneRow: Math.max(...boxes.map((box) => box.top)) - Math.min(...boxes.map((box) => box.top)) <= 1,
        pageFits: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(layout).toEqual({ abovePanel: true, oneRow: true, pageFits: true });
  }
});

test("personal playback seek intervals use the requested defaults and persist locally", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  await page.goto("/settings");

  const forward = page.getByRole("spinbutton", { name: /Forward seek/ });
  const backward = page.getByRole("spinbutton", { name: /Backward seek/ });
  await expect(forward).toHaveValue("30");
  await expect(backward).toHaveValue("10");

  await forward.fill("45");
  await backward.fill("15");
  await backward.press("Enter");
  await expect(page.getByRole("region", { name: "Playback" }).getByRole("status")).toHaveText("Saved");

  // An out-of-range interval keeps its error and is not stored.
  await forward.fill("0");
  await forward.press("Tab");
  await expect(page.getByRole("alert")).toContainText("1");

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
      json: authenticatedStateFixture({
        username: "root",
        displayName: "Root",
        role: "super_admin",
        permissions: ["system:admin"],
        devMode: true,
        passwordManagedBy: "environment",
      }),
    }),
  );
  await page.route("**/api/runtime-settings", (route) => {
    runtimeRequests += 1;
    return route.fulfill({ json: runtimeSettingsFixture({ anonymousAccessEnabled, cacheEnabled: true }) });
  });
  await page.route("**/api/access-policy", async (route) => {
    const payload = route.request().postDataJSON() as AccessPolicy;
    updates.push(payload);
    anonymousAccessEnabled = payload.anonymousAccessEnabled;
    await route.fulfill({ json: payload satisfies AccessPolicy });
  });

  await page.goto("/system?tab=users");
  await expect(page).toHaveURL(/\/system\?tab=users$/);
  await expect(page.getByRole("tab", { name: "Users", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("searchbox", { name: "Search users" })).toBeVisible();
  const accessSwitch = page.getByRole("switch", { name: "Anonymous access", exact: true });
  const accessSection = page.getByRole("region", { name: "Instance access" });
  await expect(
    accessSection.getByText("Library browsing and playback without an account", { exact: true }),
  ).toBeVisible();
  await expect(accessSwitch).toHaveAttribute("aria-checked", "false");
  // Opening the library to visitors is confirmed first; cancelling changes nothing.
  await accessSwitch.click();
  const confirm = page.getByRole("alertdialog", { name: "Allow anonymous access?" });
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(accessSwitch).toHaveAttribute("aria-checked", "false");
  expect(updates).toEqual([]);

  await accessSwitch.click();
  await confirm.getByRole("button", { name: "Allow", exact: true }).click();
  await expect.poll(() => updates).toEqual([{ anonymousAccessEnabled: true }]);
  await expect.poll(() => runtimeRequests).toBeGreaterThanOrEqual(2);
  await expect(accessSwitch).toHaveAttribute("aria-checked", "true");
  await expect(accessSection.getByRole("status")).toHaveText("Saved");

  // Turning it off needs no confirmation.
  await accessSwitch.click();
  await expect.poll(() => updates.at(-1)).toEqual({ anonymousAccessEnabled: false });
});

test("work maintenance mounts once and keeps its result region stable while settings load", async ({ page }) => {
  let releaseSettings: () => void = () => undefined;
  let releaseWorks: () => void = () => undefined;
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
    await route.fulfill({ json: { works: [], page: 1, pageSize: 25, total: 0 } satisfies MaintenanceWorkPage });
  });

  await page.goto("/metadata?reason=no_source");
  await expect(page.getByRole("combobox", { name: "Filter DLsite works", exact: true })).toHaveText(/^Needs attention/);
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
  let releaseSettings: () => void = () => undefined;
  let releaseUsers: () => void = () => undefined;
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

  await page.goto("/system?tab=users");
  await expect(page.getByRole("searchbox", { name: "Search users" })).toBeVisible();
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
  // A row with room names every tab; a phone folds the others to icons and names the open one.
  test(`${layout} System tabs stay in one row along the top`, async ({ page }) => {
    await mockCacheSettings(page, () => undefined);
    await page.goto("/system?tab=users");
    const navigation = page.getByRole("tablist", { name: "System", exact: true });
    const users = navigation.getByRole("tab", { name: "Users", exact: true });
    await expect(users).toHaveAttribute("aria-selected", "true");
    await expect(navigation).toHaveAttribute("aria-orientation", "horizontal");
    // The row has no display toggles at any width.
    await expect(page.getByRole("button", { name: /Show tabs|tab names/ })).toHaveCount(0);
    // A deep link to a later tab keeps the selected tab in view, with its name shown.
    await expect(users).toBeInViewport({ ratio: 1 });
    await expect(users.getByText("Users", { exact: true })).toBeInViewport();
    await expect(navigation.getByRole("tab")).toHaveCount(5);
    const namedTabs = await navigation
      .getByRole("tab")
      .evaluateAll(
        (buttons) => buttons.filter((button) => button.querySelector("span")!.getBoundingClientRect().width > 1).length,
      );
    expect(namedTabs).toBe(layout === "mobile" ? 1 : 5);
    const boxes = await navigation.getByRole("tab").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { top: box.top, left: box.left, width: box.width, height: box.height };
      }),
    );
    const tops = boxes.map((box) => box.top);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
    const flow = boxes.map((box) => box.left);
    expect(flow).toEqual([...flow].sort((a, b) => a - b));
    expect(boxes.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);
    // The row scrolls only sideways; a vertical wheel over it must not nudge the tabs.
    const row = await navigation.boundingBox();
    await page.mouse.move(row!.x + 20, row!.y + row!.height / 2);
    await page.mouse.wheel(0, 40);
    // Give a wheel scroll time to land before asserting that nothing moved.
    await page.waitForTimeout(300);
    expect(await navigation.evaluate((list) => list.scrollTop)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await navigation.getByRole("tab", { name: "Library", exact: true }).click();
    await expect(page.getByText("Storage paths", { exact: true })).toBeVisible();
    await navigation.getByRole("tab", { name: "Users", exact: true }).click();
    await expect(page.getByRole("searchbox", { name: "Search users" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole("switch", { name: "Anonymous access", exact: true })).toHaveCount(0);
  });
}

test("non-admin users cannot open the System page", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  let settingsRequests = 0;
  await page.route("**/api/settings", async (route) => {
    settingsRequests += 1;
    await route.fulfill({ status: 403, json: forbidden });
  });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authenticatedStateFixture({
        username: "synthetic-user",
        displayName: "Example User",
        permissions: ["users:manage"],
      }),
    }),
  );
  await page.goto("/settings?tab=users");
  await expect(page).toHaveURL(/\/system\?tab=users$/);
  await expect(page.getByText("Your account does not have permission to access this page.")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Users", exact: true })).toHaveCount(0);
  expect(settingsRequests).toBe(0);
  // Settings offers the account's own sections only.
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Playback", exact: true })).toBeVisible();
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
  await page.goto("/system?tab=library");

  // The library overview lists the local library and every remote source above the settings.
  const libraries = page.getByRole("region", { name: "Libraries", exact: true });
  await expect(libraries.getByRole("heading", { name: "Local", exact: true })).toBeVisible();
  await expect(libraries.getByText("Standard · Online", { exact: true })).toBeVisible();
  await expect(libraries.getByRole("heading", { name: "Remote", exact: true })).toBeVisible();
  await expect(libraries.getByText("Example Remote", { exact: true })).toBeVisible();
  await expect(page.getByText("Local library", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sources", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Cache & Fetch", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check health", exact: true }).click();
  await expect.poll(() => healthChecks).toBe(1);
  await expect(page.getByText("Healthy", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Cache Example Remote", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Configure", exact: true }).click();
  const sourceDialog = page.getByRole("dialog", { name: "Edit remote source" });
  await expect(sourceDialog.getByLabel("Save path preview")).toHaveValue("/data/example-remote/RJ00000000");
  await expect(sourceDialog.getByText("Cache GB", { exact: true })).toHaveCount(0);
  await expect(sourceDialog.getByRole("switch", { name: "Cache this source", exact: true })).toHaveCount(0);
  await expect(sourceDialog.getByText("Save path template", { exact: true })).toHaveCount(0);
  await expect(sourceDialog.getByRole("switch", { name: "Restrict outbound hosts" })).toBeHidden();
  await sourceDialog.getByText("Network and storage", { exact: true }).click();
  await expect(sourceDialog.getByRole("switch", { name: "Restrict outbound hosts" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(sourceDialog.getByLabel("Additional allowed hosts")).toHaveCount(0);
  await sourceDialog.getByRole("switch", { name: "Restrict outbound hosts" }).click();
  await expect(sourceDialog.getByText("https://api.remote.example", { exact: true }).last()).toBeVisible();
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
  await page.getByText("Storage paths", { exact: true }).click();
  await expect(page.getByLabel("Remote save path preview")).toHaveValue("/data/source/RJ_000/RJ00000000");
  await expect(page.getByLabel("Example Remote", { exact: true })).toHaveValue("/data/example-remote/RJ00000000");
  await expect(page.getByRole("button", { name: /Save.*path/i })).toHaveCount(0);
});

test("remote sources toggle in place and new sources start from address detection", async ({ page }) => {
  const sourceWrites: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    () => undefined,
    () => undefined,
    (payload) => sourceWrites.push(payload),
  );
  await page.goto("/system?tab=library");

  const toggle = page.getByRole("switch", { name: "Enable Example Remote", exact: true });
  const wasEnabled = (await toggle.getAttribute("aria-checked")) === "true";
  await toggle.click();
  await expect.poll(() => sourceWrites.length).toBe(1);
  expect(sourceWrites[0]).toEqual(expect.objectContaining({ displayName: "Example Remote", enabled: !wasEnabled }));

  await page.getByRole("button", { name: "Add source", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add remote source" });
  await expect(dialog.getByLabel("Name")).toHaveCount(0);
  await dialog.getByLabel("Address").fill("unknown.example.invalid");
  await dialog.getByRole("button", { name: "Detect", exact: true }).click();
  await expect(dialog.getByText("No API was detected automatically", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("API URL")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add source", exact: true })).toBeDisabled();

  await dialog.getByLabel("Address").fill("compatible.example.invalid");
  await dialog.getByRole("button", { name: "Detect", exact: true }).click();
  await expect(dialog.getByText("Compatible API found", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveValue("compatible.example.invalid");
  const fallbackLanguage = dialog.getByRole("combobox", { name: "Fallback language", exact: true });
  await expect(fallbackLanguage).toHaveValue("ja-JP");
  await fallbackLanguage.selectOption({ label: "English" });
  await dialog.getByRole("button", { name: "Add source", exact: true }).click();
  await expect.poll(() => sourceWrites.length).toBe(2);
  expect(sourceWrites[1]).toEqual(
    expect.objectContaining({
      displayName: "compatible.example.invalid",
      config: expect.objectContaining({ requestLanguage: "en-US" }),
      endpoint: expect.objectContaining({
        apiUrl: "https://api.compatible.example.invalid",
        baseUrl: "https://compatible.example.invalid",
      }),
    }),
  );
});

test("remote source deep links open the requested source configuration", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  await page.goto("/system?tab=library&source=8");

  const sourceDialog = page.getByRole("dialog", { name: "Edit remote source" });
  await expect(sourceDialog).toBeVisible();
  await expect(sourceDialog.getByLabel("Name")).toHaveValue("Example Remote");
  await sourceDialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/system\?tab=library$/);
});

test("libraries lists one card per storage pool and opens storage settings in a dialog", async ({ page }) => {
  let layout: LibraryLayout = {
    mode: "pools",
    configured: true,
    locked: true,
    onboardingCompleted: true,
    hasLegacyWorkflows: false,
    pools: [
      { path: "pool-a", online: true, canReconnect: false },
      { path: "pool-b", online: false, canReconnect: true },
    ],
    candidates: ["pool-a", "pool-b", "pool-c"],
    fetchPool: "pool-a",
    localScanTriggers: { startupScan: true, watchFolders: false },
  };
  await mockCacheSettings(page, () => undefined);
  await page.route("**/api/library/layout", async (route) => {
    if (route.request().method() === "PUT") {
      const payload = route.request().postDataJSON() as {
        mode: "standard" | "pools";
        pools?: string[];
        fetchPool?: string;
      };
      layout = {
        ...layout,
        mode: payload.mode,
        fetchPool: payload.fetchPool ?? "",
        pools: (payload.pools ?? []).map((path) => ({ path, online: true, canReconnect: false })),
      };
      await route.fulfill({ json: layout });
      return;
    }
    await route.fulfill({ json: layout });
  });
  await page.route("**/api/library/pools/reconnect", async (route) => {
    layout = {
      ...layout,
      pools: layout.pools.map((pool) => ({ ...pool, online: true, canReconnect: false })),
    };
    await route.fulfill({ json: layout });
  });

  await page.goto("/system?tab=library");
  const libraries = page.getByRole("region", { name: "Libraries", exact: true });
  await expect(page.getByRole("region", { name: "Library storage", exact: true })).toHaveCount(0);
  await expect(libraries.getByText("/data/pool-a", { exact: true })).toBeVisible();
  await expect(libraries.getByText("/data/pool-b", { exact: true })).toBeVisible();
  await expect(libraries.getByText("Fetch pool", { exact: true })).toBeVisible();

  await libraries.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(libraries.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(0);

  await libraries.getByRole("button", { name: "Library storage", exact: true }).click();
  const storageDialog = page.getByRole("dialog", { name: "Library storage" });
  await expect(storageDialog).toBeVisible();
  await storageDialog.getByRole("checkbox", { name: "Use pool-c as a storage pool" }).click();
  await storageDialog.getByRole("button", { name: "Save library storage", exact: true }).click();

  await expect(storageDialog).toHaveCount(0);
  await expect(libraries.getByText("/data/pool-c", { exact: true })).toBeVisible();
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
  let forYouDraws = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/for-you/draw") forYouDraws++;
  });
  await page.goto("/maintenance?tab=recommendation");
  await expect(page).toHaveURL(/\/for-you\?panel=tuning$/);
  await expect.poll(() => forYouDraws).toBe(1);

  // The For you temperature button behind the dialog also names Balanced.
  await expect(page.getByRole("dialog").getByRole("button", { name: /Balanced/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Highlight threshold")).toBeVisible();
  // The activity report follows the tuning in the same panel.
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Your recommendation activity" })).toBeAttached();
  await expect(page.getByLabel("Result variation")).toBeVisible();
  await expect(page.getByLabel("Positive tag weight")).toBeHidden();
  await page.getByRole("button", { name: /Exploratory/ }).click();
  await expect(page.getByLabel("Result variation")).toHaveValue("8");
  await expect(page.getByLabel("Discovery boost")).toHaveValue("30");
  await page.getByText("Advanced scoring", { exact: true }).click();
  await expect(page.getByLabel("Unmarked", { exact: true })).toHaveValue("16");
  await expect(page.getByRole("spinbutton", { name: "Shelved", exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Positive tag weight")).toBeVisible();
  await page.getByRole("button", { name: "Save recommendation settings" }).click();
  await expect.poll(() => settingsPayloads.length).toBe(1);
  expect((settingsPayloads[0].recommendationConfig as { jitterAmplitude: number }).jitterAmplitude).toBe(8);
  expect((settingsPayloads[0].recommendationConfig as { explorationAmplitude: number }).explorationAmplitude).toBe(30);
  expect(Object.keys(settingsPayloads[0]).sort()).toEqual(["recommendationConfig", "recommendationThreshold"]);
  // Saved tuning draws For you again behind its settings.
  await expect.poll(() => forYouDraws).toBe(2);
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
  await page.goto("/for-you?panel=tuning");
  await expect(page.getByRole("tab", { name: "Tuning", selected: true })).toBeVisible();
  await page.getByRole("button", { name: /Exploratory/ }).click();
  await page.getByLabel("Highlight threshold").focus();
  await page.getByLabel("Highlight threshold").press("End");
  await expect(page.getByLabel("Highlight threshold")).toHaveValue("100");
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
  await expect(page.getByLabel("Highlight threshold")).toHaveValue("50");
});

test("@desktop Metadata settings links open the DLsite proxy in System", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authenticatedStateFixture({
        username: "admin",
        displayName: "Admin",
        role: "admin",
        permissions: ["library:read", "sources:write", "metadata:sync", "workflows:run"],
      }),
    }),
  );
  for (const path of ["/metadata?tab=settings", "/maintenance?tab=metadata"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/system\?tab=proxy$/);
    await expect(page.getByRole("heading", { name: "Proxy", exact: true })).toBeInViewport();
  }
});

test("@desktop administrators set catalog freshness in Library settings", async ({ page }) => {
  const saves: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    (payload) => saves.push(payload),
  );
  await page.goto("/system?tab=library");
  await expect(page.getByRole("tab", { name: "Library", exact: true })).toHaveAttribute("aria-selected", "true");
  // There is no instance metadata language, so Settings has no Metadata tab.
  await expect(page.getByRole("tab", { name: "Metadata", exact: true })).toHaveCount(0);

  const freshness = page.getByRole("spinbutton", { name: "Catalog freshness days", exact: true });
  await freshness.fill("14");
  await freshness.press("Tab");
  await expect.poll(() => saves).toEqual([{ catalogFreshnessDays: 14 }]);
  await expect(page.getByRole("region", { name: "Creator catalogs" }).getByRole("status")).toHaveText("Saved");

  // The metadata tab id opens Library.
  await page.goto("/settings?tab=metadata");
  await expect(page.getByRole("tab", { name: "Library", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("@desktop administrators turn Record on in Library settings and initialize its root there", async ({ page }) => {
  const saves: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    (payload) => saves.push(payload),
  );
  const sidebarRecord = page.locator("aside nav").getByRole("button", { name: "Record", exact: true });

  // While Record is off, the sidebar does not offer it and its address is not found.
  await page.goto("/records");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.goto("/system?tab=library");
  await expect(page.getByRole("tab", { name: "Library", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(sidebarRecord).toHaveCount(0);

  const section = page.getByRole("region", { name: "Record", exact: true });
  await section.getByRole("switch", { name: "Record library", exact: true }).click();
  await expect.poll(() => saves).toEqual([{ recordLibraryEnabled: true }]);
  await expect(section.getByRole("status")).toHaveText("Saved");
  await expect(sidebarRecord).toBeVisible();

  await expect(section.getByText("Not initialized", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Initialize root", exact: true }).click();
  await expect(section.getByText("Online", { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: "Initialize root", exact: true })).toHaveCount(0);
});

test("administrators add proxies by priority and choose where they apply", async ({ page }) => {
  const saves: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    (payload) => saves.push(payload),
  );
  await page.goto("/system?tab=proxy");
  const proxySaves = () =>
    saves.filter((payload) => "proxy" in payload).map((payload) => payload.proxy as ProxyPayload);

  await page.getByRole("button", { name: "Add proxy", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add proxy", exact: true });
  // A local-machine proxy shows where the container reaches its host and cannot change it.
  await expect(dialog.getByRole("radio", { name: "Local machine", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const address = dialog.getByRole("textbox", { name: "Address", exact: true });
  await expect(address).toHaveValue("host.docker.internal");
  await expect(address).not.toBeEditable();
  await dialog.getByRole("combobox", { name: "Protocol", exact: true }).selectOption("socks5");
  await expect(dialog.getByRole("spinbutton", { name: "Port", exact: true })).toHaveValue("1080");
  await dialog.getByRole("textbox", { name: "Username", exact: true }).fill("synthetic-user");
  await dialog.getByLabel("Password", { exact: true }).fill("synthetic-password");
  await dialog.getByRole("button", { name: "Save proxy", exact: true }).click();
  await expect.poll(() => proxySaves().length).toBe(1);
  expect(proxySaves()[0].proxies[1]).toEqual(
    expect.objectContaining({
      kind: "host",
      scheme: "socks5",
      host: "",
      port: 1080,
      username: "synthetic-user",
      password: "synthetic-password",
    }),
  );
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("SOCKS5 · host.docker.internal:1080 · Authenticated", { exact: true })).toBeVisible();

  // Other proxies take an address.
  await page.getByRole("button", { name: "Add proxy", exact: true }).click();
  await dialog.getByRole("radio", { name: "Other address", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Address", exact: true })).toBeEditable();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.getByRole("button", { name: "Move Local machine up", exact: true }).click();
  await expect.poll(() => proxySaves().length).toBe(2);
  expect(proxySaves()[1].proxies.map((candidate) => candidate.kind)).toEqual(["host", "custom"]);
  // A saved password is never sent back unless it is replaced.
  expect(proxySaves()[1].proxies[0]).not.toHaveProperty("password");

  await page.getByRole("switch", { name: "Use proxy for All", exact: true }).click();
  await expect.poll(() => proxySaves().length).toBe(3);
  expect(proxySaves()[2].routes).toEqual(
    expect.objectContaining({
      dlsite: { enabled: true, proxyIds: [] },
      remote: { enabled: true, proxyIds: [] },
      ai: { enabled: true, proxyIds: [] },
      other: { enabled: true, proxyIds: [] },
    }),
  );

  await page.getByRole("combobox", { name: "Proxy for Example Remote", exact: true }).selectOption("direct");
  await expect.poll(() => proxySaves().length).toBe(4);
  expect(proxySaves()[3].routes.sources).toEqual({ "8": { mode: "direct", proxyIds: [] } });
  await page.getByRole("combobox", { name: "Proxy for DLsite", exact: true }).selectOption("proxy:lan");
  await expect.poll(() => proxySaves().length).toBe(5);
  expect(proxySaves()[4].routes.dlsite).toEqual({ enabled: true, proxyIds: ["lan"] });

  const fallback = page.getByRole("switch", { name: "Direct connection fallback", exact: true });
  await expect(fallback).toHaveAttribute("aria-checked", "false");
  await fallback.click();
  await expect.poll(() => proxySaves().length).toBe(6);
  expect(proxySaves()[5].directFallback).toBe(true);
  await expect(fallback).toHaveAttribute("aria-checked", "true");

  // The bypass list saves only when asked, and Restore defaults brings back the default list.
  const saveBypass = page.getByRole("button", { name: "Save bypass list", exact: true });
  await expect(saveBypass).toBeDisabled();
  const bypassField = page.getByRole("textbox", { name: "Bypass proxy", exact: true });
  await bypassField.fill("nas.lan");
  await bypassField.press("Enter");
  await page.getByRole("button", { name: "Remove localhost", exact: true }).click();
  await saveBypass.click();
  await expect.poll(() => proxySaves().length).toBe(7);
  expect(proxySaves()[6].bypass).toEqual(["192.168.0.0/16", "nas.lan"]);
  await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
  await saveBypass.click();
  await expect.poll(() => proxySaves().length).toBe(8);
  expect(proxySaves()[7].bypass).toEqual(["localhost", "192.168.0.0/16"]);
  await expect(saveBypass).toBeDisabled();
});

test("@desktop appearance saves a personal metadata language for any signed-in user", async ({ page }, testInfo) => {
  const saves: Record<string, unknown>[] = [];
  await mockCacheSettings(
    page,
    () => undefined,
    (payload) => saves.push(payload),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authenticatedStateFixture({
        username: "synthetic-user",
        displayName: "Example User",
        permissions: ["library:read"],
      }),
    }),
  );
  let instanceRequests = 0;
  await page.route("**/api/settings", (route) => {
    instanceRequests++;
    return route.fulfill({ status: 403, json: forbidden });
  });
  await page.goto("/settings?tab=playback");
  await page.getByRole("button", { name: "User menu" }).click();
  await page
    .getByRole("dialog", { name: "Account" })
    .getByRole("button", { name: /^Language/ })
    .click();
  const groups = page.getByRole("dialog", { name: "Account" }).getByRole("group");
  await expect(groups.nth(0)).toHaveAccessibleName("UI language");
  await expect(groups.nth(1)).toHaveAccessibleName("Preferred metadata language");
  const metadataLanguage = page.getByRole("combobox", { name: "Preferred metadata language" });
  // Until the user chooses, each work shows its original language.
  await expect(metadataLanguage).toHaveText("Origin");
  await page.screenshot({ path: testInfo.outputPath("appearance-metadata-language.png") });
  await metadataLanguage.click();
  await page.getByRole("listbox").getByRole("option", { name: "Japanese", exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toEqual({ metadataLanguages: ["ja-jp", "origin"] });
  await expect(metadataLanguage).toHaveText("Japanese");
  // Choosing the original language again clears the preference.
  await metadataLanguage.click();
  await page.getByRole("listbox").getByRole("option", { name: "Origin", exact: true }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]).toEqual({ metadataLanguages: null });
  await expect(metadataLanguage).toHaveText("Origin");
  // A personal language never reads or writes instance settings.
  expect(instanceRequests).toBe(0);
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
      json: authenticatedStateFixture({
        username: "synthetic-user",
        displayName: "Example User",
        permissions: ["library:read"],
      }),
    }),
  );
  let instanceRequests = 0;
  await page.route("**/api/settings", (route) => {
    instanceRequests++;
    return route.fulfill({ status: 403, json: forbidden });
  });
  await page.goto("/settings?tab=playback");
  await expect(page.getByRole("heading", { name: /^Folder preference/ })).toBeVisible();
  await page.getByRole("button", { name: "Save playback settings", exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(Object.keys(saves[0])).toEqual(["directoryRoutingRules"]);
  expect(instanceRequests).toBe(0);
});

test("modal dialogs keep Tab focus inside the top-most dialog", async ({ page }) => {
  await mockCacheSettings(page, () => undefined, undefined, undefined, undefined, false);
  await page.goto("/system?tab=cache");
  await page.getByRole("switch", { name: "Cache remote playback", exact: true }).click();
  const cacheDialog = page.getByRole("alertdialog", { name: "Enable remote playback cache?" });
  const cancel = cacheDialog.getByRole("button", { name: "Cancel", exact: true });
  const enable = cacheDialog.getByRole("button", { name: "Enable cache", exact: true });
  await expect(cacheDialog).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(enable).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(enable).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(cacheDialog).toHaveCount(0);

  await page.route("**/api/users", (route) =>
    route.fulfill({
      json: [
        managedUserFixture(),
        managedUserFixture({ id: 2, username: "synthetic-member", displayName: "Example Member", role: "user" }),
      ],
    }),
  );
  await page.goto("/system?tab=users");
  await page.getByRole("button", { name: "Details for Example Member", exact: true }).click();
  const details = page.getByRole("dialog");
  await details.getByRole("button", { name: "Delete user", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Delete Example Member?" });
  await expect(confirmation).toBeFocused();
  const confirmCancel = confirmation.getByRole("button", { name: "Cancel", exact: true });
  const confirmDelete = confirmation.getByRole("button", { name: "Delete", exact: true });
  for (const [key, expected] of [
    ["Tab", confirmCancel],
    ["Tab", confirmDelete],
    ["Tab", confirmCancel],
    ["Shift+Tab", confirmDelete],
  ] as const) {
    await page.keyboard.press(key);
    await expect(expected).toBeFocused();
  }
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(details).toBeVisible();
});

test("password forms tell password managers whose credential each field holds", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);

  // Changing the viewer's own password names their account so the saved sign-in is updated.
  await page.goto("/settings");
  await page.getByRole("button", { name: "Edit account", exact: true }).click();
  const accountDialog = page.getByRole("dialog", { name: "Edit account", exact: true });
  const passwordForm = accountDialog
    .locator("form")
    .filter({ has: page.getByLabel("Current password", { exact: true }) });
  await expect(passwordForm.locator('input[autocomplete="username"]')).toHaveValue("admin");
  await accountDialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // Another user's account must never be filled from or saved as the viewer's sign-in.
  await page.goto("/system?tab=users");
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  const userDialog = page.getByRole("dialog", { name: "Add user", exact: true });
  await expect(userDialog.getByRole("textbox", { name: "Username", exact: true })).toHaveAttribute(
    "autocomplete",
    "off",
  );
  await expect(userDialog.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "off");
  await userDialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // Neither may a proxy login.
  await page.goto("/system?tab=proxy");
  await page.getByRole("button", { name: "Add proxy", exact: true }).click();
  const proxyDialog = page.getByRole("dialog", { name: "Add proxy", exact: true });
  await expect(proxyDialog.getByRole("textbox", { name: "Username", exact: true })).toHaveAttribute(
    "autocomplete",
    "off",
  );
  await expect(proxyDialog.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "off");
});

test("a remote source's library work check runs and schedules from its row", async ({ page }) => {
  await mockCacheSettings(page, () => undefined);
  const remote = fileSourceFixture({
    id: 8,
    code: "example-remote",
    displayName: "Example Remote",
    sourceType: "kikoeru_compatible",
    priority: 30,
    endpoint: {
      ...fileSourceFixture().endpoint,
      baseUrl: "https://remote.example",
      apiUrl: "https://api.remote.example",
    },
  });
  const runs: unknown[] = [];
  const triggerWrites: Record<string, unknown>[] = [];
  let triggers: WorkflowTrigger[] = [];
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authenticatedStateFixture({
        username: "admin",
        displayName: "Admin",
        role: "admin",
        permissions: ["library:read", "sources:write", "downloads:manage", "users:manage", "workflows:run"],
        devMode: true,
      }),
    }),
  );
  await page.route("**/api/file-sources", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      json: [
        {
          ...remote,
          presenceCheck: {
            lastRun: { id: 61, status: "succeeded", at: fixtureTimestamp, checkedWorks: 100, availableWorks: 12 },
            nextRunAt: null,
          },
        },
      ] satisfies FileSource[],
    });
  });
  await page.route("**/api/workflow-definitions", (route) =>
    route.fulfill({
      json: [
        {
          id: 21,
          code: "source_presence_check",
          displayName: "Check works on a source",
          description: "",
          definitionJson: "{}",
          scope: "system",
          editable: false,
          ownerUserId: null,
          triggerCount: 0,
          createdAt: "",
          updatedAt: "",
        },
      ] satisfies WorkflowDefinition[],
    }),
  );
  await page.route("**/api/workflow-triggers", async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      triggerWrites.push(payload);
      const created: WorkflowTrigger = {
        id: 71,
        workflowDefinitionId: 21,
        workflowCode: "source_presence_check",
        displayName: String(payload.displayName),
        triggerType: String(payload.triggerType),
        enabled: true,
        scheduleJson: String(payload.scheduleJson),
        configJson: String(payload.configJson),
        nextRunAt: "2099-01-01 00:00:00",
        lastRunAt: null,
        lastSuccessAt: null,
        lastErrorMessage: "",
        createdAt: "",
        updatedAt: "",
      };
      triggers = [created];
      await route.fulfill({ status: 201, json: created });
      return;
    }
    await route.fulfill({ json: triggers });
  });
  await page.route("**/api/workflow-runs/source-presence-check", async (route) => {
    runs.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { runId: 62, jobId: 72, status: "queued", existing: false } });
  });

  await page.goto("/system?tab=library");
  const libraries = page.getByRole("region", { name: "Libraries", exact: true });
  // The row says how the latest check went and opens the check.
  await expect(libraries.getByText("Works checked", { exact: false })).toContainText("12 available");
  await libraries.getByRole("button", { name: "Check library works…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Check library works" });
  await expect(dialog.getByRole("switch", { name: "At startup", exact: true })).toHaveAttribute(
    "aria-checked",
    "false",
  );

  // A schedule stores the options Run uses, for this source.
  await dialog.getByRole("group", { name: "Works per run", exact: true }).getByRole("button", { name: "250" }).click();
  await dialog.getByRole("switch", { name: "On a schedule", exact: true }).click();
  await expect.poll(() => triggerWrites.length).toBe(1);
  expect(triggerWrites[0]).toMatchObject({ workflowDefinitionId: 21, triggerType: "schedule", enabled: true });
  expect(JSON.parse(String(triggerWrites[0].configJson))).toEqual({
    sourceId: 8,
    library: "local",
    filter: "no_remote_source",
    limit: 250,
  });
  expect(JSON.parse(String(triggerWrites[0].scheduleJson))).toEqual({ intervalMinutes: 1440 });
  await expect(dialog.getByRole("combobox", { name: "Interval", exact: true })).toHaveValue("1440");

  await dialog.getByRole("button", { name: "Run", exact: true }).click();
  await expect.poll(() => runs).toEqual([{ sourceId: 8, library: "local", filter: "no_remote_source", limit: 250 }]);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Library work check queued as run #62.", { exact: true })).toBeVisible();
});
