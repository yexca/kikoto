import { expect, test } from "@playwright/test";
import { mockApplication, persistedTrack, seedPlayer, work } from "./fixtures/player-library";
import { syntheticWorkCode } from "../../src/test-support/workCode";
import type {
  LibrarySource,
  MaintenanceWork,
  MaintenanceWorkPage,
  MetadataIssueWork,
  UnlinkedWorkDeleteResult,
  UnlinkedWorkSourceCheckResult,
  VoiceAliasCandidate,
  VoiceMergeReview,
  VoiceSummaryPage,
} from "../../src/lib/api";
import {
  appSettingsFixture,
  librarySourceFixture,
  metadataIssueWorkFixture,
  workDetailFixture,
  voiceDetailFixture,
  voiceSummaryFixture,
  type ApiErrorBody,
  type ApiResponse,
} from "./fixtures/api";

test("metadata operators retry selected issues without source settings access", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "playback:use", "metadata:sync"],
  });
  await seedPlayer(page, persistedTrack, 1);
  let settingsRequests = 0;
  await page.route("**/api/settings", async (route) => {
    settingsRequests++;
    await route.fulfill({ status: 403, json: { error: "permission denied" } satisfies ApiErrorBody });
  });
  let failList = false;
  let items: MetadataIssueWork[] = [0, 1].map((index) =>
    metadataIssueWorkFixture({
      workId: index + 1,
      primaryCode: syntheticWorkCode("RJ", index),
      title: `Synthetic work ${index}`,
      issues: [
        {
          component: "metadata",
          status: index === 0 ? "unavailable" : "failed",
          failureCount: 2,
          firstFailedAt: "2026-01-01 00:00:00",
          checkedAt: "2026-01-02 00:00:00",
        },
      ],
    }),
  );
  await page.route("**/api/maintenance/works?*", async (route) => {
    await route.fulfill(
      failList
        ? { status: 503, json: { error: "unavailable" } satisfies ApiErrorBody }
        : {
            json: {
              works: items.map(asMaintenanceWork),
              page: 1,
              pageSize: 25,
              total: items.length,
            } satisfies MaintenanceWorkPage,
          },
    );
  });
  const retries: number[][] = [];
  await page.route("**/api/metadata/issues/retry", async (route) => {
    const { workIds } = route.request().postDataJSON() as { workIds: number[] };
    retries.push(workIds);
    items = items.map((item) => ({ ...item, retrying: workIds.includes(item.workId) }));
    await route.fulfill({
      status: 202,
      json: { queued: workIds.length, skipped: 0, failed: 0 } satisfies ApiResponse<"retryMetadataIssues">,
    });
  });
  await page.goto("/maintenance?tab=works&reason=metadata");
  const list = page.getByRole("region", { name: "Metadata records" });
  await expect(list).toBeVisible();
  await list.getByText("Affected editions and providers (1)").first().click();
  await expect(list.getByRole("listitem").filter({ hasText: syntheticWorkCode("RJ", 0) })).toContainText(
    "Product unavailable",
  );
  expect(settingsRequests).toBe(0);
  const selectFirst = list.getByRole("checkbox", { name: `Select ${syntheticWorkCode("RJ", 0)}`, exact: true });
  const touchTarget = await selectFirst.boundingBox();
  expect(touchTarget?.width).toBeGreaterThanOrEqual(44);
  expect(touchTarget?.height).toBeGreaterThanOrEqual(44);
  await selectFirst.click();
  await page.getByRole("button", { name: "Retry metadata (1)", exact: true }).click();
  expect(retries).toEqual([[1]]);
  await expect(
    list.getByRole("checkbox", { name: `Select ${syntheticWorkCode("RJ", 0)}`, exact: true }),
  ).toBeDisabled();
  await expect(list.getByText("Retry queued or running")).toBeVisible();
  failList = true;
  await page.getByRole("button", { name: "Refresh list", exact: true }).click();
  await expect(list.getByRole("alert")).toBeVisible();
  await expect(list.getByRole("link", { name: /Synthetic work 0/ })).toBeVisible();
  failList = false;
  items = items.filter((item) => item.workId !== 1);
  await page.getByRole("button", { name: "Refresh list", exact: true }).click();
  await expect(list.getByRole("link", { name: /Synthetic work 0/ })).toHaveCount(0);
  // Internal navigation must preserve the global media element and its queue.
  const audio = await page.locator("audio").first().elementHandle();
  expect(audio).not.toBeNull();
  await list.getByRole("link", { name: /Synthetic work 1/ }).click();
  await expect(page).toHaveURL(new RegExp(`/${syntheticWorkCode("RJ", 1)}$`));
  expect(await audio!.evaluate((element) => element.isConnected)).toBe(true);
});

test("metadata operators fetch an issue from an enabled metadata source", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "metadata:sync"],
  });
  await page.route("**/api/library-sources", (route) =>
    route.fulfill({
      json: [
        librarySourceFixture({ id: 4, displayName: "Example Remote A" }),
        librarySourceFixture({ id: 5, code: "example_remote_b", displayName: "Example Remote B", enabled: false }),
        librarySourceFixture({
          id: 6,
          code: "example_remote_c",
          displayName: "Example Remote C",
          metadataCapable: false,
        }),
      ] satisfies LibrarySource[],
    }),
  );
  const item = metadataIssueWorkFixture({
    workId: 1,
    primaryCode: syntheticWorkCode("RJ", 0),
    title: "Synthetic work 0",
    issues: [
      {
        component: "metadata",
        status: "unavailable",
        failureCount: 1,
        firstFailedAt: "2026-01-01 00:00:00",
        checkedAt: "2026-01-02 00:00:00",
      },
    ],
  });
  await page.route("**/api/maintenance/works?*", (route) =>
    route.fulfill({
      json: { works: [asMaintenanceWork(item)], page: 1, pageSize: 25, total: 1 } satisfies MaintenanceWorkPage,
    }),
  );
  const retries: unknown[] = [];
  await page.route("**/api/metadata/issues/retry", async (route) => {
    retries.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      json: { queued: 1, skipped: 0, failed: 0 } satisfies ApiResponse<"retryMetadataIssues">,
    });
  });
  await page.goto("/maintenance?tab=works&reason=metadata");
  const list = page.getByRole("region", { name: "Metadata records" });
  await list.getByText("Affected editions and providers (1)").click();
  const fetchEdition = (source: string) =>
    list.getByRole("button", { name: `Fetch ${syntheticWorkCode("RJ", 0)} from ${source}`, exact: true });
  await expect(fetchEdition("Example Remote B")).toHaveCount(0);
  await expect(fetchEdition("Example Remote C")).toHaveCount(0);
  await fetchEdition("Example Remote A").click();
  await expect.poll(() => retries).toEqual([{ workIds: [1], sourceId: 4 }]);
  await list.getByRole("checkbox", { name: `Select ${syntheticWorkCode("RJ", 0)}`, exact: true }).click();
  await page.getByRole("button", { name: "Fetch from Example Remote A (1)", exact: true }).click();
  await expect
    .poll(() => retries)
    .toEqual([
      { workIds: [1], sourceId: 4 },
      { workIds: [1], sourceId: 4 },
    ]);
});

test("metadata operators dismiss products reported as not found", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "metadata:sync"],
  });
  let items: MetadataIssueWork[] = [0, 1].map((index) =>
    metadataIssueWorkFixture({
      workId: index + 1,
      primaryCode: syntheticWorkCode("RJ", index),
      title: `Synthetic work ${index}`,
      issues: [
        {
          component: "metadata",
          status: index === 0 ? "unavailable" : "failed",
          failureCount: 1,
          firstFailedAt: "2026-01-01 00:00:00",
          checkedAt: "2026-01-02 00:00:00",
        },
      ],
    }),
  );
  await page.route("**/api/maintenance/works?*", (route) =>
    route.fulfill({
      json: {
        works: items.map(asMaintenanceWork),
        page: 1,
        pageSize: 25,
        total: items.length,
      } satisfies MaintenanceWorkPage,
    }),
  );
  const dismissals: number[][] = [];
  await page.route("**/api/metadata/issues/dismiss", async (route) => {
    const { workIds } = route.request().postDataJSON() as { workIds: number[] };
    dismissals.push(workIds);
    items = items.filter((item) => !workIds.includes(item.workId) || item.issues[0].status !== "unavailable");
    await route.fulfill({
      json: { dismissed: 1, skipped: workIds.length - 1 } satisfies ApiResponse<"dismissMetadataIssues">,
    });
  });
  await page.goto("/maintenance?tab=works&reason=metadata");
  const list = page.getByRole("region", { name: "Metadata records" });
  for (const index of [0, 1]) await list.getByText("Affected editions and providers (1)").nth(index).click();
  await expect(list.getByRole("button", { name: `Dismiss ${syntheticWorkCode("RJ", 0)}`, exact: true })).toBeVisible();
  await expect(list.getByRole("button", { name: `Dismiss ${syntheticWorkCode("RJ", 1)}`, exact: true })).toHaveCount(0);
  for (const index of [0, 1])
    await list.getByRole("checkbox", { name: `Select ${syntheticWorkCode("RJ", index)}`, exact: true }).click();
  await page.getByRole("button", { name: "Dismiss unavailable (1)", exact: true }).click();
  expect(dismissals).toEqual([[1]]);
  await expect(list.getByText("Dismissed: 1 · Not dismissible: 0", { exact: true })).toBeVisible();
  await expect(list.getByRole("link", { name: /Synthetic work 0/ })).toHaveCount(0);
  await expect(list.getByRole("link", { name: /Synthetic work 1/ })).toBeVisible();
});

test("metadata rows show metadata completeness apart from the best available source", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "metadata:sync"],
  });
  const row = (index: number, patch: Partial<MaintenanceWork>): MaintenanceWork => ({
    ...work,
    id: index + 1,
    primaryCode: syntheticWorkCode("RJ", index),
    title: `Synthetic work ${index}`,
    noSource: false,
    sourceTier: "local",
    metadataIssues: [],
    metadataNotSynced: false,
    metadataSyncing: false,
    ...patch,
  });
  let items = [
    row(0, { metadataNotSynced: true }),
    row(1, { remoteMetadataSource: "Example Remote", sourceTier: "remote" }),
    row(2, {}),
    row(3, { noSource: true, sourceTier: "none" }),
  ];
  await page.route("**/api/maintenance/works?*", (route) =>
    route.fulfill({ json: { works: items, page: 1, pageSize: 25, total: items.length } satisfies MaintenanceWorkPage }),
  );
  const retries: number[][] = [];
  await page.route("**/api/metadata/issues/retry", async (route) => {
    const { workIds } = route.request().postDataJSON() as { workIds: number[] };
    retries.push(workIds);
    items = items.map((item) => (workIds.includes(item.id) ? { ...item, metadataSyncing: true } : item));
    await route.fulfill({
      status: 202,
      json: { queued: workIds.length, skipped: 0, failed: 0 } satisfies ApiResponse<"retryMetadataIssues">,
    });
  });
  await page.goto("/maintenance?tab=works&reason=catalog");
  const list = page.getByRole("region", { name: "Metadata records" });
  const rowFor = (index: number) => list.getByRole("row").filter({ hasText: syntheticWorkCode("RJ", index) });
  const select = (index: number) =>
    list.getByRole("checkbox", { name: `Select ${syntheticWorkCode("RJ", index)}`, exact: true });
  await expect(rowFor(0)).toContainText("Not synced");
  await expect(rowFor(1)).toContainText("Metadata from Example Remote");
  await expect(rowFor(1)).not.toContainText("Complete");
  await expect(rowFor(2)).toContainText("Complete");
  // Local and remote sources are both healthy; only a family with no source takes the attention color.
  await expect(rowFor(0).getByText("Local", { exact: true })).toBeVisible();
  await expect(rowFor(1).getByText("Remote", { exact: true })).toBeVisible();
  await expect(rowFor(3).getByText("No available source", { exact: true })).toBeVisible();
  // Complete metadata leaves a metadata-only operator nothing to retry.
  await expect(select(1)).toBeDisabled();
  await expect(select(2)).toBeDisabled();
  await select(0).click();
  await page.getByRole("button", { name: "Retry metadata (1)", exact: true }).click();
  expect(retries).toEqual([[1]]);
  await expect(rowFor(0)).toContainText("Sync queued or running");
  await expect(select(0)).toBeDisabled();
});

test("@desktop metadata page selection resets when searching or changing pages", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "metadata:sync"],
  });
  const items = Array.from({ length: 26 }, (_, index) =>
    metadataIssueWorkFixture({
      workId: index + 1,
      primaryCode: syntheticWorkCode("RJ", index),
      title: `Synthetic work ${index}`,
      issues: [
        {
          component: "metadata",
          status: "failed",
          failureCount: 1,
          firstFailedAt: "2026-01-01 00:00:00",
          checkedAt: "2026-01-01 00:00:00",
        },
      ],
    }),
  );
  await page.route("**/api/maintenance/works?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const currentPage = Number(params.get("page") ?? 1);
    const query = params.get("q") ?? "";
    const filtered = items.filter((item) => item.primaryCode.includes(query));
    await route.fulfill({
      json: {
        works: filtered.slice((currentPage - 1) * 25, currentPage * 25).map(asMaintenanceWork),
        page: currentPage,
        pageSize: 25,
        total: filtered.length,
      } satisfies MaintenanceWorkPage,
    });
  });
  await page.goto("/maintenance?tab=works&reason=metadata");
  const list = page.getByRole("region", { name: "Metadata records" });
  await list.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry metadata (25)", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next page", exact: true }).first().click();
  await expect(list.getByRole("link", { name: /Synthetic work 25/ })).toBeVisible();
  // Without a selection the selection bar gives way to the pagination.
  await expect(page.getByRole("button", { name: /^Retry metadata/ })).toHaveCount(0);
  await list.getByRole("checkbox", { name: `Select ${syntheticWorkCode("RJ", 25)}`, exact: true }).click();
  await page.getByRole("searchbox", { name: "Search metadata", exact: true }).fill(syntheticWorkCode("RJ", 0));
  await page.getByRole("searchbox", { name: "Search metadata", exact: true }).press("Enter");
  await expect(list.getByRole("checkbox", { name: /^Select RJ/ })).toHaveCount(1);
  await expect(list.getByRole("link", { name: /Synthetic work 0/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Retry metadata/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Previous page", exact: true }).first()).toBeDisabled();
});

test("@desktop personal metadata language refreshes the current list and preserves its state", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "playback:use", "metadata:sync"],
  });
  await seedPlayer(page, persistedTrack, 1);
  const settings = appSettingsFixture();
  let languages: string[] | null = null;
  const saves: Array<string[] | null> = [];
  await page.route("**/api/auth/me/preferences", async (route) => {
    if (route.request().method() === "PATCH") {
      languages = (route.request().postDataJSON() as { metadataLanguages: string[] | null }).metadataLanguages;
      saves.push(languages);
    }
    await route.fulfill({
      json: {
        directoryRoutingRules: settings.directoryRoutingRules,
        recommendationConfig: settings.recommendationConfig,
        recommendationDefaults: settings.recommendationDefaults,
        recommendationThreshold: settings.recommendationThreshold,
        metadataLanguages: languages,
        timeZone: null,
      } satisfies ApiResponse<"getUserPreferences">,
    });
  });
  let failList = false;
  const reads: Array<{ page: number; query: string }> = [];
  await page.route("**/api/maintenance/works?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const currentPage = Number(params.get("page"));
    const query = params.get("q") ?? "";
    reads.push({ page: currentPage, query });
    const items = Array.from({ length: 26 }, (_, index) =>
      asMaintenanceWork(
        metadataIssueWorkFixture({
          workId: index + 1,
          primaryCode: syntheticWorkCode("RJ", index),
          title: `Example Work ${languages?.[0] === "en-us" ? "English" : "Japanese"} ${index}`,
          issues: [
            {
              component: "metadata",
              status: "failed",
              failureCount: 1,
              firstFailedAt: "2026-01-01 00:00:00",
              checkedAt: "2026-01-01 00:00:00",
            },
          ],
        }),
      ),
    );
    await route.fulfill(
      failList
        ? { status: 503, json: { error: "unavailable" } satisfies ApiErrorBody }
        : {
            json: {
              works: items.slice((currentPage - 1) * 25, currentPage * 25),
              page: currentPage,
              pageSize: 25,
              total: items.length,
            } satisfies MaintenanceWorkPage,
          },
    );
  });
  await page.goto("/metadata?reason=metadata");
  await page.getByRole("button", { name: "Collapse player", exact: true }).click();
  const list = page.getByRole("region", { name: "Metadata records" });
  const search = page.getByRole("searchbox", { name: "Search metadata", exact: true });
  await search.fill("Example Work");
  await search.press("Enter");
  await page.getByRole("button", { name: "Next page", exact: true }).first().click();
  await expect(list.getByRole("link", { name: /Example Work Japanese 25/ })).toBeVisible();
  const selected = list.getByRole("checkbox", { name: `Select ${syntheticWorkCode("RJ", 25)}`, exact: true });
  await selected.click();
  const audio = await page.locator("audio").first().elementHandle();
  expect(audio).not.toBeNull();
  await page.getByRole("button", { name: "User menu" }).click();
  const language = page.getByRole("combobox", { name: "Preferred metadata language" });
  // Without a preference each work shows its original language.
  await expect(language).toHaveText("Origin");
  const choose = async (name: string) => {
    await language.click();
    await page.getByRole("listbox").getByRole("option", { name, exact: true }).click();
    await expect(language).toHaveText(name);
  };
  await choose("English");
  await expect(list.getByRole("link", { name: /Example Work English 25/ })).toBeVisible();
  await expect(selected).toBeChecked();
  await expect(search).toHaveValue("Example Work");
  expect(reads.at(-1)).toEqual({ page: 2, query: "Example Work" });
  expect(await audio!.evaluate((element) => element.isConnected)).toBe(true);

  // A presentation reload failure preserves the known list and selection.
  failList = true;
  await choose("Japanese");
  await expect(list.getByRole("alert")).toBeVisible();
  await expect(list.getByRole("link", { name: /Example Work English 25/ })).toBeVisible();
  await expect(selected).toBeChecked();
  failList = false;
  await choose("Origin");
  await expect(list.getByRole("link", { name: /Example Work Japanese 25/ })).toBeVisible();
  await expect(list.getByRole("alert")).toHaveCount(0);
  await expect(selected).toBeChecked();
  expect(reads.at(-1)).toEqual({ page: 2, query: "Example Work" });
  expect(saves).toEqual([["en-us", "origin"], ["ja-jp", "origin"], null]);
});

function asMaintenanceWork(item: MetadataIssueWork): MaintenanceWork {
  return {
    ...work,
    id: item.workId,
    primaryCode: item.primaryCode,
    title: item.title,
    noSource: false,
    sourceTier: "local",
    metadataIssues: [item],
    metadataNotSynced: false,
    metadataSyncing: false,
  };
}

test("work maintenance keeps source actions scoped and metadata settings separate", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "sources:write", "metadata:sync"],
  });
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: appSettingsFixture({
        fileSources: [],
        directoryRoutingRules: [],
        catalogFreshnessDays: 30,
      }),
    }),
  );
  const issue = metadataIssueWorkFixture({
    workId: 2,
    primaryCode: syntheticWorkCode("RJ", 1),
    title: "Example edition",
    issues: [
      {
        component: "cover",
        status: "failed",
        failureCount: 1,
        firstFailedAt: "2026-01-01 00:00:00",
        checkedAt: "2026-01-01 00:00:00",
      },
    ],
  });
  const items: MaintenanceWork[] = [
    {
      ...work,
      id: 1,
      primaryCode: syntheticWorkCode("RJ", 0),
      title: "Example mixed work",
      noSource: true,
      sourceTier: "none",
      metadataIssues: [issue],
      metadataNotSynced: false,
      metadataSyncing: false,
    },
    {
      ...work,
      id: 3,
      primaryCode: syntheticWorkCode("RJ", 2),
      title: "Example source-only work",
      noSource: true,
      sourceTier: "none",
      metadataIssues: [],
      metadataNotSynced: false,
      metadataSyncing: false,
    },
  ];
  await page.route("**/api/maintenance/works?*", async (route) => {
    const reason = new URL(route.request().url()).searchParams.get("reason");
    const works = items.filter((item) => reason !== "metadata" || item.metadataIssues.length > 0);
    await route.fulfill({ json: { works, page: 1, pageSize: 25, total: works.length } satisfies MaintenanceWorkPage });
  });
  let retried: number[] = [];
  await page.route("**/api/metadata/issues/retry", async (route) => {
    retried = route.request().postDataJSON().workIds;
    await route.fulfill({
      status: 202,
      json: { queued: retried.length, skipped: 0, failed: 0 } satisfies ApiResponse<"retryMetadataIssues">,
    });
  });
  let checked: number[] = [];
  await page.route("**/api/maintenance/unlinked-works/source-check", async (route) => {
    checked = route.request().postDataJSON().workIds;
    await route.fulfill({
      status: 202,
      json: {
        runId: 1,
        jobId: 2,
        status: "queued",
        queued: checked.length,
        skipped: [],
      } satisfies UnlinkedWorkSourceCheckResult,
    });
  });
  let deleted: number[] = [];
  await page.route("**/api/maintenance/unlinked-works/delete", async (route) => {
    deleted = route.request().postDataJSON().workIds;
    await route.fulfill({
      json: {
        deletedFamilyCount: deleted.length,
        deletedWorkCount: deleted.length,
        deletedWorkIds: deleted,
        deletedCodes: [],
        retainedAssetFiles: 0,
        skipped: [],
      } satisfies UnlinkedWorkDeleteResult,
    });
  });
  await page.goto("/maintenance?tab=works");
  const list = page.getByRole("region", { name: "Metadata records", exact: true });
  const filter = page.getByRole("group", { name: "Filter DLsite works", exact: true });
  await expect(filter.getByRole("button", { name: "Needs attention", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(list.getByRole("button", { name: /Delete local information/ })).toHaveCount(0);
  await list.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry metadata (1)", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Retry metadata (1)", exact: true }).click();
  expect(retried).toEqual([2]);
  await list.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await page.getByRole("button", { name: "Check sources (2)", exact: true }).click();
  expect(checked).toEqual([1, 3]);
  await filter.getByRole("button", { name: "Metadata issues", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Retry metadata/ })).toHaveCount(0);
  const row = list.getByRole("row").filter({ hasText: "Example mixed work" });
  await expect(row.getByText("No available source", { exact: true })).toBeVisible();
  await expect(row.getByText("Metadata issues", { exact: true })).toBeVisible();
  await row.getByText("Affected editions and providers (1)").click();
  await expect(row.getByRole("button", { name: `Retry ${syntheticWorkCode("RJ", 1)}`, exact: true })).toBeEnabled();
  await filter.getByRole("button", { name: "No available source", exact: true }).click();
  await list.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await page.getByRole("button", { name: "Delete local information (2)", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete local work information?" });
  await expect(dialog).toBeVisible();
  expect(deleted).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.keyboard.press("Control+Home");
  await page.getByRole("button", { name: "Metadata settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Metadata settings", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/tab=settings/);
  await page
    .getByRole("dialog", { name: "Metadata settings", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(filter.getByRole("button", { name: "No available source", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(list).toBeVisible();
});

for (const viewport of ["mobile", "@desktop"]) {
  test(`${viewport} Metadata catalog includes healthy works and preserves filters under settings`, async ({
    page,
  }, testInfo) => {
    await mockApplication(page, undefined, false, 1, 0, [], undefined, {
      authenticated: true,
      permissions: ["library:read", "sources:write", "metadata:sync", "workflows:run"],
    });
    const records: MaintenanceWork[] = [
      {
        ...work,
        id: 1,
        primaryCode: syntheticWorkCode("RJ", 0),
        title: "Example healthy work",
        noSource: false,
        sourceTier: "local",
        metadataIssues: [],
        metadataNotSynced: false,
        metadataSyncing: false,
      },
      {
        ...work,
        id: 2,
        primaryCode: syntheticWorkCode("RJ", 1),
        title: "Example missing-source work",
        noSource: true,
        sourceTier: "none",
        metadataIssues: [],
        metadataNotSynced: false,
        metadataSyncing: false,
      },
    ];
    const requests: string[] = [];
    await page.route("**/api/maintenance/works?*", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const reason = params.get("reason") ?? "all";
      requests.push(reason);
      const works = records.filter(
        (record) =>
          (reason === "catalog" || (reason !== "metadata" && record.noSource)) &&
          record.title.includes(params.get("q") ?? ""),
      );
      await route.fulfill({
        json: { works, page: 1, pageSize: 25, total: works.length } satisfies MaintenanceWorkPage,
      });
    });
    await page.route("**/api/settings", (route) =>
      route.fulfill({
        json: appSettingsFixture({ fileSources: [], catalogFreshnessDays: 30 }),
      }),
    );
    await page.goto(viewport === "mobile" ? "/work-management" : "/metadata");
    await expect(page).toHaveURL(/\/metadata$/);
    await expect(page.getByRole("heading", { name: "Metadata", exact: true })).toBeVisible();
    const tabs = page.getByRole("tablist", { name: "Metadata views" });
    await expect(tabs.getByRole("tab")).toHaveText([
      "DLsite works",
      "Custom works",
      "Translation",
      "Tags",
      "Circles",
      "Voice actors",
    ]);
    await expect(tabs.getByRole("tab", { name: "DLsite works", exact: true })).toHaveAttribute("aria-selected", "true");
    const filter = page.getByRole("group", { name: "Filter DLsite works", exact: true });
    await expect(filter.getByRole("button")).toHaveText([
      /^All/,
      /^Needs attention/,
      /^Metadata issues/,
      /^No available source/,
    ]);
    await expect(filter.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
    const list = page.getByRole("region", { name: "Metadata records", exact: true });
    await expect(list.getByRole("link", { name: "Example healthy work", exact: true })).toBeVisible();
    expect(requests).toContain("catalog");
    await filter.getByRole("button", { name: "Needs attention", exact: true }).click();
    await expect(page).toHaveURL(/\/metadata\?reason=all$/);
    await expect(filter.getByRole("button", { name: "Needs attention", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(tabs.getByRole("tab", { name: "DLsite works", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(list.getByRole("link", { name: "Example healthy work", exact: true })).toHaveCount(0);
    await expect(list.getByRole("link", { name: "Example missing-source work", exact: true })).toBeVisible();
    // The view rail sits beside the header, so wide layouts keep search inline; the narrowest
    // phones start behind its icon.
    if (viewport === "mobile") {
      await page.setViewportSize({ width: 320, height: 760 });
      const searchToggle = page.getByRole("button", { name: "Search metadata", exact: true });
      await expect(searchToggle).toHaveAttribute("aria-expanded", "false");
      await searchToggle.click();
      await expect(page.getByRole("searchbox", { name: "Search metadata", exact: true })).toBeFocused();
    } else {
      await expect(page.getByRole("button", { name: "Search metadata", exact: true })).toHaveCount(0);
      // Wide layouts start with the views in a row that names the open one; the column
      // rail leaves it unnamed, so the header names it beside the search field.
      const heading = page.getByRole("heading", { level: 2, name: "DLsite works", exact: true });
      await expect(heading).toBeHidden();
      await page.getByRole("button", { name: "Show tabs beside", exact: true }).click();
      await expect(heading).toBeVisible();
      await page.getByRole("button", { name: "Show tabs above", exact: true }).click();
      await expect(heading).toBeHidden();
    }
    await page.getByRole("searchbox", { name: "Search metadata", exact: true }).fill("Example");
    await page.getByRole("searchbox", { name: "Search metadata", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Metadata settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Metadata settings", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Remote metadata fallback", exact: true })).toBeVisible();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(filter.getByRole("button", { name: "Needs attention", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("searchbox", { name: "Search metadata", exact: true })).toHaveValue("Example");
    await page.screenshot({ path: testInfo.outputPath("metadata-management.png") });
    await expect(page.getByRole("button", { name: "Metadata sync", exact: true })).toHaveCount(0);
  });
}

test("@desktop Metadata table shows management columns, edits a work in place, and does not poll", async ({ page }) => {
  await page.clock.install();
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "library:write", "metadata:sync"],
  });
  const code = syntheticWorkCode("RJ", 0);
  const record: MaintenanceWork = {
    ...work,
    id: 1,
    primaryCode: code,
    title: "Example healthy work",
    circle: "Example Circle",
    noSource: false,
    sourceTier: "local",
    metadataIssues: [],
    metadataNotSynced: false,
    metadataSyncing: false,
  };
  let listRequests = 0;
  await page.route("**/api/maintenance/works?*", async (route) => {
    listRequests++;
    await route.fulfill({ json: { works: [record], page: 1, pageSize: 25, total: 1 } satisfies MaintenanceWorkPage });
  });
  await page.route("**/api/works/1?includeMedia=false", (route) =>
    route.fulfill({ json: workDetailFixture({ ...work, id: 1, primaryCode: code, title: record.title }) }),
  );
  await page.route("**/api/works/1/cover-candidates", (route) => route.fulfill({ json: { candidates: [] } }));
  const saves: unknown[] = [];
  await page.route("**/api/works/1/manual-overrides", async (route) => {
    saves.push(route.request().postDataJSON());
    await route.fulfill({ json: {} });
  });

  await page.goto("/metadata");
  const list = page.getByRole("region", { name: "Metadata records", exact: true });
  await expect(list.getByRole("columnheader")).toHaveText(["", "Work", "Metadata", "Source", "Actions"]);
  const row = list.getByRole("row").filter({ hasText: "Example healthy work" });
  await expect(row.getByRole("cell")).toHaveText([
    /^$/,
    `Example healthy work${code}·Example Circle`,
    "Complete",
    "Local",
    "",
  ]);
  // The list loads on demand; time passing alone must not refetch it, so only the save below adds a request.
  const loadedRequests = listRequests;
  await page.clock.fastForward(30_000);

  await row.getByRole("button", { name: `Edit metadata for ${code}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit metadata" });
  await dialog.getByRole("textbox", { name: "Fallback", exact: true }).fill("Example edited title");
  await dialog.getByRole("tab", { name: /^Credits/ }).click();
  await dialog.getByRole("tab", { name: /^Title/ }).click();
  await expect(dialog.getByRole("textbox", { name: "Fallback", exact: true })).toHaveValue("Example edited title");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(saves).toEqual([{ titles: { "": "Example edited title" } }]);
  await expect.poll(() => listRequests).toBe(loadedRequests + 1);
});

test("@desktop Metadata voice aliases view lists people and opens alias review", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "metadata:sync"],
  });
  const voice = voiceSummaryFixture({
    personId: 7,
    displayName: "Example Voice",
    aliases: ["Example Voice", "Voice alias"],
    knownWorks: 3,
    localWorks: 1,
    remoteWorks: 1,
    playableWorks: 1,
  });
  const listRequests: URL[] = [];
  await page.route("**/api/voices?*", (route) => {
    listRequests.push(new URL(route.request().url()));
    return route.fulfill({
      json: { voices: [voice], page: 1, pageSize: 25, total: 1, tagOptions: [] } satisfies VoiceSummaryPage,
    });
  });
  await page.route("**/api/voices/7?*", (route) =>
    route.fulfill({
      json: voiceDetailFixture(voice, {
        aliasRecords: [
          { id: 1, alias: "Example Voice", source: "primary_name", createdAt: "2026-07-01T00:00:00Z" },
          { id: 2, alias: "Voice alias", source: "manual", createdAt: "2026-07-01T00:00:00Z" },
        ],
      }),
    }),
  );
  await page.route("**/api/voices/7/merges", (route) => route.fulfill({ json: [] satisfies VoiceMergeReview[] }));
  await page.route("**/api/voices/7/alias-candidates?*", (route) =>
    route.fulfill({
      json: [
        {
          personId: 8,
          displayName: "Example Voice Duplicate",
          aliases: [],
          knownWorks: 2,
          localWorks: 0,
          remoteWorks: 0,
        },
      ] satisfies VoiceAliasCandidate[],
    }),
  );
  let mergeRequest: unknown = null;
  await page.route("**/api/voices/7/merge", (route) => {
    mergeRequest = route.request().postDataJSON();
    return route.fulfill({
      json: {
        mergeId: 1,
        targetPersonId: 7,
        sourcePersonId: 8,
        targetName: "Example Voice",
        mergedName: "Example Voice Duplicate",
      } satisfies ApiResponse<"mergeVoiceAliasCandidate">,
    });
  });

  await page.goto("/metadata?view=aliases");
  const tabs = page.getByRole("tablist", { name: "Metadata views" });
  await expect(tabs.getByRole("tab", { name: "Voice actors", exact: true })).toHaveAttribute("aria-selected", "true");
  const region = page.getByRole("region", { name: "Voice actors", exact: true });
  // One row per Kikoto person id, one column per fact.
  const row = region.getByRole("row", { name: /^#7 / });
  await expect(row.getByRole("link", { name: "Example Voice", exact: true })).toHaveAttribute(
    "href",
    "/voices/local-7",
  );
  await expect(row.getByRole("cell", { name: "Voice alias", exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "3", exact: true })).toBeVisible();
  expect(listRequests.at(-1)?.searchParams.get("sort")).toBe("id");

  await region.getByRole("button", { name: "Manage aliases for Example Voice" }).click();
  const dialog = page.getByRole("dialog", { name: "Example Voice" });
  await expect(dialog.getByPlaceholder("Add alias or search duplicate voice actor")).toBeVisible();
  await expect(dialog.getByText("Voice alias", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/view=aliases&voice=7$/);

  // One field offers both actions; the duplicate appears once, with its own merge.
  await dialog.getByPlaceholder("Add alias or search duplicate voice actor").fill("Duplicate");
  await expect(dialog.getByRole("button", { name: 'Add "Duplicate" as an alias' })).toBeVisible();
  await dialog.getByRole("button", { name: "Merge Example Voice Duplicate into this voice actor" }).click();
  const confirm = page.getByRole("dialog", { name: "Merge voice actor" });
  await expect(confirm).toContainText("Example Voice Duplicate");
  await expect(confirm).toContainText("Kept");
  await confirm.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(mergeRequest).toEqual({ sourcePersonId: 8 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/metadata\?view=aliases$/);

  await tabs.getByRole("tab", { name: "DLsite works", exact: true }).click();
  await expect(page).toHaveURL(/\/metadata\?reason=catalog$/);
  await expect(page.getByRole("region", { name: "Metadata records", exact: true })).toBeVisible();
});

test("@desktop Metadata Custom works lists custom works apart from catalog views and opens Add custom work", async ({
  page,
}) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "library:write", "downloads:manage", "sources:write", "metadata:sync"],
  });
  const custom: MaintenanceWork = {
    ...work,
    id: 7,
    primaryCode: "KT00000001",
    title: "Example custom work",
    dlsiteUrl: "",
    noSource: true,
    sourceTier: "none",
    metadataIssues: [],
    metadataNotSynced: false,
    metadataSyncing: false,
  };
  const reasons: string[] = [];
  await page.route("**/api/maintenance/works?*", async (route) => {
    const reason = new URL(route.request().url()).searchParams.get("reason") ?? "";
    reasons.push(reason);
    const works = reason === "custom" ? [custom] : [];
    await route.fulfill({ json: { works, page: 1, pageSize: 25, total: works.length } satisfies MaintenanceWorkPage });
  });
  await page.route("**/api/custom-works/folders?*", (route) =>
    route.fulfill({
      json: {
        folders: [{ path: "Example Folder", name: "Example Folder", inUse: false }],
        truncated: false,
        noticeAccepted: true,
      },
    }),
  );
  await page.route("**/api/custom-works/notice-acceptance", (route) =>
    route.fulfill({ json: { noticeAccepted: true } }),
  );

  await page.goto("/metadata?reason=catalog");
  await page.getByRole("tab", { name: "Custom works", exact: true }).click();
  await expect(page).toHaveURL(/\/metadata\?reason=custom$/);
  const list = page.getByRole("region", { name: "Metadata records", exact: true });
  const row = list.getByRole("row").filter({ hasText: "Example custom work" });
  await expect(row.getByText("No available source", { exact: true })).toBeVisible();
  expect(reasons.at(-1)).toBe("custom");
  // A custom work has nothing to retry or check, but a missing folder can still be cleaned up here.
  await expect(page.getByRole("button", { name: /^Retry metadata/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Check sources/ })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Delete local information for KT00000001", exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "Add custom work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add custom work", exact: true });
  // The dialog walks the library only when asked.
  await dialog.getByRole("button", { name: "Scan library folders", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Folders without a work code", exact: true })).toContainText(
    "Example Folder",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/\/metadata\?reason=custom$/);
  await expect(row).toBeVisible();
});

for (const viewport of ["mobile", "@desktop"]) {
  test(`${viewport} Metadata rail counts the views and the inspector recovers one work`, async ({ page }) => {
    await mockApplication(page, undefined, false, 1, 0, [], undefined, {
      authenticated: true,
      permissions: ["library:read", "sources:write", "metadata:sync"],
    });
    const code = syntheticWorkCode("RJ", 0);
    let record: MaintenanceWork = {
      ...work,
      id: 1,
      primaryCode: code,
      title: "Example inspected work",
      circle: "Example Circle",
      releaseDate: "2026-01-02",
      series: "Example Series",
      voiceActors: ["Example Voice"],
      tags: ["Example Tag"],
      noSource: false,
      sourceTier: "remote",
      metadataIssues: [],
      metadataNotSynced: true,
      metadataSyncing: false,
    };
    let countRequests = 0;
    await page.route("**/api/maintenance/works/counts", (route) => {
      countRequests++;
      return route.fulfill({
        json: { catalog: 4, all: 3, metadata: 2, noSource: 1, custom: 0 } satisfies ApiResponse<"getMaintenanceCounts">,
      });
    });
    await page.route("**/api/maintenance/works?*", (route) =>
      route.fulfill({ json: { works: [record], page: 1, pageSize: 25, total: 1 } satisfies MaintenanceWorkPage }),
    );
    const retries: number[][] = [];
    await page.route("**/api/metadata/issues/retry", async (route) => {
      const { workIds } = route.request().postDataJSON() as { workIds: number[] };
      retries.push(workIds);
      record = { ...record, metadataSyncing: true };
      await route.fulfill({
        status: 202,
        json: { queued: workIds.length, skipped: 0, failed: 0 } satisfies ApiResponse<"retryMetadataIssues">,
      });
    });
    await page.goto("/metadata?reason=all");
    const tabs = page.getByRole("tablist", { name: "Metadata views" });
    // Counts describe the views and filters without changing their names.
    await expect(
      page
        .getByRole("group", { name: "Filter DLsite works", exact: true })
        .getByRole("button", { name: "Metadata issues", exact: true }),
    ).toHaveAccessibleDescription(/2 works/);
    await expect(tabs.getByRole("tab", { name: "Custom works", exact: true })).toHaveAccessibleDescription(/0 works/);

    const list = page.getByRole("region", { name: "Metadata records", exact: true });
    await list.getByRole("button", { name: `Inspect ${code}`, exact: true }).click();
    // Wide screens keep the inspector beside the table; phones open it as a sheet.
    const inspector = page.getByRole(viewport === "mobile" ? "dialog" : "complementary", {
      name: "Example inspected work",
    });
    for (const fact of ["2026-01-02", "Example Series", "Example Voice", "Example Tag", "Not synced", "Remote"])
      await expect(inspector).toContainText(fact);
    await inspector.getByRole("button", { name: "Retry metadata", exact: true }).click();
    expect(retries).toEqual([[1]]);
    await expect(inspector).toContainText("Sync queued or running");
    await expect(inspector.getByRole("button", { name: "Retry metadata", exact: true })).toHaveCount(0);
    // A recovery may move works between views, so the counts reload.
    await expect.poll(() => countRequests).toBeGreaterThan(1);
    await inspector.getByRole("button", { name: "Close inspector", exact: true }).click();
    await expect(inspector).toHaveCount(0);
  });
}
