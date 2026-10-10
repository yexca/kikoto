import { expect, test } from "@playwright/test";

import {
  authenticatedStateFixture,
  remoteWorkFixture,
  remoteWorksResponseFixture,
  runtimeSettingsFixture,
} from "./fixtures/api";
import { mockRemoteSource } from "./fixtures/player-library";
import { syntheticWorkCode } from "../../src/test-support/workCode";

test("remote recommendation toggle scores the page in one batch without reloading the source", async ({ page }) => {
  const browseRequests: URL[] = [];
  const scoreRequests: Array<{
    recommendationSession: string;
    works: Array<{ primaryCode: string; workId: number | null }>;
  }> = [];
  const works = [
    remoteWorkFixture({ primaryCode: syntheticWorkCode("RJ", 1), title: "Example Known Work", workId: 1 }),
    remoteWorkFixture({ remoteId: "2", primaryCode: syntheticWorkCode("RJ", 2), title: "Example Remote Work" }),
  ];
  await mockRemoteSource(page, () => undefined);
  await page.route("**/api/remote-sources/1/works?*", async (route) => {
    browseRequests.push(new URL(route.request().url()));
    await route.fulfill({ json: remoteWorksResponseFixture(works) });
  });
  await page.route("**/api/remote-sources/1/recommendations", async (route) => {
    scoreRequests.push(route.request().postDataJSON());
    await route.fulfill({
      // The second score sits below the default highlight threshold of 50.
      json: { scores: works.map((work, index) => ({ primaryCode: work.primaryCode, score: [65, 20][index] })) },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await expect(page.getByText("Example Remote Work", { exact: true })).toBeVisible();
  expect(scoreRequests).toHaveLength(0);
  const initialBrowseCount = browseRequests.length;
  await page.getByRole("button", { name: "Show recommendation badges", exact: true }).click();
  const badges = page.getByLabel("Recommended for you", { exact: true });
  await expect(badges).toHaveCount(2);
  await expect(badges.nth(0)).toHaveText("65");
  await expect(badges.nth(1)).toHaveText("20");
  expect(scoreRequests).toHaveLength(1);
  expect(scoreRequests[0].recommendationSession).toBeTruthy();
  expect(scoreRequests[0].works.map(({ workId }) => workId)).toEqual([1, null]);
  expect(browseRequests).toHaveLength(initialBrowseCount);
  // Progressive presentation and reduced-motion behavior are explicit UI contracts.
  await expect(badges.nth(1)).toHaveCSS("animation-delay", "0.04s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(badges.nth(1)).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "Hide recommendation badges", exact: true }).click();
  await expect(badges).toHaveCount(0);
  expect(browseRequests).toHaveLength(initialBrowseCount);
});

test("remote recommendation failure keeps cards and retries only scoring", async ({ page }) => {
  const requests: URL[] = [];
  let attempts = 0;
  await mockRemoteSource(page, (url) => requests.push(url));
  await page.route("**/api/remote-sources/1/recommendations", async (route) => {
    attempts++;
    if (attempts === 1) {
      await route.fulfill({ status: 503, json: { error: "temporarily unavailable" } });
      return;
    }
    const request = route.request().postDataJSON() as { works: Array<{ primaryCode: string }> };
    await route.fulfill({ json: { scores: request.works.map(({ primaryCode }) => ({ primaryCode, score: 65 })) } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  const browseCount = requests.length;
  await page.getByRole("button", { name: "Show recommendation badges", exact: true }).click();
  await page.getByRole("status").getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByLabel("Recommended for you", { exact: true })).toHaveText("65");
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  expect(attempts).toBe(2);
  expect(requests).toHaveLength(browseCount);
});

test("remote recommendation response cannot restore badges after disabling them", async ({ page }) => {
  let releaseResponse!: () => void;
  const pending = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let started = false;
  await mockRemoteSource(page, () => undefined);
  await page.route("**/api/remote-sources/1/recommendations", async (route) => {
    started = true;
    const request = route.request().postDataJSON() as { works: Array<{ primaryCode: string }> };
    await pending;
    await route
      .fulfill({ json: { scores: request.works.map(({ primaryCode }) => ({ primaryCode, score: 65 })) } })
      .catch(() => undefined);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show recommendation badges", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page.getByRole("button", { name: "Hide recommendation badges", exact: true }).click();
  releaseResponse();
  await expect(page.getByLabel("Recommended for you", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
});

test("demo remote badges reuse the local score session on browse and retry", async ({ page }) => {
  await mockRemoteSource(page, () => undefined);
  await page.route("**/api/runtime-settings", (route) =>
    route.fulfill({ json: runtimeSettingsFixture({ mode: "demo", demoMode: true }) }),
  );
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: authenticatedStateFixture({ demoMode: true }) }));
  const localRequests: URL[] = [];
  await page.route("**/api/works?**", async (route) => {
    localRequests.push(new URL(route.request().url()));
    await route.fallback();
  });
  const requests: URL[] = [];
  let failNextBrowse = false;
  await page.route("**/api/remote-sources/1/works?*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (failNextBrowse) {
      failNextBrowse = false;
      await route.fulfill({
        json: remoteWorksResponseFixture([], {
          status: "unavailable",
          error: { code: "unavailable", message: "Source temporarily unavailable", retryable: true },
        }),
      });
      return;
    }
    await route.fulfill({
      json: remoteWorksResponseFixture([
        remoteWorkFixture({
          title: "Example Demo Work",
          recommendScore: url.searchParams.get("recommendBadges") === "true" ? 72 : 0,
        }),
      ]),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await expect(page.getByText("Example Demo Work", { exact: true })).toBeVisible();
  const session = localRequests.at(-1)?.searchParams.get("recommendationSession");
  expect(session).toBeTruthy();
  expect(requests.at(-1)?.searchParams.get("recommendationSession")).toBe(session);
  await page.getByRole("button", { name: "Show recommendation badges", exact: true }).click();
  await expect(page.getByLabel("Recommended for you", { exact: true })).toHaveText("72");
  expect(requests.at(-1)?.searchParams.get("recommendationSession")).toBe(session);
  failNextBrowse = true;
  await page.getByRole("button", { name: /^Sort:/ }).click();
  await page.getByRole("button", { name: "Ascending", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("Example Demo Work", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Recommended for you", { exact: true })).toHaveText("72");
  expect(requests.at(-1)?.searchParams.get("recommendationSession")).toBe(session);
});
