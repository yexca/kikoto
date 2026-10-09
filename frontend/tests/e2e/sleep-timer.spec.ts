import { expect, test, type Page, type Route } from "@playwright/test";

import {
  mockApplication,
  playerQueueStorageBaseKey,
  queuedTrackFixture,
  readScopedPlayerState,
  seedPlayerQueue,
  silentWav,
} from "./fixtures/player-library";
import { playbackReportResultFixture } from "./fixtures/playback-reports";
import type { PlaybackReport } from "../../src/lib/playbackReportApi";

type ProgressSave = { mediaItemId: number; positionSeconds: number; completed: boolean };

const trackSeconds = 180;

function serveSeekableAudio(route: Route, media: Buffer) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
  return route.fulfill({
    status: range ? 206 : 200,
    contentType: "audio/wav",
    headers: {
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${media.length}` } : {}),
    },
    body: media.subarray(start, end + 1),
  });
}

/**
 * A signed-in listener with a restored two-track queue whose first track
 * resumes at `cursorSeconds`, and a stored sleep rewind setting.
 */
async function openRestoredQueue(
  page: Page,
  options: { cursorSeconds: number; rewindMinutes?: number; mediaGate?: Promise<void> },
) {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  const first = {
    ...queuedTrackFixture(0, "Test track"),
    progress: {
      positionSeconds: options.cursorSeconds,
      durationSeconds: trackSeconds,
      completed: false,
      lastPlayedAt: "2026-01-01 00:00:00",
    },
  };
  await seedPlayerQueue(page, [first, queuedTrackFixture(1, "Second queued track")], 1);
  await page.addInitScript((minutes) => {
    const key = `kikoto:player-sleep-rewind:v1:${encodeURIComponent(window.location.origin)}:user-1`;
    localStorage.setItem(key, JSON.stringify({ version: 1, minutes }));
  }, options.rewindMinutes ?? 0);

  const media = silentWav(trackSeconds);
  await page.route(/\/api\/media\/[12]\/stream(?:\?.*)?$/, async (route) => {
    await options.mediaGate;
    await serveSeekableAudio(route, media);
  });
  const saves: ProgressSave[] = [];
  await page.route("**/api/playback-reports", async (route) => {
    const report = route.request().postDataJSON() as PlaybackReport;
    for (const body of report.progress) {
      saves.push({ mediaItemId: body.mediaItemId, positionSeconds: body.positionSeconds, completed: body.completed });
    }
    await route.fulfill({ json: playbackReportResultFixture(report) });
  });
  await page.goto("/");
  return saves;
}

const audioState = (page: Page) =>
  page.locator("audio").evaluate((element: HTMLAudioElement) => ({
    paused: element.paused,
    currentTime: element.currentTime,
    source: new URL(element.currentSrc || element.src, window.location.href).pathname,
  }));

async function startPlayback(page: Page, cursorSeconds: number) {
  await expect.poll(async () => Math.round((await audioState(page)).currentTime)).toBe(cursorSeconds);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).currentTime).toBeGreaterThan(cursorSeconds + 0.5);
}

async function setSleepTimer(page: Page, options: { finishCurrentTrack?: boolean } = {}) {
  await page.getByText("Test track", { exact: true }).click();
  await page.getByRole("button", { name: "Sleep timer" }).click();
  if (options.finishCurrentTrack) await page.getByRole("switch", { name: "Finish current track" }).check();
  await page.getByRole("button", { name: "30 min" }).click();
}

const lastSave = (saves: ProgressSave[]) => saves.filter((save) => save.mediaItemId === 1).at(-1);

test("an expired sleep timer pauses and keeps the rewound position as the resume cursor", async ({ page }) => {
  await page.clock.install();
  const saves = await openRestoredQueue(page, { cursorSeconds: 150, rewindMinutes: 1 });
  await startPlayback(page, 150);
  await setSleepTimer(page);

  const beforeExpiry = (await audioState(page)).currentTime;
  await page.clock.fastForward("30:00");

  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  const stopped = await audioState(page);
  expect(stopped.paused).toBe(true);
  expect(stopped.source).toBe("/api/media/1/stream");
  expect(stopped.currentTime).toBeGreaterThanOrEqual(beforeExpiry - 60);
  expect(stopped.currentTime).toBeLessThan(beforeExpiry - 58);
  await expect.poll(() => lastSave(saves)?.positionSeconds).toBeCloseTo(stopped.currentTime, 0);

  // Page hide checkpoints again; the paused, rewound element still owns the cursor.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(async () => (await audioState(page)).currentTime).toBeCloseTo(stopped.currentTime, 1);
  expect(lastSave(saves)).toMatchObject({ completed: false });
  expect(lastSave(saves)?.positionSeconds).toBeCloseTo(stopped.currentTime, 0);
  expect(saves.filter((save) => save.mediaItemId === 2)).toEqual([]);
});

test("a finish-current-track sleep timer rewinds at the track end instead of advancing", async ({ page }) => {
  await page.clock.install();
  const saves = await openRestoredQueue(page, { cursorSeconds: 172, rewindMinutes: 1 });
  await expect.poll(async () => Math.round((await audioState(page)).currentTime)).toBe(172);
  // Set while paused so the track cannot end before the timer exists.
  await setSleepTimer(page, { finishCurrentTrack: true });
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expect.poll(async () => (await audioState(page)).currentTime).toBeGreaterThan(172.5);
  await page.clock.fastForward("30:00");
  await expect
    .poll(async () => (await readScopedPlayerState(page, playerQueueStorageBaseKey, 1))?.sleepTimer?.waitingForTrackEnd)
    .toBe(true);

  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible({ timeout: 20_000 });
  const stopped = await audioState(page);
  expect(stopped.paused).toBe(true);
  expect(stopped.source).toBe("/api/media/1/stream");
  expect(stopped.currentTime).toBeCloseTo(trackSeconds - 60, 0);
  await expect.poll(() => lastSave(saves)?.positionSeconds).toBeCloseTo(trackSeconds - 60, 0);
  expect(saves.filter((save) => save.mediaItemId === 1 && save.completed)).toEqual([]);
  expect(saves.filter((save) => save.mediaItemId === 2)).toEqual([]);
  await expect(page.getByText("Second queued track", { exact: true })).toHaveCount(0);
});

test("a pause from outside the player, such as a headphone disconnect, becomes the listener's pause", async ({
  page,
}) => {
  const saves = await openRestoredQueue(page, { cursorSeconds: 60 });
  await startPlayback(page, 60);

  await page.locator("audio").evaluate((element: HTMLAudioElement) => element.pause());

  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  const paused = await audioState(page);
  await expect.poll(() => lastSave(saves)?.positionSeconds).toBeCloseTo(paused.currentTime, 0);
  // Re-rendering the player does not resume the element.
  await page.getByText("Test track", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true }).first()).toBeVisible();
  expect((await audioState(page)).paused).toBe(true);
});

test("a pause from outside the player cancels a play request still waiting for media", async ({ page }) => {
  let releaseMedia = () => {};
  const mediaGate = new Promise<void>((resolve) => {
    releaseMedia = resolve;
  });
  const saves = await openRestoredQueue(page, { cursorSeconds: 60, mediaGate });

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await page.locator("audio").evaluate((element: HTMLAudioElement) => element.pause());
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

  releaseMedia();
  await expect.poll(async () => Math.round((await audioState(page)).currentTime)).toBe(60);
  expect((await audioState(page)).paused).toBe(true);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  // Nothing was heard, so the resume cursor is not replaced.
  expect(saves.filter((save) => save.mediaItemId === 1)).toEqual([]);
});
