import { expect, test, type Page, type Route } from "@playwright/test";

import { mediaFixture, mockApplication, silentWav, work } from "./fixtures/player-library";

async function mockLocalVideo(page: Page) {
  const item = mediaFixture(1, "example.avi", `${work.primaryCode}/example.avi`, "file");
  await mockApplication(page, undefined, false, 1, 0, [
    {
      ...item,
      kind: "video",
      durationSeconds: 180,
      hasAudio: true,
      locations: item.locations.map((location) => ({
        ...location,
        durationSeconds: 180,
        streamUrl: "/api/media/1/stream",
      })),
    },
  ]);
  // Exercise the native-HLS branch through browser capability APIs. A generated
  // WAV supplies real media timing; this tests recovery, not codec decoding.
  await page.addInitScript(() => {
    for (const name of ["MediaSource", "ManagedMediaSource", "WebKitMediaSource"]) {
      Object.defineProperty(window, name, { configurable: true, value: undefined });
    }
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      return type === "application/vnd.apple.mpegurl" ? "probably" : canPlayType.call(this, type);
    };
  });
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
  await page.route("**/api/media/1/stream*", serveMedia);
  await page.route("**/api/media/1/native-hls.wav", serveMedia);
}

async function openVideo(page: Page) {
  await page.goto(`/${work.primaryCode}`);
  await page.getByText("example.avi", { exact: true }).click();
  return page.getByLabel("Video preview, duration 3:00", { exact: true });
}

test("local video fallback and native HLS retry retain position and playback intent", async ({ page }) => {
  await mockLocalVideo(page);
  const requests: boolean[] = [];
  await page.route("**/api/media/1/playback*", (route) => {
    const transcode = new URL(route.request().url()).searchParams.get("forceTranscode") === "1";
    requests.push(transcode);
    return route.fulfill({
      json: {
        delivery: transcode ? "hls" : "direct",
        url: transcode ? "/api/media/1/native-hls.wav" : "/api/media/1/stream",
        durationSeconds: 180,
        seekable: true,
      },
    });
  });
  const video = await openVideo(page);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.currentTime = 42;
    await element.play();
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThanOrEqual(42);
  await video.evaluate((element: HTMLVideoElement) => element.dispatchEvent(new Event("error")));
  await expect.poll(() => [...new Set(requests)]).toEqual([false, true]);
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => ({
        source: element.currentSrc.split("/").at(-1),
        paused: element.paused,
        positionRestored: element.currentTime >= 42,
        error: element.error?.message ?? null,
      })),
    )
    .toEqual({ source: "native-hls.wav", paused: false, positionRestored: true, error: null });

  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = 84;
    element.dispatchEvent(new Event("error"));
  });
  await expect(page.getByRole("alert")).toContainText("This video could not be played.");
  const beforeRetry = requests.length;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(beforeRetry);
  expect(requests.at(-1)).toBe(true);
  await expect
    .poll(() =>
      video.evaluate(
        (element: HTMLVideoElement) => element.readyState > 0 && element.paused && element.currentTime === 84,
      ),
    )
    .toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("busy local video preparation stops automatic retries and keeps manual recovery available", async ({ page }) => {
  await mockLocalVideo(page);
  let requests = 0;
  let busy = true;
  await page.route("**/api/media/1/playback*", (route) => {
    requests++;
    return route.fulfill(
      busy
        ? { status: 503, json: { error: "Busy", code: "media_probe_busy", retryable: true } }
        : { json: { delivery: "direct", url: "/api/media/1/stream", durationSeconds: 180, seekable: true } },
    );
  });
  const video = await openVideo(page);
  await expect(page.getByRole("alert")).toContainText("Video playback is temporarily busy.");
  // Development StrictMode may cancel one additional initial request.
  expect(requests).toBeGreaterThanOrEqual(3);
  expect(requests).toBeLessThanOrEqual(4);
  const beforeRetry = requests;
  busy = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  expect(requests).toBe(beforeRetry + 1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
