import { expect, test } from "@playwright/test";
import { mockApplication, persistedTrack, seedPlayer, work } from "./fixtures/player-library";
import { syntheticWorkCode } from "../../src/test-support/workCode";

test("metadata operators retry selected issues without source settings access", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "playback:use", "metadata:sync"],
  });
  await seedPlayer(page, persistedTrack, 1);
  let settingsRequests = 0;
  await page.route("**/api/settings", async (route) => {
    settingsRequests++;
    await route.fulfill({ status: 403, json: { error: "permission denied" } });
  });
  let failList = false;
  let items = [0, 1].map((index) => ({
    workId: index + 1,
    primaryCode: syntheticWorkCode("RJ", index),
    title: `Synthetic work ${index}`,
    providerCode: "dlsite",
    providerName: "DLsite",
    retrying: false,
    issues: [
      {
        component: "metadata",
        status: index === 0 ? "unavailable" : "failed",
        failureCount: 2,
        firstFailedAt: "2026-01-01 00:00:00",
        checkedAt: "2026-01-02 00:00:00",
      },
    ],
  }));
  await page.route("**/api/maintenance/works?*", async (route) => {
    await route.fulfill(
      failList
        ? { status: 503, json: { error: "unavailable" } }
        : { json: { works: items.map(asMaintenanceWork), page: 1, pageSize: 25, total: items.length } },
    );
  });
  const retries: number[][] = [];
  await page.route("**/api/metadata/issues/retry", async (route) => {
    const { workIds } = route.request().postDataJSON() as { workIds: number[] };
    retries.push(workIds);
    items = items.map((item) => ({ ...item, retrying: workIds.includes(item.workId) }));
    await route.fulfill({ status: 202, json: { queued: workIds.length, skipped: 0, failed: 0 } });
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

test("@desktop metadata page selection resets when searching or changing pages", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "metadata:sync"],
  });
  const items = Array.from({ length: 26 }, (_, index) => ({
    workId: index + 1,
    primaryCode: syntheticWorkCode("RJ", index),
    title: `Synthetic work ${index}`,
    providerCode: "dlsite",
    providerName: "DLsite",
    retrying: false,
    issues: [
      {
        component: "metadata",
        status: "failed",
        failureCount: 1,
        firstFailedAt: "2026-01-01 00:00:00",
        checkedAt: "2026-01-01 00:00:00",
      },
    ],
  }));
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
      },
    });
  });
  await page.goto("/maintenance?tab=works&reason=metadata");
  const list = page.getByRole("region", { name: "Metadata records" });
  await list.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry metadata (25)", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next page", exact: true }).first().click();
  await expect(list.getByRole("link", { name: /Synthetic work 25/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry metadata (0)", exact: true })).toBeDisabled();
  await list.getByRole("checkbox", { name: `Select ${syntheticWorkCode("RJ", 25)}`, exact: true }).click();
  await page.getByRole("searchbox", { name: "Search metadata", exact: true }).fill(syntheticWorkCode("RJ", 0));
  await page.getByRole("searchbox", { name: "Search metadata", exact: true }).press("Enter");
  await expect(list.getByRole("checkbox", { name: /^Select RJ/ })).toHaveCount(1);
  await expect(list.getByRole("link", { name: /Synthetic work 0/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry metadata (0)", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Previous page", exact: true }).first()).toBeDisabled();
});

function asMaintenanceWork(item: { workId: number; primaryCode: string; title: string }) {
  return {
    ...work,
    id: item.workId,
    primaryCode: item.primaryCode,
    title: item.title,
    noSource: false,
    metadataIssues: [item],
  };
}

test("work maintenance keeps source actions scoped and metadata settings separate", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "sources:write", "metadata:sync"],
  });
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: {
        fileSources: [],
        directoryRoutingRules: [],
        catalogFreshnessDays: 30,
        dlsiteMetadataLanguages: ["ja-jp"],
      },
    }),
  );
  const issue = {
    workId: 2,
    primaryCode: syntheticWorkCode("RJ", 1),
    title: "Example edition",
    providerCode: "dlsite",
    providerName: "DLsite",
    retrying: false,
    issues: [
      {
        component: "cover",
        status: "failed",
        failureCount: 1,
        firstFailedAt: "2026-01-01 00:00:00",
        checkedAt: "2026-01-01 00:00:00",
      },
    ],
  };
  const items = [
    {
      ...work,
      id: 1,
      primaryCode: syntheticWorkCode("RJ", 0),
      title: "Example mixed work",
      noSource: true,
      metadataIssues: [issue],
    },
    {
      ...work,
      id: 3,
      primaryCode: syntheticWorkCode("RJ", 2),
      title: "Example source-only work",
      noSource: true,
      metadataIssues: [],
    },
  ];
  await page.route("**/api/maintenance/works?*", async (route) => {
    const reason = new URL(route.request().url()).searchParams.get("reason");
    const works = items.filter((item) => reason !== "metadata" || item.metadataIssues.length > 0);
    await route.fulfill({ json: { works, page: 1, pageSize: 25, total: works.length } });
  });
  let retried: number[] = [];
  await page.route("**/api/metadata/issues/retry", async (route) => {
    retried = route.request().postDataJSON().workIds;
    await route.fulfill({ status: 202, json: { queued: retried.length, skipped: 0, failed: 0 } });
  });
  let checked: number[] = [];
  await page.route("**/api/maintenance/unlinked-works/source-check", async (route) => {
    checked = route.request().postDataJSON().workIds;
    await route.fulfill({ status: 202, json: { runId: 1, queued: checked.length } });
  });
  let deleted: number[] = [];
  await page.route("**/api/maintenance/unlinked-works/delete", async (route) => {
    deleted = route.request().postDataJSON().workIds;
    await route.fulfill({ json: { deletedFamilyCount: deleted.length, skipped: [] } });
  });
  await page.goto("/maintenance?tab=works");
  const list = page.getByRole("region", { name: "Metadata records", exact: true });
  await expect(page.getByRole("tab", { name: "Needs attention", exact: true })).toHaveAttribute(
    "aria-selected",
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
  await page.getByRole("tab", { name: "Metadata issues", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry metadata (0)", exact: true })).toBeDisabled();
  const row = list.getByRole("row").filter({ hasText: "Example mixed work" });
  await expect(row.getByText("No available source", { exact: true })).toBeVisible();
  await expect(row.getByText("Metadata issues", { exact: true })).toBeVisible();
  await row.getByText("Affected editions and providers (1)").click();
  await expect(row.getByRole("button", { name: `Retry ${syntheticWorkCode("RJ", 1)}`, exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "No available source", exact: true }).click();
  await list.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await list.getByRole("button", { name: "Delete local information", exact: true }).click();
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
  await expect(page.getByRole("tab", { name: "No available source", exact: true })).toHaveAttribute(
    "aria-selected",
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
    const records = [
      {
        ...work,
        id: 1,
        primaryCode: syntheticWorkCode("RJ", 0),
        title: "Example healthy work",
        noSource: false,
        metadataIssues: [],
      },
      {
        ...work,
        id: 2,
        primaryCode: syntheticWorkCode("RJ", 1),
        title: "Example missing-source work",
        noSource: true,
        metadataIssues: [],
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
      await route.fulfill({ json: { works, page: 1, pageSize: 25, total: works.length } });
    });
    await page.route("**/api/settings", (route) =>
      route.fulfill({ json: { fileSources: [], catalogFreshnessDays: 30, dlsiteMetadataLanguages: ["ja-jp"] } }),
    );
    await page.goto(viewport === "mobile" ? "/work-management" : "/metadata");
    await expect(page).toHaveURL(/\/metadata$/);
    await expect(page.getByRole("heading", { name: "Metadata", exact: true })).toBeVisible();
    const tabs = page.getByRole("tablist", { name: "Metadata views" });
    await expect(tabs.getByRole("tab")).toHaveText([
      "All",
      "Needs attention",
      "Metadata issues",
      "No available source",
      "Voice aliases",
    ]);
    await expect(tabs.getByRole("tab", { name: "All", exact: true })).toHaveAttribute("aria-selected", "true");
    const list = page.getByRole("region", { name: "Metadata records", exact: true });
    await expect(list.getByRole("link", { name: "Example healthy work", exact: true })).toBeVisible();
    expect(requests).toContain("catalog");
    await tabs.getByRole("tab", { name: "All", exact: true }).press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: "Needs attention", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(list.getByRole("link", { name: "Example healthy work", exact: true })).toHaveCount(0);
    await expect(list.getByRole("link", { name: "Example missing-source work", exact: true })).toBeVisible();
    // Five tabs leave no room for an inline field at these widths, so search starts behind its icon.
    const searchToggle = page.getByRole("button", { name: "Search metadata", exact: true });
    await expect(searchToggle).toHaveAttribute("aria-expanded", "false");
    await searchToggle.click();
    await expect(page.getByRole("searchbox", { name: "Search metadata", exact: true })).toBeFocused();
    await page.getByRole("searchbox", { name: "Search metadata", exact: true }).fill("Example");
    await page.getByRole("searchbox", { name: "Search metadata", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Metadata settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Metadata settings", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("spinbutton", { name: "Catalog freshness days", exact: true })).toHaveValue("30");
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Needs attention", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("searchbox", { name: "Search metadata", exact: true })).toHaveValue("Example");
    await page.screenshot({ path: testInfo.outputPath("metadata-management.png") });
    await expect(page.getByRole("button", { name: "Metadata sync", exact: true })).toHaveCount(0);
  });
}

test("@desktop Metadata voice aliases view lists people and opens alias review", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "metadata:sync"],
  });
  const voice = {
    personId: 7,
    displayName: "Example Voice",
    aliases: ["Example Voice", "Voice alias"],
    knownWorks: 3,
    localWorks: 1,
    remoteWorks: 1,
    cachedWorks: 0,
    playableWorks: 1,
    lastSeenAt: null,
    lastSyncedAt: null,
    syncState: "synced",
    syncReason: "",
    rating: null,
    note: "",
    favorite: false,
    userTags: [],
    sourceSummaries: [],
    latestWork: null,
  };
  await page.route("**/api/voices?*", (route) =>
    route.fulfill({ json: { voices: [voice], page: 1, pageSize: 25, total: 1, tagOptions: [] } }),
  );
  await page.route("**/api/voices/7?*", (route) =>
    route.fulfill({
      json: {
        ...voice,
        aliasRecords: [
          { id: 1, alias: "Example Voice", source: "primary_name", createdAt: "2026-07-01T00:00:00Z" },
          { id: 2, alias: "Voice alias", source: "manual", createdAt: "2026-07-01T00:00:00Z" },
        ],
        works: [],
        remoteMatches: [],
      },
    }),
  );
  await page.route("**/api/voices/7/merges", (route) => route.fulfill({ json: [] }));

  await page.goto("/metadata?view=aliases");
  const tabs = page.getByRole("tablist", { name: "Metadata views" });
  await expect(tabs.getByRole("tab", { name: "Voice aliases", exact: true })).toHaveAttribute("aria-selected", "true");
  const region = page.getByRole("region", { name: "Voice actor aliases", exact: true });
  await expect(region.getByRole("link", { name: "Example Voice", exact: true })).toBeVisible();
  await expect(region.getByText("Voice alias", { exact: true })).toBeVisible();

  await region.getByRole("button", { name: "Manage aliases for Example Voice" }).click();
  const dialog = page.getByRole("dialog", { name: "Example Voice" });
  await expect(dialog.getByPlaceholder("Add alias or search duplicate voice actor")).toBeVisible();
  await expect(dialog.getByText("Voice alias", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/view=aliases&voice=7$/);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/metadata\?view=aliases$/);

  await tabs.getByRole("tab", { name: "All", exact: true }).click();
  await expect(page).toHaveURL(/\/metadata\?reason=catalog$/);
  await expect(page.getByRole("region", { name: "Metadata records", exact: true })).toBeVisible();
});
