import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { LibrarySource, RecentlyPlayedWorksResponse } from "../../src/lib/api";
import {
  anonymousAuthState,
  appUpdateFixture,
  authenticatedStateFixture,
  runtimeSettingsFixture,
  worksPageFixture,
  type ApiErrorBody,
} from "./fixtures/api";

const appVersion = readFileSync(resolve(__dirname, "../../../VERSION"), "utf8").trim();

async function mockAppShell(page: Page, anonymousAccessEnabled = true, onLibraryRequest: () => void = () => undefined) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: anonymousAuthState });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: runtimeSettingsFixture({ mode: "production", anonymousAccessEnabled }) });
      return;
    }
    if (url.pathname === "/api/app-update") {
      await route.fulfill({ json: appUpdateFixture(appVersion) });
      return;
    }
    if (url.pathname === "/api/works") {
      onLibraryRequest();
      await route.fulfill({ json: worksPageFixture([]) });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({ json: [] satisfies LibrarySource[] });
      return;
    }
    if (url.pathname === "/api/recently-played-works") {
      await route.fulfill({ json: { works: [] } satisfies RecentlyPlayedWorksResponse });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not mocked" } satisfies ApiErrorBody });
  });
}

test("@smoke requires sign-in before mounting the library when anonymous access is off", async ({ page }) => {
  let libraryRequests = 0;
  await mockAppShell(page, false, () => {
    libraryRequests += 1;
  });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Sign in to Kikoto", exact: true })).toBeVisible();
  await expect(page.locator("footer").getByRole("button", { name: "Library", exact: true })).toHaveCount(0);
  expect(libraryRequests).toBe(0);
});

test("a server outage at startup offers a retry instead of the sign-in page", async ({ page }) => {
  await mockAppShell(page, false);
  let serverDown = true;
  await page.route("**/api/auth/me", async (route) => {
    if (!serverDown) {
      await route.fulfill({ json: authenticatedStateFixture() });
      return;
    }
    await route.fulfill({ status: 503, json: { error: "Service unavailable" } satisfies ApiErrorBody });
  });
  await page.goto("/");

  const notice = page.getByRole("alert");
  await expect(notice.getByRole("heading", { name: "Can't reach Kikoto" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to Kikoto", exact: true })).toHaveCount(0);

  serverDown = false;
  await notice.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator("footer").getByRole("button", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to Kikoto", exact: true })).toHaveCount(0);
});

test("@smoke renders the anonymous library shell", async ({ page }) => {
  await mockAppShell(page);
  await page.goto("/");

  await expect(page.locator("footer").getByRole("button", { name: "Library", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open appearance settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const accountSheet = page.getByRole("dialog", { name: "Account" });
  await expect(accountSheet).toBeVisible();
  await expect(accountSheet.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  // Anonymous visitors choose the UI language here but have no personal metadata language.
  await expect(accountSheet.getByRole("combobox", { name: "UI language" })).toBeVisible();
  await expect(accountSheet.getByRole("combobox", { name: "Preferred metadata language" })).toHaveCount(0);
});

test("@smoke opens About without an update icon when current", async ({ page }) => {
  await mockAppShell(page);
  await page.goto("/about");

  await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
  const identity = page.getByRole("region", { name: "About Kikoto", exact: true });
  await expect(identity.getByText(appVersion, { exact: true })).toBeVisible();
  await expect(identity.getByRole("link", { name: /Update available/ })).toHaveCount(0);
});
