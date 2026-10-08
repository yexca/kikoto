import { expect, test } from "@playwright/test";
import type { PlaybackReport } from "../../src/lib/playbackReportApi";
import { mockApplication, persistedTrack, seedPlayer, silentWav } from "./fixtures/player-library";
import { playbackReportResultFixture, readPlaybackReportOutbox as readOutbox } from "./fixtures/playback-reports";

test("refresh restores unconfirmed listening and progress, confirms once, and keeps navigation playback", async ({
  page,
}) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await seedPlayer(page, persistedTrack, 1);
  const wav = silentWav(180);
  await page.route(/\/api\/media\/1\/stream(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: "audio/wav", body: wav }),
  );
  let failing = false;
  const reports: PlaybackReport[] = [];
  await page.route("**/api/playback-reports", (route) => {
    const report = route.request().postDataJSON() as PlaybackReport;
    reports.push(report);
    return failing ? route.abort("failed") : route.fulfill({ json: playbackReportResultFixture(report) });
  });
  await page.goto("/");
  await expect.poll(async () => (await readOutbox(page))?.generation).toBe(0);
  await page.getByText("Test track", { exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("audio")).toHaveJSProperty("paused", false);
  await expect
    .poll(async () => (await readOutbox(page))?.history[0]?.report.listenedSeconds ?? 0)
    .toBeGreaterThanOrEqual(1);
  // Restoring the initial cursor may produce a seek checkpoint. Fail subsequent
  // requests only after the listener starts, so the test covers durable recovery.
  failing = true;
  const requestsBeforePause = reports.length;
  // Navigation exercises the actual global player element, without remounting it.
  await page.getByRole("button", { name: "Collapse player", exact: true }).click();
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(page.locator("audio")).toHaveJSProperty("paused", false);
  await page.evaluate(() => document.querySelector("audio")!.pause());
  await expect.poll(() => reports.length).toBeGreaterThan(requestsBeforePause);
  await expect.poll(async () => (await readOutbox(page))?.history.length).toBe(1);
  const pending = reports[reports.length - 1];
  expect(pending.progress).toHaveLength(1);
  expect(pending.history).toHaveLength(1);
  failing = false;
  const requestsBeforeReload = reports.length;
  await page.reload();
  await expect.poll(() => reports.length).toBeGreaterThan(requestsBeforeReload);
  await expect.poll(async () => (await readOutbox(page))?.history.length).toBe(0);
  expect(reports[reports.length - 1].history[0].sessionId).toBe(pending.history[0].sessionId);
  expect(reports[reports.length - 1].history[0].listenedSeconds).toBe(pending.history[0].listenedSeconds);
  await expect.poll(async () => (await readOutbox(page))?.progress.length).toBe(0);
  const confirmedRequests = reports.length;
  await page.reload();
  await expect(page.getByRole("button", { name: "Account menu", exact: true })).toBeVisible();
  expect(reports).toHaveLength(confirmedRequests);
});

test("recovery validates history generation before sending old history", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await seedPlayer(page, persistedTrack, 1);
  await page.goto("/");
  await expect.poll(async () => (await readOutbox(page))?.generation).toBe(0);
  await page.evaluate(async () => {
    const request = indexedDB.open("kikoto-playback-reports", 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("outbox", "readwrite");
      const state = {
        version: 1,
        generation: 0,
        order: 1000,
        failures: 0,
        retryAt: 0,
        history: [
          {
            report: {
              generation: 0,
              sessionId: "synthetic-offline-session",
              workId: 1,
              listenedSeconds: 30,
              startedAt: "2026-01-01T00:00:00Z",
              lastListenedAt: "2026-01-01T00:00:30Z",
              days: [{ day: "2026-01-01", listenedSeconds: 30 }],
            },
          },
        ],
        progress: [
          {
            workId: 1,
            report: {
              reportId: "synthetic-offline-progress",
              order: 1000,
              mediaItemId: 1,
              locationId: 1,
              positionSeconds: 20,
              durationSeconds: 180,
              completed: false,
            },
          },
        ],
      };
      const store = tx.objectStore("outbox");
      store.put(state, `${encodeURIComponent(location.origin)}:user-1`);
      store.put(state, `${encodeURIComponent(location.origin)}:user-2`);
      store.put(state, `${encodeURIComponent("https://server.example.invalid")}:user-1`);
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  await page.route("**/api/listening-sessions", (route) => route.fulfill({ json: { generation: 1 } }));
  const reports: PlaybackReport[] = [];
  await page.route("**/api/playback-reports", (route) => {
    const report = route.request().postDataJSON() as PlaybackReport;
    reports.push(report);
    return route.fulfill({ json: playbackReportResultFixture(report, 1) });
  });
  await page.reload();
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0].history).toEqual([]);
  expect(reports[0].progress[0].positionSeconds).toBe(20);
  await expect.poll(async () => (await readOutbox(page))?.history.length).toBe(0);
  expect(
    await page.evaluate(async () => {
      const request = indexedDB.open("kikoto-playback-reports", 1);
      const db = await new Promise<IDBDatabase>((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      const records = await new Promise<{ history: unknown[]; progress: unknown[] }[]>((resolve) => {
        const request = db.transaction("outbox").objectStore("outbox").getAll();
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return records.filter((record) => record.history.length === 1 && record.progress.length === 1).length;
    }),
  ).toBe(2);
});
