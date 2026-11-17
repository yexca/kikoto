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
      return route.fulfill({ json: { folderId: 0, folders: [], assets: [clip] } satisfies RecordTree });
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
    if (path === "/api/records/assets/1/stream") return serveMedia(route);
    if (path === "/api/records/assets/1/progress") {
      if (route.request().method() === "PUT") {
        savedPositions.push(route.request().postDataJSON() as RecordProgress);
        return route.fulfill({ status: 204, body: "" });
      }
      return route.fulfill({ json: savedProgress });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return { playbackRequests, savedPositions };
}

test("a Record video continues from its saved position, retries as a conversion, and saves where it stopped @desktop", async ({
  page,
}) => {
  const { playbackRequests, savedPositions } = await mockRecordLibrary(page);
  await page.goto("/records");
  await page.getByRole("button", { name: /Example clip/ }).click();

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
