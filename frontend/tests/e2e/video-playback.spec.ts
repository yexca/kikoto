import { expect, test, type Page, type Route } from "@playwright/test";

import type { MediaItem, MediaTextPreview, VideoPlaybackInfo } from "../../src/lib/api";
import type { ApiErrorBody } from "./fixtures/api";
import { mediaFixture, mockApplication, silentWav, work } from "./fixtures/player-library";

function videoFixture(id: number, title: string): MediaItem {
  const item = mediaFixture(id, title, `${work.primaryCode}/${title}`, "file");
  return {
    ...item,
    kind: "video",
    durationSeconds: 180,
    hasAudio: true,
    locations: item.locations.map((location) => ({
      ...location,
      durationSeconds: 180,
      streamUrl: `/api/media/${id}/stream`,
    })),
  };
}

async function mockLocalVideo(page: Page, otherItems: MediaItem[] = []) {
  await mockApplication(page, undefined, false, 1, 0, [videoFixture(1, "example.avi"), ...otherItems]);
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
  await page.route(/\/api\/media\/\d+\/stream/, serveMedia);
  await page.route("**/api/media/1/native-hls.wav", serveMedia);
}

async function mockDirectPlayback(page: Page) {
  await page.route(/\/api\/media\/\d+\/playback/, (route) => {
    const id = /\/api\/media\/(\d+)\//.exec(route.request().url())?.[1];
    return route.fulfill({
      json: {
        delivery: "direct",
        url: `/api/media/${id}/stream`,
        durationSeconds: 180,
        seekable: true,
      } satisfies VideoPlaybackInfo,
    });
  });
}

const currentTime = (element: HTMLVideoElement) => element.currentTime;

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
      } satisfies VideoPlaybackInfo,
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
        ? { status: 503, json: { error: "Busy", code: "media_probe_busy", retryable: true } satisfies ApiErrorBody }
        : {
            json: {
              delivery: "direct",
              url: "/api/media/1/stream",
              durationSeconds: 180,
              seekable: true,
            } satisfies VideoPlaybackInfo,
          },
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

test("a reopened video resumes where it stopped and can start over", async ({ page }) => {
  await mockLocalVideo(page);
  await mockDirectPlayback(page);
  let video = await openVideo(page);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = 42;
  });
  await expect.poll(() => video.evaluate(currentTime)).toBe(42);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  video = await openVideo(page);
  await expect(page.getByRole("status").filter({ hasText: "Resumed at 0:42" })).toBeVisible();
  await expect.poll(() => video.evaluate(currentTime)).toBe(42);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);

  await page.getByRole("button", { name: "Start over", exact: true }).click();
  await expect.poll(() => video.evaluate(currentTime)).toBe(0);
  await expect(page.getByText("Resumed at 0:42")).toHaveCount(0);
  await page.getByRole("button", { name: "Close", exact: true }).click();

  video = await openVideo(page);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  await expect(page.getByText(/Resumed at/)).toHaveCount(0);
  expect(await video.evaluate(currentTime)).toBe(0);
});

test("video stage shortcuts control the video while the dialog keeps its file keys", async ({ page }) => {
  await mockLocalVideo(page, [videoFixture(5, "second.avi")]);
  await mockDirectPlayback(page);
  const video = await openVideo(page);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  await page.getByRole("group", { name: "Video player", exact: true }).focus();

  await page.keyboard.press("ArrowRight");
  await expect.poll(() => video.evaluate(currentTime)).toBe(5);
  await page.keyboard.press("l");
  await expect.poll(() => video.evaluate(currentTime)).toBe(15);
  await page.keyboard.press("j");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => video.evaluate(currentTime)).toBe(0);
  await expect(page.getByRole("heading", { name: "example.avi", exact: true })).toBeVisible();

  await page.keyboard.press("k");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
  await page.keyboard.press("Space");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await page.keyboard.press("m");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(true);
  await page.keyboard.press("Shift+Period");
  await page.keyboard.press("Shift+Period");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.playbackRate)).toBe(1.5);
  await expect(page.getByRole("status").filter({ hasText: "Speed 1.5×" })).toBeVisible();
  await page.keyboard.press("Shift+Comma");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.playbackRate)).toBe(1.25);

  // Outside the video stage the arrow keys still step through the folder's videos.
  await page.getByRole("dialog").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("heading", { name: "second.avi", exact: true })).toBeVisible();
});

test("same-name WebVTT and SRT files load as subtitle tracks", async ({ page }) => {
  const subtitles: Record<number, MediaTextPreview> = {
    2: { path: "example.srt", content: "1\r\n00:00:01,000 --> 00:00:03,500\r\nSynthetic SRT line\r\n" },
    3: { path: "example.avi.vtt", content: "WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nSynthetic WebVTT line\n" },
  };
  await mockLocalVideo(page, [
    mediaFixture(2, "example.srt", `${work.primaryCode}/example.srt`, "text"),
    mediaFixture(3, "example.avi.vtt", `${work.primaryCode}/example.avi.vtt`, "text"),
    mediaFixture(4, "other.srt", `${work.primaryCode}/other.srt`, "text"),
  ]);
  await mockDirectPlayback(page);
  const textRequests: number[] = [];
  await page.route(/\/api\/media\/\d+\/text$/, (route) => {
    const id = Number(/\/api\/media\/(\d+)\/text$/.exec(route.request().url())?.[1]);
    textRequests.push(id);
    return route.fulfill({ json: subtitles[id] ?? { path: "other.srt", content: "" } });
  });
  const video = await openVideo(page);
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) =>
        Array.from(element.textTracks).map((track) => ({ label: track.label, mode: track.mode })),
      ),
    )
    .toEqual([
      { label: "example.avi.vtt", mode: "showing" },
      { label: "example.srt", mode: "disabled" },
    ]);
  // Development StrictMode may load the files twice; the unrelated other.srt is never read.
  expect([...new Set(textRequests)].sort()).toEqual([2, 3]);

  await video.evaluate((element: HTMLVideoElement) => {
    element.textTracks[1].mode = "hidden";
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => {
        const cue = element.textTracks[1].cues?.[0] as VTTCue | undefined;
        return cue ? { text: cue.text, start: cue.startTime, end: cue.endTime } : null;
      }),
    )
    .toEqual({ text: "Synthetic SRT line", start: 1, end: 3.5 });
});

test("choosing another audio track keeps the position and the paused or playing state", async ({ page }) => {
  await mockLocalVideo(page);
  const requested: (string | null)[] = [];
  await page.route("**/api/media/1/playback*", (route) => {
    const audioStream = new URL(route.request().url()).searchParams.get("audioStream");
    requested.push(audioStream);
    return route.fulfill({
      json: {
        delivery: audioStream === "2" ? "hls" : "direct",
        url: audioStream === "2" ? "/api/media/1/native-hls.wav" : "/api/media/1/stream",
        durationSeconds: 180,
        seekable: true,
        audioTracks: [
          { streamIndex: 1, codec: "aac", channels: 2, language: "jpn", default: true },
          { streamIndex: 2, codec: "ac3", channels: 6, title: "Commentary", default: false },
        ],
        audioStream: audioStream === "2" ? 2 : 1,
      } satisfies VideoPlaybackInfo,
    });
  });
  const video = await openVideo(page);
  const menu = page.getByRole("combobox", { name: "Audio track", exact: true });
  await expect(menu).toHaveValue("1");
  await expect(menu.getByRole("option")).toHaveText(["Track 1 · Japanese · Stereo", "Track 2 · Commentary · 5.1"]);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = 42;
  });
  await expect.poll(() => video.evaluate(currentTime)).toBe(42);

  await menu.selectOption("2");
  await expect.poll(() => requested.at(-1)).toBe("2");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => ({
        source: element.currentSrc.split("/").at(-1),
        paused: element.paused,
        position: element.currentTime,
      })),
    )
    .toEqual({ source: "native-hls.wav", paused: true, position: 42 });
  await expect(menu).toHaveValue("2");

  await video.evaluate(async (element: HTMLVideoElement) => {
    element.currentTime = 84;
    await element.play();
  });
  await menu.selectOption("1");
  await expect.poll(() => requested.at(-1)).toBe("1");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => ({
        source: element.currentSrc.split("/").at(-1),
        paused: element.paused,
        positionRestored: element.currentTime >= 84,
      })),
    )
    .toEqual({ source: "stream", paused: false, positionRestored: true });

  // The choice lasts while the page does: reopening the video asks for the same track.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const before = requested.length;
  await page.getByText("example.avi", { exact: true }).click();
  await expect.poll(() => requested.length).toBeGreaterThan(before);
  expect(new Set(requested.slice(before))).toEqual(new Set(["1"]));
  await expect(menu).toHaveValue("1");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("ASS files and embedded subtitle streams load as subtitle tracks", async ({ page }) => {
  const ass = [
    "[Script Info]",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\an8}Synthetic\\NASS line",
  ].join("\n");
  await mockLocalVideo(page, [mediaFixture(2, "example.ass", `${work.primaryCode}/example.ass`, "text")]);
  await page.route(/\/api\/media\/\d+\/text$/, (route) =>
    route.fulfill({ json: { path: "example.ass", content: ass } satisfies MediaTextPreview }),
  );
  await page.route("**/api/media/1/playback*", (route) =>
    route.fulfill({
      json: {
        delivery: "direct",
        url: "/api/media/1/stream",
        durationSeconds: 180,
        seekable: true,
        subtitles: [
          {
            stream: 2,
            codec: "ass",
            language: "jpn",
            title: "Dialogue",
            default: true,
            forced: false,
            url: "/api/media/1/subtitles/2.vtt?v=synthetic",
          },
          {
            stream: 3,
            codec: "subrip",
            language: "eng",
            default: false,
            forced: false,
            url: "/api/media/1/subtitles/3.vtt?v=synthetic",
          },
        ],
      } satisfies VideoPlaybackInfo,
    }),
  );
  const streamRequests: number[] = [];
  await page.route(/\/api\/media\/1\/subtitles\/\d+\.vtt/, (route) => {
    const stream = Number(/subtitles\/(\d+)\.vtt/.exec(route.request().url())?.[1]);
    streamRequests.push(stream);
    return route.fulfill({
      contentType: "text/vtt",
      body: `WEBVTT\n\n00:00:0${stream}.000 --> 00:00:05.000\nSynthetic stream ${stream}\n`,
    });
  });
  const video = await openVideo(page);
  const tracks = () =>
    video.evaluate((element: HTMLVideoElement) =>
      Array.from(element.textTracks).map((track) => ({
        label: track.label,
        language: track.language,
        mode: track.mode,
        cue: (track.cues?.[0] as VTTCue | undefined)?.text ?? null,
      })),
    );
  // The default stream shows; the other stream is not extracted until it is selected.
  await expect.poll(tracks).toEqual([
    { label: "example.ass", language: "", mode: "disabled", cue: null },
    { label: "Japanese · Dialogue", language: "ja", mode: "showing", cue: "Synthetic stream 2" },
    { label: "English", language: "en", mode: "disabled", cue: null },
  ]);
  expect([...new Set(streamRequests)]).toEqual([2]);

  await video.evaluate((element: HTMLVideoElement) => {
    element.textTracks[0].mode = "hidden";
    element.textTracks[2].mode = "hidden";
  });
  await expect
    .poll(async () => (await tracks()).map((track) => track.cue))
    .toEqual(["Synthetic\nASS line", "Synthetic stream 2", "Synthetic stream 3"]);
  expect([...new Set(streamRequests)].sort()).toEqual([2, 3]);
});

async function storeSeekSteps(page: Page, backward: number, forward: number) {
  await page.addInitScript(
    ({ seekBackwardSeconds, seekForwardSeconds }) => {
      const key = `kikoto:player-seek-preferences:v1:${encodeURIComponent(window.location.origin)}:anonymous`;
      localStorage.setItem(key, JSON.stringify({ seekBackwardSeconds, seekForwardSeconds }));
    },
    { seekBackwardSeconds: backward, seekForwardSeconds: forward },
  );
}

test("the on-screen back and forward buttons seek by the playback settings", async ({ page }) => {
  await mockLocalVideo(page);
  await mockDirectPlayback(page);
  await storeSeekSteps(page, 7, 20);
  const video = await openVideo(page);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Forward 20 seconds", exact: true }).click();
  await expect.poll(() => video.evaluate(currentTime)).toBe(20);
  await page.getByRole("button", { name: "Back 7 seconds", exact: true }).click();
  await expect.poll(() => video.evaluate(currentTime)).toBe(13);

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(true);
  await expect(page.getByRole("button", { name: "Unmute", exact: true })).toBeVisible();
});

test("double taps on either side of the video seek and add up", async ({ page }) => {
  await mockLocalVideo(page);
  await mockDirectPlayback(page);
  const video = await openVideo(page);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = 100;
  });
  await expect.poll(() => video.evaluate(currentTime)).toBe(100);
  const box = await video.boundingBox();
  if (!box) throw new Error("The video has no layout box.");
  const y = box.y + box.height * 0.25;
  const right = box.x + box.width * 0.9;
  const left = box.x + box.width * 0.1;

  await page.touchscreen.tap(right, y);
  await page.touchscreen.tap(right, y);
  await page.touchscreen.tap(right, y);
  await expect.poll(() => video.evaluate(currentTime)).toBe(160);
  const forwardHint = page.getByRole("status").filter({ hasText: "+60 seconds" });
  await expect(forwardHint).toBeVisible();

  await expect(forwardHint).toHaveCount(0);
  await page.touchscreen.tap(left, y);
  await page.touchscreen.tap(left, y);
  await expect.poll(() => video.evaluate(currentTime)).toBe(150);
  await expect(page.getByRole("status").filter({ hasText: "−10 seconds" })).toBeVisible();
});

test("the speed menu sets the playback rate and shows the speed notice", async ({ page }) => {
  await mockLocalVideo(page);
  await mockDirectPlayback(page);
  const video = await openVideo(page);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Playback speed", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Playback speed", exact: true });
  await expect(menu.getByRole("menuitemradio", { name: "1×", exact: true })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "1.5×", exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.playbackRate)).toBe(1.5);
  await expect(page.getByRole("status").filter({ hasText: "Speed 1.5×" })).toBeVisible();
  await expect(menu).toHaveCount(0);
});

test("the subtitle menu shows one track and extracts an embedded stream only once chosen", async ({ page }) => {
  await mockLocalVideo(page, [mediaFixture(2, "example.srt", `${work.primaryCode}/example.srt`, "text")]);
  await page.route(/\/api\/media\/\d+\/text$/, (route) =>
    route.fulfill({
      json: {
        path: "example.srt",
        content: "1\r\n00:00:01,000 --> 00:00:03,500\r\nSynthetic SRT line\r\n",
      } satisfies MediaTextPreview,
    }),
  );
  await page.route("**/api/media/1/playback*", (route) =>
    route.fulfill({
      json: {
        delivery: "direct",
        url: "/api/media/1/stream",
        durationSeconds: 180,
        seekable: true,
        subtitles: [
          {
            stream: 3,
            codec: "subrip",
            language: "eng",
            default: false,
            forced: false,
            url: "/api/media/1/subtitles/3.vtt?v=synthetic",
          },
        ],
      } satisfies VideoPlaybackInfo,
    }),
  );
  const streamRequests: number[] = [];
  await page.route(/\/api\/media\/1\/subtitles\/\d+\.vtt/, (route) => {
    streamRequests.push(Number(/subtitles\/(\d+)\.vtt/.exec(route.request().url())?.[1]));
    return route.fulfill({
      contentType: "text/vtt",
      body: "WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nSynthetic stream\n",
    });
  });
  const video = await openVideo(page);
  const modes = () =>
    video.evaluate((element: HTMLVideoElement) =>
      Array.from(element.textTracks).map((track) => `${track.label}:${track.mode}`),
    );
  await expect.poll(modes).toEqual(["example.srt:showing", "English:disabled"]);

  const subtitlesButton = page.getByRole("button", { name: "Subtitles", exact: true });
  const menu = page.getByRole("menu", { name: "Subtitles", exact: true });
  const choose = async (name: string) => {
    await subtitlesButton.click();
    await menu.getByRole("menuitemradio", { name, exact: true }).click();
  };
  await subtitlesButton.click();
  await expect(menu.getByRole("menuitemradio")).toHaveText(["Off", "example.srt", "English"]);
  await expect(menu.getByRole("menuitemradio", { name: "example.srt", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(subtitlesButton).toBeFocused();
  expect(streamRequests).toEqual([]);

  await choose("English");
  await expect.poll(modes).toEqual(["example.srt:disabled", "English:showing"]);
  await expect.poll(() => [...new Set(streamRequests)]).toEqual([3]);
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.textTracks[1].cues?.length ?? 0))
    .toBe(1);

  await choose("Off");
  await expect.poll(modes).toEqual(["example.srt:disabled", "English:disabled"]);
});

test("fullscreen holds the video stage, and its menus show inside it @desktop", async ({ page }) => {
  await mockLocalVideo(page);
  await mockDirectPlayback(page);
  const video = await openVideo(page);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  const fullscreenLabel = () => page.evaluate(() => document.fullscreenElement?.getAttribute("aria-label") ?? null);

  await page.getByRole("button", { name: "Full screen", exact: true }).click();
  await expect.poll(fullscreenLabel).toBe("Video player");
  await page.getByRole("button", { name: "Playback speed", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Playback speed", exact: true });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((element) => document.fullscreenElement?.contains(element) ?? false)).toBe(true);
  await menu.getByRole("menuitemradio", { name: "2×", exact: true }).click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.playbackRate)).toBe(2);

  await page.getByRole("button", { name: "Exit full screen", exact: true }).click();
  await expect.poll(fullscreenLabel).toBeNull();

  // A mouse click on the picture, away from the controls, plays and pauses; a double click toggles fullscreen.
  const box = await video.boundingBox();
  if (!box) throw new Error("The video has no layout box.");
  const x = box.x + box.width * 0.15;
  const y = box.y + box.height * 0.25;
  await page.mouse.click(x, y);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
  await page.mouse.click(x, y);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await page.mouse.dblclick(x, y);
  await expect.poll(fullscreenLabel).toBe("Video player");
  // The fullscreen layout settles when the browser reports the change, which the controls then show.
  await expect(page.getByRole("button", { name: "Exit full screen", exact: true })).toHaveCount(1);
  await page.mouse.dblclick(x, y);
  await expect.poll(fullscreenLabel).toBeNull();
});
