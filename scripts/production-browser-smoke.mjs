import { createRequire } from "node:module";

const requireFrontend = createRequire(
  new URL("../frontend/package.json", import.meta.url),
);

export async function verifyProductionBrowser(baseURL, fixtures, signal) {
  const { chromium, expect } = requireFrontend("@playwright/test");
  const { workCode, aacLocationId, nextLocationId, videoLocationId } = fixtures;
  signal.throwIfAborted();
  const started = Date.now();
  const browser = await chromium.launch({ headless: true, timeout: 15_000 });
  const close = () => {
    void browser.close().catch(() => {});
  };
  const timeout = setTimeout(
    close,
    Math.max(1, 90_000 - (Date.now() - started)),
  );
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({
      baseURL,
      locale: "en-US",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(15_000);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Sign in to Kikoto", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Username", { exact: true }).fill("synthetic-user");
    await page
      .getByLabel("Password", { exact: true })
      .fill("synthetic-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const card = page.getByTestId("work-card").filter({ hasText: workCode });
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: new RegExp(workCode) }).click();
    // The global audio element has no controls or accessible name; inspect its
    // native playback state while driving the authored player through its UI.
    const audio = page.locator("audio");
    const audioPath = () =>
      audio.evaluate((element) =>
        element.currentSrc ? new URL(element.currentSrc).pathname : "",
      );
    await page.getByText("example.wav", { exact: true }).click();
    await expect
      .poll(() => audio.evaluate((element) => element.currentTime))
      .toBeGreaterThan(0);
    await expect(audio).toHaveJSProperty("error", null);

    // Raw AAC must provide a finite timeline, real seeks and natural queue
    // advancement through the production compatibility response.
    await page.getByText("01-example.aac", { exact: true }).click();
    await expect.poll(audioPath).toBe(`/api/media/${aacLocationId}/stream`);
    await expect
      .poll(
        () =>
          audio.evaluate(
            (element) =>
              Number.isFinite(element.duration) &&
              element.duration > 39 &&
              element.duration < 42,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect
      .poll(() => audio.evaluate((element) => element.currentTime))
      .toBeGreaterThan(0.3);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(audio).toHaveJSProperty("paused", true);
    const beforeSeek = await audio.evaluate((element) => element.currentTime);
    await page
      .getByRole("button", { name: "Forward 30 seconds", exact: true })
      .click();
    await expect
      .poll(() => audio.evaluate((element) => element.currentTime))
      .toBeCloseTo(beforeSeek + 30, 0);
    await page
      .getByRole("button", { name: "Back 10 seconds", exact: true })
      .click();
    await expect
      .poll(() => audio.evaluate((element) => element.currentTime))
      .toBeCloseTo(beforeSeek + 20, 0);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect
      .poll(() => audio.evaluate((element) => element.currentTime))
      .toBeGreaterThan(beforeSeek + 20.3);
    await expect(audio).toHaveJSProperty("error", null);

    let aacEnded = false;
    await page.exposeFunction("recordProductionAACEnded", () => {
      aacEnded = true;
    });
    await audio.evaluate((element) => {
      element.addEventListener(
        "ended",
        () => {
          void window.recordProductionAACEnded();
        },
        { once: true },
      );
    });
    const seek = page.getByRole("slider", { name: "Seek", exact: true });
    await expect(seek).toBeEnabled();
    const seekBounds = await seek.boundingBox();
    expect(seekBounds).not.toBeNull();
    await seek.click({
      position: { x: seekBounds.width * 0.95, y: seekBounds.height / 2 },
    });
    await expect
      .poll(() => audio.evaluate((element) => element.currentTime))
      .toBeGreaterThan(37);
    await expect.poll(() => aacEnded, { timeout: 10_000 }).toBe(true);
    await expect.poll(audioPath).toBe(`/api/media/${nextLocationId}/stream`);
    await expect
      .poll(() => audio.evaluate((element) => element.currentTime))
      .toBeGreaterThan(0.2);
    await expect(audio).toHaveJSProperty("paused", false);
    await expect(audio).toHaveJSProperty("error", null);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page
      .getByRole("button", { name: "Collapse player", exact: true })
      .click();

    const openVideo = async () => {
      const [response] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              `/api/media/${videoLocationId}/playback` &&
            response.request().method() === "GET",
        ),
        page.getByText("example.avi", { exact: true }).click(),
      ]);
      expect(response.status()).toBe(200);
      expect((await response.json()).delivery).toBe("hls");
      const dialog = page
        .getByRole("dialog")
        .filter({ has: page.getByLabel(/^Video preview/) });
      const video = dialog.getByLabel(/^Video preview/);
      await expect(video).toBeVisible();
      await expect
        .poll(() => video.evaluate((element) => element.duration), {
          timeout: 15_000,
        })
        .toBeCloseTo(14, 0);
      // Browser-native controls are not app-owned DOM. Use HTMLMediaElement's
      // real controls API; no events, decoding or network responses are mocked.
      await video.evaluate((element) => element.play());
      await expect
        .poll(
          () =>
            video.evaluate((element) => ({
              advancing: element.currentTime > 0.3,
              decoded: element.getVideoPlaybackQuality().totalVideoFrames > 0,
              error: element.error,
            })),
          { timeout: 15_000 },
        )
        .toEqual({ advancing: true, decoded: true, error: null });
      return { dialog, video };
    };
    const { dialog, video } = await openVideo();
    const framesBeforeSeek = await video.evaluate((element) => {
      element.pause();
      const frames = element.getVideoPlaybackQuality().totalVideoFrames;
      element.currentTime = 8;
      return frames;
    });
    await expect
      .poll(
        () =>
          video.evaluate(
            (element) =>
              !element.seeking && Math.abs(element.currentTime - 8) < 0.25,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await video.evaluate((element) => element.play());
    await expect
      .poll(() => video.evaluate((element) => element.currentTime))
      .toBeGreaterThan(8.4);
    await expect
      .poll(() =>
        video.evaluate(
          (element) => element.getVideoPlaybackQuality().totalVideoFrames,
        ),
      )
      .toBeGreaterThan(framesBeforeSeek);
    await expect(video).toHaveJSProperty("error", null);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const reopened = await openVideo();
    await expect(reopened.video).toHaveJSProperty("paused", false);
    await reopened.dialog
      .getByRole("button", { name: "Close", exact: true })
      .click();
    console.log(
      "Production browser smoke passed: login, WAV playback, AAC duration/seeks/ended queue advancement, and AVI HLS decoding/seeking/reopening.",
    );
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", close);
    await browser.close();
  }
}
