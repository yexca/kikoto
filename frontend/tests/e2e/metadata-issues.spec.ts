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
  const list = page.getByRole("region", { name: "Work maintenance" });
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
  await list.getByRole("button", { name: "Retry metadata (1)", exact: true }).click();
  expect(retries).toEqual([[1]]);
  await expect(
    list.getByRole("checkbox", { name: `Select ${syntheticWorkCode("RJ", 0)}`, exact: true }),
  ).toBeDisabled();
  await expect(list.getByText("Retry queued or running")).toBeVisible();
  failList = true;
  await list.getByRole("button", { name: "Refresh list", exact: true }).click();
  await expect(list.getByRole("alert")).toBeVisible();
  await expect(list.getByRole("link", { name: /Synthetic work 0/ })).toBeVisible();
  failList = false;
  items = items.filter((item) => item.workId !== 1);
  await list.getByRole("button", { name: "Refresh list", exact: true }).click();
  await expect(list.getByRole("link", { name: /Synthetic work 0/ })).toHaveCount(0);
  await expect(list.getByText("1-1 of 1", { exact: true })).toBeVisible();
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
  const list = page.getByRole("region", { name: "Work maintenance" });
  await list.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await expect(list.getByRole("button", { name: "Retry metadata (25)", exact: true })).toBeEnabled();
  await list.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(list.getByRole("link", { name: /Synthetic work 25/ })).toBeVisible();
  await expect(list.getByRole("button", { name: "Retry metadata (0)", exact: true })).toBeDisabled();
  await list.getByRole("checkbox", { name: `Select ${syntheticWorkCode("RJ", 25)}`, exact: true }).click();
  await list
    .getByRole("searchbox", { name: "Search works needing attention", exact: true })
    .fill(syntheticWorkCode("RJ", 0));
  await list.getByRole("button", { name: "Search", exact: true }).click();
  await expect(list.getByRole("checkbox", { name: /^Select RJ/ })).toHaveCount(1);
  await expect(list.getByRole("link", { name: /Synthetic work 0/ })).toBeVisible();
  await expect(list.getByRole("button", { name: "Retry metadata (0)", exact: true })).toBeDisabled();
  await expect(list.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
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
  const list = page.getByRole("region", { name: "Work maintenance", exact: true });
  await expect(list.getByRole("combobox", { name: "Attention reason" })).toHaveValue("all");
  await expect(list.getByRole("button", { name: /Delete local information/ })).toHaveCount(0);
  await list.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await expect(list.getByRole("button", { name: "Retry metadata (1)", exact: true })).toBeEnabled();
  await list.getByRole("button", { name: "Retry metadata (1)", exact: true }).click();
  expect(retried).toEqual([2]);
  await list.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await list.getByRole("button", { name: "Check sources (2)", exact: true }).click();
  expect(checked).toEqual([1, 3]);
  await list.getByRole("combobox", { name: "Attention reason" }).selectOption("metadata");
  await expect(list.getByRole("button", { name: "Retry metadata (0)", exact: true })).toBeDisabled();
  const row = list.getByRole("row").filter({ hasText: "Example mixed work" });
  await expect(row.getByText("No available source", { exact: true })).toBeVisible();
  await expect(row.getByText("Metadata issues", { exact: true })).toBeVisible();
  await row.getByText("Affected editions and providers (1)").click();
  await expect(row.getByRole("button", { name: `Retry ${syntheticWorkCode("RJ", 1)}`, exact: true })).toBeEnabled();
  await list.getByRole("combobox", { name: "Attention reason" }).selectOption("no_source");
  await list.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await list.getByRole("button", { name: "Delete local information", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete local work information?" });
  await expect(dialog).toBeVisible();
  expect(deleted).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.keyboard.press("Control+Home");
  await page.getByRole("tab", { name: "Metadata settings", exact: true }).click();
  await expect(list).toHaveCount(0);
  await expect(page).toHaveURL(/tab=settings/);
});
