import { expect, test } from "@playwright/test";
import { mockApplication, seedPlayer, persistedTrack, silentWav } from "./fixtures/player-library";
import { authenticatedStateFixture } from "./fixtures/api";
import { playbackReportResultFixture } from "./fixtures/playback-reports";
import type { PlaybackReport } from "../../src/lib/playbackReportApi";

test("mobile collapse button responds to a tap", async ({ page }) => {
  await mockApplication(page);
  await seedPlayer(page);
  await page.goto("/");
  await page.getByText("Test track", { exact: true }).click();
  await expect(page.getByRole("region", { name: "Now playing", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Collapse player", exact: true }).tap();
  await expect(page.getByRole("region", { name: "Now playing", exact: true })).toHaveCount(0);
});

test("compact layout collapse button responds to a mouse click @desktop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApplication(page);
  await seedPlayer(page);
  await page.goto("/");
  await page.getByText("Test track", { exact: true }).click();
  await page.getByRole("button", { name: "Collapse player", exact: true }).click();
  await expect(page.getByRole("region", { name: "Now playing", exact: true })).toHaveCount(0);
});

for (const result of ["success", "database_busy", "logout_failure"] as const) {
  const title =
    result === "logout_failure"
      ? "playback saves resume when a failed sign-out confirms the same account"
      : `queued playback saves stop on sign-out after a ${result} response`;
  test(title, async ({ page }) => {
    await mockApplication(page, undefined, false, 1, 0, [], undefined, {
      authenticated: true,
    });
    await seedPlayer(page, persistedTrack, 1);
    await seedPlayer(page, { ...persistedTrack, title: "Example B track" }, 2);
    let owner: number | null = 1;
    let authReads = 0;
    let historyLookups = 0;
    if (result === "logout_failure") {
      await page.route("**/api/listening-sessions", (route) => {
        if (route.request().method() === "GET") {
          historyLookups += 1;
          return route.fulfill({ json: { generation: 0 } });
        }
        return route.fulfill({ json: { recorded: true } });
      });
    }
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalLeak!: () => void;
    const leaked = new Promise<boolean>((resolve) => {
      signalLeak = () => resolve(true);
    });
    const saves: { owner: number | null; position: number }[] = [];
    await page.route("**/api/auth/me", (route) => {
      authReads += 1;
      return route.fulfill({
        json:
          owner === null
            ? { authenticated: false }
            : authenticatedStateFixture({
                id: owner,
                username: `synthetic-user-${owner}`,
                devMode: false,
                permissions: ["library:read", "playback:use", "favorites:write"],
              }),
      });
    });
    await page.route("**/api/auth/logout", async (route) => {
      if (result === "logout_failure") {
        await route.fulfill({ status: 503, json: { error: "Sign-out unavailable", retryable: true } });
        return;
      }
      owner = null;
      await route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/auth/login", async (route) => {
      owner = 2;
      await route.fulfill({
        json: authenticatedStateFixture({
          id: 2,
          username: "synthetic-user-2",
          devMode: false,
          permissions: ["library:read", "playback:use", "favorites:write"],
        }),
      });
    });
    const wav = silentWav(180);
    await page.route(/\/api\/media\/1\/stream(?:\?.*)?$/, (route) => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      return route.fulfill({
        status: range ? 206 : 200,
        contentType: "audio/wav",
        headers: {
          "Accept-Ranges": "bytes",
          ...(range ? { "Content-Range": `bytes ${start}-${end}/${wav.length}` } : {}),
        },
        body: wav.subarray(start, end + 1),
      });
    });
    await page.route("**/api/playback-reports", async (route) => {
      const report = route.request().postDataJSON() as PlaybackReport;
      const body = report.progress[0];
      if (!body) {
        await route.fulfill({ json: playbackReportResultFixture(report) });
        return;
      }
      saves.push({ owner, position: body.positionSeconds });
      if (owner === 2) signalLeak();
      if (saves.length === 1) await firstReleased;
      if (result === "database_busy" && saves.length === 1) {
        await route.fulfill({
          status: 503,
          json: { error: "Database busy", code: "database_busy", retryable: true },
        });
        return;
      }
      await route.fulfill({
        json: playbackReportResultFixture(report),
      });
    });
    try {
      await page.goto("/");
      await page.getByText("Test track", { exact: true }).click();
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect(page.locator("audio")).toHaveJSProperty("paused", false);
      const checkpoint = async (position: number) => {
        await page.evaluate((position) => {
          document.querySelector("audio")!.currentTime = position;
        }, position);
        await expect
          .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => Math.floor(audio.currentTime)))
          .toBe(position);
        await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      };
      await checkpoint(20);
      await expect.poll(() => saves.length).toBe(1);
      await checkpoint(30);
      await page.getByRole("button", { name: "Collapse player", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("region", { name: "Now playing", exact: true })).toHaveCount(0);
      const beforeAuthReads = authReads;
      await page.getByRole("button", { name: "Account menu", exact: true }).click();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      if (result === "logout_failure") {
        await expect.poll(() => authReads).toBeGreaterThan(beforeAuthReads);
        await expect.poll(() => historyLookups).toBeGreaterThan(1);
        releaseFirst();
        await checkpoint(40);
        await expect.poll(() => saves.some((save) => save.owner === 1 && save.position >= 40)).toBe(true);
        expect(saves.every((save) => save.owner === 1)).toBe(true);
        await expect(page.locator("audio")).toHaveJSProperty("paused", false);
        return;
      }
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Account", exact: true })
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await page.getByLabel("Username", { exact: true }).fill("synthetic-user-2");
      await page.getByLabel("Password", { exact: true }).fill("synthetic-password");
      await page.getByLabel("Password", { exact: true }).press("Enter");
      await expect(page.getByRole("button", { name: "Account menu", exact: true })).toBeVisible();
      await expect(page.getByText("Test track", { exact: true })).toHaveCount(0);
      releaseFirst();
      const sentUnderNewOwner = await Promise.race([
        leaked,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
      ]);
      // Observe beyond the bounded busy-retry delay: neither a queued write nor
      // a retry may start with the new session.
      expect(saves, "old player's queued requests must not use the next account's session").toEqual([
        { owner: 1, position: saves[0].position },
      ]);
      expect(sentUnderNewOwner).toBe(false);
      await page.getByText("Example B track", { exact: true }).click();
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect(page.locator("audio")).toHaveJSProperty("paused", false);
      await checkpoint(40);
      await expect.poll(() => saves.some((save) => save.owner === 2 && save.position >= 40)).toBe(true);
    } finally {
      releaseFirst();
    }
  });
}
