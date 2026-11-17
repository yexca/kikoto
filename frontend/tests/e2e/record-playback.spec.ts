import { expect, test, type Page, type Route } from "@playwright/test";

import type { RecordAsset, RecordProgress, RecordRoot, RecordTree, VideoPlaybackInfo } from "../../src/lib/api";
import { rolePermissions, runtimeSettingsFixture } from "./fixtures/api";
import { mockApplication, silentWav } from "./fixtures/player-library";

const savedProgress: RecordProgress = { positionSeconds: 60, durationSeconds: 180, completed: false };

const clip: RecordAsset = {
  id: 1,
  folderId: 0,
  name: "Example clip.mp4",
  relativePath: "Example clip.mp4",
  kind: "video",
  mimeType: "video/mp4",
  durationSeconds: 180,
  availability: "available",
  streamUrl: "/api/records/assets/1/stream",
  downloadUrl: "/api/records/assets/1/download",
  progress: savedProgress,
};

const episode: RecordAsset = {
  id: 2,
  folderId: 0,
  name: "Episode 1.wav",
  relativePath: "Episode 1.wav",
  kind: "audio",
  mimeType: "audio/wav",
  durationSeconds: 180,
  availability: "available",
  streamUrl: "/api/records/assets/2/stream",
  // The file embeds cover art.
  thumbnailUrl: "/api/records/assets/2/thumbnail?v=1",
  progress: { positionSeconds: 30, durationSeconds: 180, completed: false },
};

// A 1×1 PNG.
const coverImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function mockRecordLibrary(page: Page) {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    // Saving Record progress takes library write access.
    permissions: rolePermissions.admin,
  });
  await page.route("**/api/runtime-settings", (route) =>
    route.fulfill({ json: { ...runtimeSettingsFixture(), recordLibraryEnabled: true } }),
  );
  const media = silentWav(180);
  const serveMedia = (route: Route) => {
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
  };
  const playbackRequests: URL[] = [];
  const savedPositions: RecordProgress[] = [];
  const savedAudioPositions: RecordProgress[] = [];
  await page.route("**/api/records**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/records") {
      const root: RecordRoot = {
        id: 1,
        displayName: "Record",
        state: "online",
        lastScannedAt: "2026-01-01T00:00:00Z",
        scanGeneration: 1,
      };
      return route.fulfill({ json: { root } });
    }
    if (path === "/api/records/tree") {
      return route.fulfill({ json: { folderId: 0, folders: [], assets: [clip, episode] } satisfies RecordTree });
    }
    if (path === "/api/records/continue") return route.fulfill({ json: { assets: [] } });
    if (path === "/api/records/assets/1/playback") {
      playbackRequests.push(url);
      // The original file fails in the browser; the conversion plays.
      const converted = url.searchParams.get("forceTranscode") === "1";
      return route.fulfill({
        json: {
          delivery: "direct",
          url: converted ? "/api/records/assets/1/stream" : "/api/records/assets/1/unplayable",
          durationSeconds: 180,
          seekable: true,
        } satisfies VideoPlaybackInfo,
      });
    }
    if (path === "/api/records/assets/1/unplayable") return route.fulfill({ status: 415, body: "" });
    if (path === "/api/records/assets/1/stream" || path === "/api/records/assets/2/stream") return serveMedia(route);
    if (path === "/api/records/assets/2/thumbnail") {
      return route.fulfill({ contentType: "image/png", body: coverImage });
    }
    const progress = /^\/api\/records\/assets\/([12])\/progress$/.exec(path);
    if (progress) {
      if (route.request().method() === "PUT") {
        const saved = progress[1] === "1" ? savedPositions : savedAudioPositions;
        saved.push(route.request().postDataJSON() as RecordProgress);
        return route.fulfill({ status: 204, body: "" });
      }
      return route.fulfill({ json: progress[1] === "1" ? savedProgress : episode.progress });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return { playbackRequests, savedPositions, savedAudioPositions };
}

const audioTime = (page: Page) => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime);

test("a Record audio file plays in the global player from where it was left, with its cover, and saves its position @desktop", async ({
  page,
}) => {
  const { savedAudioPositions } = await mockRecordLibrary(page);
  await page.goto("/records");
  await page.getByRole("button", { name: /^Episode 1\.wav/ }).click();

  // The global player plays it; Record opens no player of its own.
  await expect(page.locator("audio")).toHaveJSProperty("paused", false);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => audioTime(page)).toBeGreaterThan(31);
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  await expect(pause).toBeVisible();
  await expect(page.locator('img[src*="/api/records/assets/2/thumbnail"]').first()).toBeVisible();

  await pause.click();
  await expect.poll(() => savedAudioPositions.at(-1)?.positionSeconds ?? 0).toBeGreaterThan(31);
});

test("a Record video hands its sound to the global player from the moment it reached @desktop", async ({ page }) => {
  await mockRecordLibrary(page);
  await page.goto("/records");
  await page.getByRole("button", { name: /Example clip$/ }).click();

  const player = page.getByRole("dialog", { name: "Video player: Example clip" });
  await player.getByRole("button", { name: "Continue", exact: true }).click();
  const video = player.getByLabel("Video preview, duration 3:00", { exact: true });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(61);

  await player.getByRole("button", { name: "Play as audio", exact: true }).click();
  await expect(player).toHaveCount(0);
  await expect(page.locator("audio")).toHaveJSProperty("paused", false);
  await expect.poll(() => audioTime(page)).toBeGreaterThan(61);
});

test("a Record video tile plays its sound in the global player from where the video was left @desktop", async ({
  page,
}) => {
  await mockRecordLibrary(page);
  await page.goto("/records");
  await page.getByRole("button", { name: "Play Example clip as audio", exact: true }).click();

  // The video player stays closed.
  await expect(page.locator("audio")).toHaveJSProperty("paused", false);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => audioTime(page)).toBeGreaterThan(60);
});

test("a Record video continues from its saved position, retries as a conversion, and saves where it stopped @desktop", async ({
  page,
}) => {
  const { playbackRequests, savedPositions } = await mockRecordLibrary(page);
  await page.goto("/records");
  await page.getByRole("button", { name: /Example clip$/ }).click();

  const player = page.getByRole("dialog", { name: "Video player: Example clip" });
  await player.getByRole("button", { name: "Continue", exact: true }).click();

  // The original file fails, so the same moment plays from the conversion.
  await expect.poll(() => playbackRequests.some((url) => url.searchParams.get("forceTranscode") === "1")).toBe(true);
  const video = player.getByLabel("Video preview, duration 3:00", { exact: true });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(61);
  await expect(player.getByRole("alert")).toHaveCount(0);

  await player.getByRole("button", { name: "Close player" }).click();
  await expect(player).toHaveCount(0);
  await expect.poll(() => savedPositions.at(-1)?.positionSeconds ?? 0).toBeGreaterThan(61);
});
