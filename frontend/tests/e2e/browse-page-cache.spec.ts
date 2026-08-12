import { expect, test, type Page } from "@playwright/test";

const emptyCollection = { works: [], page: 1, pageSize: 24, total: 0 };

async function mockBrowsePages(page: Page, requests: Record<string, number>) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const count = (key: string) => {
      requests[key] = (requests[key] ?? 0) + 1;
    };
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: {
          authenticated: true,
          user: {
            id: 1,
            username: "listener",
            displayName: "Listener",
            role: "user",
            permissions: ["library:read", "favorites:write"],
            devMode: true,
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: { mode: "development", cacheEnabled: false, directoryRoutingRules: [] } });
      return;
    }
    if (url.pathname === "/api/app-update") {
      await route.fulfill({
        json: {
          currentVersion: "v0.4.1",
          latestVersion: "v0.4.1",
          updateAvailable: false,
          releaseUrl: "",
          checkedAt: "2026-01-01T00:00:00Z",
        },
      });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      count("library-sources");
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/recently-played-works") {
      count("recently-played");
      await route.fulfill({ json: { works: [] } });
      return;
    }
    if (url.pathname === "/api/works") {
      count("works");
      await route.fulfill({ json: emptyCollection });
      return;
    }
    if (url.pathname === "/api/circles") {
      count("circles");
      await route.fulfill({
        json: { circles: [], page: 1, pageSize: 24, total: 0, catalogWorks: 0, availableWorks: 0 },
      });
      return;
    }
    if (url.pathname === "/api/voices") {
      count("voices");
      await route.fulfill({ json: { voices: [], page: 1, pageSize: 24, total: 0, tagOptions: [] } });
      return;
    }
    if (url.pathname === "/api/favorite-lists") {
      count("favorite-lists");
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/favorite-works") {
      count("favorite-works");
      await route.fulfill({ json: { ...emptyCollection, shelfTotal: 0, listCounts: {}, statusCounts: {} } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${url.pathname}` } });
  });
}

test("keeps visited browse workspaces mounted for the current user and server", async ({ page }) => {
  const requests: Record<string, number> = {};
  await mockBrowsePages(page, requests);
  await page.goto("/");
  await expect.poll(() => (requests.works ?? 0) > 0).toBe(true);

  await page.getByRole("button", { name: "Circles", exact: true }).click();
  await expect.poll(() => (requests.circles ?? 0) > 0).toBe(true);
  await expect(page).toHaveURL(/\/circles(?:\?|$)/);
  await page.getByRole("button", { name: "Voice Actors", exact: true }).click();
  await expect.poll(() => (requests.voices ?? 0) > 0).toBe(true);
  await expect(page).toHaveURL(/\/voices(?:\?|$)/);
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect.poll(() => (requests["favorite-works"] ?? 0) > 0).toBe(true);
  await expect(page).toHaveURL(/\/favorites(?:\?|$)/);

  const initialRequests = { ...requests };

  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Circles", exact: true }).click();
  await page.getByRole("button", { name: "Voice Actors", exact: true }).click();
  await page.getByRole("button", { name: "Favorites", exact: true }).click();

  expect(requests).toMatchObject({
    works: initialRequests.works,
    circles: initialRequests.circles,
    voices: initialRequests.voices,
    "favorite-works": initialRequests["favorite-works"],
  });
});
