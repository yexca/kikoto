import { expect, test, type Page } from "@playwright/test";

import { syntheticWorkCode } from "../../src/test-support/workCode";

type ManagedTag = { id: number; name: string; color: string; usageCount: number };

type PersonalDataMock = {
  tagRequests: URL[];
  mergeRequests: Array<{ url: URL; body: unknown }>;
  previewBodies: Array<Record<string, unknown>>;
  importBodies: Array<Record<string, unknown>>;
};

const exportFile = {
  format: "kikoto-user-data",
  version: 1,
  works: [
    { primaryCode: syntheticWorkCode("RJ", 1), listeningStatus: "finished" },
    { primaryCode: syntheticWorkCode("RJ", 2), listeningStatus: "listening" },
  ],
};

async function mockPersonalData(
  page: Page,
  options: { failFirstPreview?: boolean; permissions?: string[] } = {},
): Promise<PersonalDataMock> {
  const log: PersonalDataMock = { tagRequests: [], mergeRequests: [], previewBodies: [], importBodies: [] };
  let workTags: ManagedTag[] = [
    { id: 1, name: "Example Tag 1", color: "", usageCount: 4 },
    { id: 2, name: "Example Tag 2", color: "", usageCount: 2 },
    { id: 3, name: "Example Tag 3", color: "", usageCount: 0 },
  ];
  let previewFailures = options.failFirstPreview ? 1 : 0;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: {
          authenticated: true,
          user: {
            id: 1,
            username: "listener",
            displayName: "Listener",
            role: "user",
            permissions: options.permissions ?? ["library:read", "playback:use", "favorites:write", "tags:write"],
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
          cacheEnabled: false,
          directoryRoutingRules: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/user-tags" && request.method() === "GET") {
      log.tagRequests.push(url);
      const scope = url.searchParams.get("scope") ?? "work";
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      const tags = (
        scope === "work" ? workTags : [{ id: 21, name: "Example Circle Tag", color: "", usageCount: 1 }]
      ).filter((tag) => tag.name.toLowerCase().includes(query));
      await route.fulfill({ json: { scope, tags, total: tags.length, page: 1, pageSize: 50 } });
      return;
    }
    const mergeMatch = url.pathname.match(/^\/api\/user-tags\/(\d+)\/merge$/);
    if (mergeMatch && request.method() === "POST") {
      const body = request.postDataJSON() as { targetId: number };
      log.mergeRequests.push({ url, body });
      const source = workTags.find((tag) => tag.id === Number(mergeMatch[1]))!;
      workTags = workTags
        .filter((tag) => tag.id !== source.id)
        .map((tag) => (tag.id === body.targetId ? { ...tag, usageCount: tag.usageCount + source.usageCount } : tag));
      await route.fulfill({ json: workTags.find((tag) => tag.id === body.targetId) });
      return;
    }
    if (url.pathname === "/api/listening-statistics") {
      await route.fulfill({
        json: {
          listenedSeconds: 5_400,
          listenCount: 3,
          workCount: 1,
          activeDays: 2,
          daily: [],
          topWorks: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/listening-history") {
      await route.fulfill({
        json: {
          items: [
            {
              workId: 1,
              primaryCode: syntheticWorkCode("RJ", 1),
              title: "Example Work 1",
              listenedSeconds: 5_400,
              listenCount: 3,
              lastPlayedAt: "2026-01-02T00:00:00Z",
            },
          ],
          total: 1,
          page: 1,
          pageSize: 30,
        },
      });
      return;
    }
    if (url.pathname === "/api/user-data/import/preview") {
      const body = request.postDataJSON() as Record<string, unknown>;
      log.previewBodies.push(body);
      if (previewFailures > 0) {
        previewFailures -= 1;
        await route.fulfill({ status: 503, json: { error: "upstream detail /data/private", code: "unavailable" } });
        return;
      }
      await route.fulfill({
        json: {
          works: 2,
          playlists: 1,
          tags: 2,
          matchedWorks: 1,
          missingCodes: [syntheticWorkCode("RJ", 2)],
          conflicts: body.conflict === "overwrite" ? 1 : 0,
          unmatchedProgress: 1,
        },
      });
      return;
    }
    if (url.pathname === "/api/user-data/import") {
      log.importBodies.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({ json: { importedWorks: 1, skippedWorks: 1, playlists: 1, tags: 2, skippedProgress: 1 } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });
  return log;
}

test("mobile reaches personal pages from the account menu without adding bottom tabs", async ({ page }) => {
  await mockPersonalData(page);
  await page.goto("/about");

  const bottomNavigation = page.locator("footer nav");
  await expect(bottomNavigation.getByRole("button")).toHaveText(["Library", "Favorites", "Circles", "Voice Actors"]);

  await page.getByRole("button", { name: "Account menu" }).click();
  const account = page.getByRole("dialog", { name: "Account" });
  await account.getByRole("button", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  await expect(page.getByText("1 h 30 min").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Example Work 1/ })).toHaveAttribute(
    "href",
    `/${syntheticWorkCode("RJ", 1)}`,
  );

  await page.getByRole("button", { name: "Account menu" }).click();
  await account.getByRole("button", { name: "Tags", exact: true }).click();
  await expect(page).toHaveURL(/\/tags$/);
  await expect(page.getByRole("list", { name: "Personal tags" }).getByText("Unused")).toBeVisible();

  await page.getByRole("button", { name: "Account menu" }).click();
  await account.getByRole("button", { name: "Your data", exact: true }).click();
  await expect(page).toHaveURL(/\/user-data$/);
  await expect(page.getByRole("button", { name: "Download export" })).toBeVisible();
});

test("@desktop personal pages sit in their own sidebar group", async ({ page }) => {
  await mockPersonalData(page);
  await page.goto("/about");
  const sidebar = page.locator("aside nav");
  for (const name of ["History", "Tags", "Your data"]) {
    await expect(sidebar.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await sidebar.getByRole("button", { name: "Tags", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Tags", exact: true })).toHaveAttribute("aria-current", "page");
});

test("merging a tag into a selected existing tag updates the list", async ({ page }) => {
  const log = await mockPersonalData(page);
  await page.goto("/tags");

  const list = page.getByRole("list", { name: "Personal tags" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list.getByRole("listitem").filter({ hasText: "Example Tag 3" })).toContainText("Unused");

  await page.getByRole("button", { name: "Merge Example Tag 1" }).click();
  const dialog = page.getByRole("dialog", { name: "Merge “Example Tag 1”" });
  const merge = dialog.getByRole("button", { name: "Merge tags" });
  await expect(merge).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: /Example Tag 1/ })).toHaveCount(0);
  await dialog.getByRole("radio", { name: /Example Tag 2/ }).check();
  await merge.click();

  await expect(dialog).toHaveCount(0);
  expect(log.mergeRequests).toHaveLength(1);
  expect(log.mergeRequests[0].url.pathname).toBe("/api/user-tags/1/merge");
  expect(log.mergeRequests[0].url.searchParams.get("scope")).toBe("work");
  expect(log.mergeRequests[0].body).toEqual({ targetId: 2 });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").filter({ hasText: "Example Tag 2" })).toContainText("Used by 6");

  await page.getByRole("radio", { name: "Circles" }).click();
  await expect(list.getByText("Example Circle Tag")).toBeVisible();
  expect(log.tagRequests.at(-1)?.searchParams.get("scope")).toBe("circle");
});

test("a read-only account sees tags without rename, merge, or delete actions", async ({ page }) => {
  await mockPersonalData(page, { permissions: ["library:read", "playback:use"] });
  await page.goto("/tags");
  await expect(page.getByRole("list", { name: "Personal tags" }).getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("button", { name: /^Merge / })).toHaveCount(0);
  await expect(page.getByText("Your account can view this page but cannot change it.")).toBeVisible();
});

test("import previews the chosen file, recovers from a failed preview, and imports only on request", async ({
  page,
}) => {
  const log = await mockPersonalData(page, { failFirstPreview: true });
  await page.goto("/user-data");

  const importButton = page.getByRole("button", { name: "Import", exact: true });
  await expect(importButton).toBeDisabled();
  await page.getByLabel("JSON file").setInputFiles({
    name: "kikoto-user-data.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exportFile)),
  });

  const failure = page.getByRole("alert").filter({ hasText: "Preview failed" });
  await expect(failure).toBeVisible();
  await expect(failure).not.toContainText("/data/private");
  await expect(importButton).toBeDisabled();
  await failure.getByRole("button", { name: "Retry" }).click();

  const preview = page.getByRole("region", { name: "Preview" });
  await expect(preview).toContainText("Matched in library");
  await preview.getByText("Not in the library (1)").click();
  await expect(preview.getByText(syntheticWorkCode("RJ", 2))).toBeVisible();
  expect(log.previewBodies.at(-1)).toEqual({ format: "kikoto", data: exportFile, conflict: "keep" });
  expect(log.importBodies).toHaveLength(0);

  await page.getByRole("radio", { name: /Overwrite with imported/ }).check();
  await expect.poll(() => log.previewBodies.at(-1)?.conflict).toBe("overwrite");
  await expect(preview).toBeVisible();
  await expect(importButton).toBeEnabled();
  await importButton.click();

  await expect(page.getByRole("status").filter({ hasText: "Imported 1 works" }).first()).toBeVisible();
  expect(log.importBodies).toEqual([{ format: "kikoto", data: exportFile, conflict: "overwrite" }]);
  await expect(importButton).toBeDisabled();
});

test("an invalid file never reaches the server", async ({ page }) => {
  const log = await mockPersonalData(page);
  await page.goto("/user-data");
  await page.getByLabel("JSON file").setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from("{not json"),
  });
  await expect(page.getByText("The file is not valid JSON.")).toBeVisible();
  expect(log.previewBodies).toHaveLength(0);
});
