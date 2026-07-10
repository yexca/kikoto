import { expect, test, type Page } from "@playwright/test";

const work = {
  id: 1,
  primaryCode: "RJ09999999",
  title: "Tagged mobile work",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  releaseDate: "2026-01-01",
  coverUrl: "",
  dlsiteUrl: "",
  circle: "Test circle",
  circleExternalId: "RG00000001",
  rating: 4.5,
  sales: 10,
  tags: ["ロリ"],
  voiceActors: [],
  series: "",
  seriesTitleId: "",
  trackCount: 1,
  availableLocations: 1,
  availability: ["local"],
  sourcePresence: [],
  progress: { mediaItemId: null, title: "", positionSeconds: 0, durationSeconds: null, lastPlayedAt: null, completed: false },
  listeningStatus: "none",
  favorite: false,
};

const persistedTrack = {
  queueItemId: "e2e-track-1",
  mediaItemId: 1,
  locationId: 1,
  title: "Test track",
  folderPath: "Main",
  locationType: "local",
  streamUrl: "/api/media/1/stream",
  sizeBytes: null,
  availability: "available",
  workId: 1,
  workCode: "RJ09999999",
  workTitle: "Tagged mobile work",
  coverUrl: "",
  circle: "Test circle",
  progress: null,
  progressRecordable: true,
  lyricsLocationId: null,
  lyricsTitle: "",
  locations: [{ locationId: 1, locationType: "local", streamUrl: "/api/media/1/stream", sourceId: 1, sourceName: "Local", availability: "available" }],
};

function silentWav() {
  const sampleCount = 800;
  const body = Buffer.alloc(44 + sampleCount, 128);
  body.write("RIFF", 0);
  body.writeUInt32LE(36 + sampleCount, 4);
  body.write("WAVEfmt ", 8);
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(8000, 24);
  body.writeUInt32LE(8000, 28);
  body.writeUInt16LE(1, 32);
  body.writeUInt16LE(8, 34);
  body.write("data", 36);
  body.writeUInt32LE(sampleCount, 40);
  return body;
}

async function mockApplication(page: Page, onWorksRequest?: (url: URL) => void, failLocalAudio = false) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { authenticated: false } });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: { cacheEnabled: false, directoryRoutingRules: [] } });
      return;
    }
    if (url.pathname === "/api/works") {
      onWorksRequest?.(url);
      await route.fulfill({ json: { works: [work], page: 1, pageSize: 24, total: 1 } });
      return;
    }
    if (url.pathname === "/api/media/1/stream") {
      if (failLocalAudio) {
        await route.fulfill({ status: 503, body: "Source unavailable" });
        return;
      }
      await route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav() });
      return;
    }
    if (url.pathname === "/api/media/2/stream") {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav() });
      return;
    }
    if (url.pathname === "/api/media/9/text") {
      await route.fulfill({ json: { path: "lyrics.lrc", content: "[00:00.00]First line\n[00:05.00]Second line\n[00:10.00]Third line\n[00:15.00]Fourth line" } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not mocked" } });
  });
}

async function seedPlayer(page: Page, track = persistedTrack) {
  await page.addInitScript((track) => {
    localStorage.setItem("kikoto:player-queue:v1", JSON.stringify({ version: 1, queue: [track], currentIndex: 0, mode: "order", playbackRate: 1, sleepTimer: null }));
  }, track);
}

test("tag clicks send a structured Unicode tag search and retain the matching work", async ({ page }) => {
  const requests: string[] = [];
  await mockApplication(page, (url) => requests.push(url.searchParams.get("q") ?? ""));
  await page.goto("/");

  await expect(page.getByText("Tagged mobile work", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ロリ", exact: true }).click();
  await expect.poll(() => requests.some((query) => query === "$tag:ロリ$")).toBe(true);
  await expect(page.getByText("Tagged mobile work", { exact: true })).toBeVisible();
});

test("toolbar popovers stay anchored below their trigger and inside the mobile viewport", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/");

  const trigger = page.getByTitle("Data");
  await trigger.click();
  const popover = page.locator(".fixed.z-50").filter({ hasText: "All records" });
  await expect(popover).toBeVisible();
  const [triggerBox, popoverBox, viewport] = await Promise.all([trigger.boundingBox(), popover.boundingBox(), page.evaluate(() => ({ width: innerWidth, height: innerHeight }))]);
  expect(triggerBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height - 1);
  expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
  expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(viewport.height);
});

test("library request failures are not presented as an empty collection", async ({ page }) => {
  await mockApplication(page);
  await page.route("**/api/works?**", (route) => route.fulfill({ status: 500, json: { error: "database temporarily unavailable" } }));
  await page.goto("/");

  await expect(page.getByText("Library could not be loaded.")).toBeVisible();
  await expect(page.getByText("database temporarily unavailable")).toBeVisible();
  await expect(page.getByText("No local works match this view.")).toBeHidden();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("full player collapses from the upper content area and double-tapping its cover opens work detail", async ({ page }) => {
  await mockApplication(page);
  await seedPlayer(page);
  await page.goto("/");

  await page.getByText("Test track", { exact: true }).click();
  let fullPlayer = page.locator("section.fixed.inset-0");
  await expect(fullPlayer).toBeVisible();
  const fullBox = await fullPlayer.boundingBox();
  expect(fullBox).not.toBeNull();
  await page.mouse.move(fullBox!.x + 18, fullBox!.y + fullBox!.height * 0.42);
  await page.mouse.down();
  await page.mouse.move(fullBox!.x + 18, fullBox!.y + fullBox!.height * 0.42 + 130, { steps: 5 });
  await page.mouse.up();
  await expect(fullPlayer).toBeHidden();

  await page.getByText("Test track", { exact: true }).click();
  fullPlayer = page.locator("section.fixed.inset-0");
  await expect(fullPlayer).toBeVisible();
  const cover = fullPlayer.getByRole("button", { name: "Open work detail" });
  await cover.tap();
  await page.waitForTimeout(100);
  await cover.tap();
  await expect(page).toHaveURL(/\/RJ09999999$/);
  await expect(fullPlayer).toBeHidden();
});

test("inline lyrics keep three rows visible and scroll the active line into the center", async ({ page }) => {
  await mockApplication(page);
  await seedPlayer(page, { ...persistedTrack, lyricsLocationId: 9, lyricsTitle: "lyrics.lrc" });
  await page.goto("/");
  await page.getByText("Test track", { exact: true }).click();

  const preview = page.getByRole("button", { name: "Open lyrics" });
  await expect(preview).toBeVisible();
  await expect(preview.locator('[data-lyric-index="0"]')).toHaveClass(/text-primary/);
  await expect(preview.locator('[data-lyric-index="1"]')).not.toHaveClass(/opacity-0/);
  await expect(preview.locator('[data-lyric-index="2"]')).not.toHaveClass(/opacity-0/);
  await page.locator("audio").evaluate((audio) => {
    Object.defineProperty(audio, "currentTime", { configurable: true, value: 11 });
    audio.dispatchEvent(new Event("timeupdate"));
  });
  await expect(preview.locator('[data-lyric-index="0"]')).toHaveClass(/opacity-0/);
  await expect(preview.locator('[data-lyric-index="1"]')).not.toHaveClass(/opacity-0/);
  await expect(preview.locator('[data-lyric-index="2"]')).toHaveClass(/text-primary/);
  await expect(preview.locator('[data-lyric-index="3"]')).not.toHaveClass(/opacity-0/);
  await expect(preview.locator(":scope > div")).toHaveAttribute("style", /translateY\(-28px\)/);
});

test("desktop player uses playback speed without volume or colored play glow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page);
  await seedPlayer(page);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Playback speed 1 times" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Volume" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play", exact: true })).not.toHaveClass(/shadow-primary/);
});

test("mini player reveals actions on tap, persists its snapped edge, and compact mode reserves page space", async ({ page }) => {
  await mockApplication(page);
  await seedPlayer(page);
  await page.goto("/");

  const padding = await page.locator(".app-shell").evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom));
  expect(padding).toBeGreaterThanOrEqual(160);
  await page.getByRole("button", { name: "Mini player" }).click();
  const mini = page.locator(".mini-player");
  await expect(mini).toBeVisible();
  await mini.tap({ position: { x: 8, y: 46 } });
  await expect(mini).toHaveClass(/actions-open/);
  await expect(page.getByRole("button", { name: "Open compact player" })).toBeVisible();

  await page.waitForTimeout(3100);
  await expect(mini).not.toHaveClass(/actions-open/);
  const box = await mini.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 8, box!.y + 46);
  await page.mouse.down();
  await page.mouse.move(12, Math.max(20, box!.y - 30), { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("kikoto:player-mini-position:v1") ?? "null")?.side)).toBe("left");

  await page.reload();
  await page.getByRole("button", { name: "Mini player" }).click();
  const restored = await page.locator(".mini-player").boundingBox();
  expect(restored).not.toBeNull();
  expect(restored!.x).toBeLessThanOrEqual(10);
});

test("failed sources fall back automatically and the sleep timer survives a reload", async ({ page }) => {
  await mockApplication(page, undefined, true);
  await seedPlayer(page, {
    ...persistedTrack,
    locations: [
      ...persistedTrack.locations,
      { locationId: 2, locationType: "remote_stream", streamUrl: "/api/media/2/stream", sourceId: 2, sourceName: "Remote", availability: "remote" },
    ],
  });
  await page.goto("/");

  await expect(page.getByText("Playback source failed. Switched to Remote.")).toBeVisible();
  await page.getByText("Test track", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose playback source" })).toContainText("Remote");
  await page.getByRole("button", { name: "Sleep timer" }).click();
  await expect(page.getByRole("button", { name: "30 min" })).toBeVisible();
  await expect(page.getByRole("button", { name: "60 min" })).toBeVisible();
  await page.getByRole("button", { name: "Custom" }).click();
  const customMinutes = page.getByRole("spinbutton", { name: "Custom sleep minutes" });
  await expect(customMinutes).toBeVisible();
  await customMinutes.fill("75");
  await page.getByRole("button", { name: "Set" }).click();
  await expect.poll(() => page.evaluate(() => {
    const timer = JSON.parse(localStorage.getItem("kikoto:player-queue:v1") ?? "null")?.sleepTimer;
    return timer ? Math.round((timer.deadline - Date.now()) / 60_000) : 0;
  })).toBe(75);

  await page.getByRole("button", { name: "Sleep timer" }).click();
  await page.getByText("Test track", { exact: true }).click();
  await expect(page.getByRole("button", { name: "30 min" })).toBeHidden();

  await page.getByRole("button", { name: "Sleep timer" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "30 min" })).toBeHidden();
  await page.getByRole("button", { name: "Sleep timer" }).click();
  await page.getByRole("switch", { name: "Finish current track" }).check();
  await page.getByRole("button", { name: "30 min" }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("kikoto:player-queue:v1") ?? "null")?.sleepTimer?.mode)).toBe("deadline");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("kikoto:player-queue:v1") ?? "null")?.sleepTimer?.finishCurrentTrack)).toBe(true);

  const restoredPage = await page.context().newPage();
  await mockApplication(restoredPage);
  await restoredPage.goto("/");
  await expect.poll(() => restoredPage.evaluate(() => JSON.parse(localStorage.getItem("kikoto:player-queue:v1") ?? "null")?.sleepTimer?.deadline > Date.now())).toBe(true);
  await restoredPage.close();
});

test("legacy end-of-track sleep timers migrate without being discarded", async ({ page }) => {
  await mockApplication(page);
  await page.addInitScript((track) => {
    localStorage.setItem("kikoto:player-queue:v1", JSON.stringify({
      version: 1,
      queue: [track],
      currentIndex: 0,
      mode: "order",
      playbackRate: 1,
      sleepTimer: { mode: "track_end" },
    }));
  }, persistedTrack);
  await page.goto("/");
  await page.getByText("Test track", { exact: true }).click();

  await expect(page.getByRole("button", { name: "Sleep timer" })).toContainText("Track");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("kikoto:player-queue:v1") ?? "null")?.sleepTimer)).toMatchObject({
    mode: "deadline",
    finishCurrentTrack: true,
    waitingForTrackEnd: true,
  });
});

test("PWA metadata exposes install icons and the worker excludes API and range requests", async ({ request }) => {
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json() as { display: string; icons: Array<{ sizes: string; purpose: string }> };
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.some((icon) => icon.sizes === "192x192")).toBe(true);
  expect(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable")).toBe(true);

  const workerResponse = await request.get("/sw.js");
  expect(workerResponse.ok()).toBe(true);
  const worker = await workerResponse.text();
  expect(worker).toContain('url.pathname.startsWith("/api/")');
  expect(worker).toContain('request.headers.has("range")');
});
