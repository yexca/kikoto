import { expect, test, type Route } from "@playwright/test";
import {
  persistedTrack,
  persistedPlayerTracks,
  playerQueueStorageBaseKey,
  playerProgressStorageBaseKey,
  silentWav,
  mockApplication,
  seedPlayer,
  readScopedPlayerState,
  mediaFixture,
} from "./fixtures/player-library";

function servePreparedAudio(route: Route, media: Buffer) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Math.min(Number(range[2]), media.length - 1) : media.length - 1;
  return route.fulfill({
    status: range ? 206 : 200,
    contentType: "audio/wav",
    headers: {
      "Accept-Ranges": "bytes",
      "X-Kikoto-Playback-Delivery": "transcoded",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${media.length}` } : {}),
    },
    body: media.subarray(start, end + 1),
  });
}

test("full player collapses from the upper content area and double-tapping its cover opens work detail", async ({
  page,
}) => {
  await mockApplication(page);
  await seedPlayer(page);
  await page.goto("/");

  await page.getByText("Test track", { exact: true }).click();
  let fullPlayer = page.locator("section.fixed.inset-0");
  await expect(fullPlayer).toBeVisible();
  await expect(fullPlayer.getByText("Test circle", { exact: true })).toBeVisible();
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
  await expect(page).toHaveURL(/\/RJ00000000$/);
  await expect(fullPlayer).toBeHidden();
});

test("entering a playing work opens the current track folder", async ({ page }) => {
  const playingTrack = {
    ...persistedTrack,
    mediaItemId: 2,
    locationId: 2,
    title: "Playing track",
    folderPath: "Playing",
    streamUrl: "/api/media/2/stream",
    locations: [{ ...persistedTrack.locations[0], locationId: 2, streamUrl: "/api/media/2/stream" }],
  };
  const mediaItems = [
    mediaFixture(1, "Default track", "RJ00000000/Default/Default track.mp3", "audio"),
    mediaFixture(2, "Playing track", "RJ00000000/Playing/Playing track.mp3", "audio"),
  ];
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function play() {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
  });
  await mockApplication(page, undefined, false, 1, 0, mediaItems);
  await seedPlayer(page, playingTrack);
  await page.goto("/");

  await page.getByText("Playing track", { exact: true }).click();
  const fullPlayer = page.locator("section.fixed.inset-0");
  await fullPlayer.getByRole("button", { name: "Play", exact: true }).click();
  await expect(fullPlayer.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  const cover = fullPlayer.getByRole("button", { name: "Open work detail" });
  await cover.tap();
  await cover.tap();

  await expect(page).toHaveURL(/\/RJ00000000$/);
  await expect(page.getByTestId("directory-breadcrumb-current")).toHaveText("Playing");
});

test("mobile full player gives artwork room and does not latch transport feedback", async ({ page }) => {
  await mockApplication(page);
  await seedPlayer(page);
  await page.goto("/");

  await page.getByText("Test track", { exact: true }).click();
  const fullPlayer = page.locator("section.fixed.inset-0");
  const cover = fullPlayer.getByRole("button", { name: "Open work detail" });
  const forward = fullPlayer.getByRole("button", { name: "Forward 30 seconds" });
  await expect(fullPlayer).toBeVisible();

  const [fullBox, coverBox] = await Promise.all([fullPlayer.boundingBox(), cover.boundingBox()]);
  expect(fullBox).not.toBeNull();
  expect(coverBox).not.toBeNull();
  expect(coverBox!.width).toBeGreaterThan(fullBox!.width * 0.8);

  const readTransportStyle = () =>
    forward.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        color: style.color,
      };
    });
  const restingStyle = await readTransportStyle();
  await forward.tap();
  await expect.poll(readTransportStyle).toEqual(restingStyle);
});

test("current lyric line follows playback and opens the lyrics panel", async ({ page }) => {
  const lyricsTrack = {
    ...persistedTrack,
    lyricsLocationId: 9,
    lyricsTitle: "lyrics.lrc",
    autoLyricsLocationId: 9,
    lyricsChoices: [
      {
        mediaItemId: 9,
        locationId: 9,
        title: "lyrics.lrc",
        path: "Main/lyrics.lrc",
        reason: "same_stem" as const,
      },
      {
        mediaItemId: 10,
        locationId: 10,
        title: "translation.srt",
        path: "Main/translation.srt",
        reason: "shared_folder" as const,
      },
    ],
  };
  await mockApplication(page);
  await seedPlayer(page, lyricsTrack);
  await page.goto("/");
  await page.getByText("Test track", { exact: true }).click();

  const preview = page.getByRole("button", { name: "Open lyrics" });
  await expect(preview).toBeVisible();
  await page.locator("audio").evaluate((audio) => {
    Object.defineProperty(audio, "currentTime", { configurable: true, value: 31 });
    audio.dispatchEvent(new Event("timeupdate"));
  });
  const activeIndex = 6;

  await preview.click();
  await expect(page.locator(`[data-lyric-index="${activeIndex}"]`)).toHaveAttribute("aria-current", "true");
  const fullPlayer = page.locator("section.fixed.inset-0");
  const playerBefore = await fullPlayer.boundingBox();
  expect(playerBefore).not.toBeNull();
  const lyricsSelect = page.getByRole("combobox", { name: "Lyrics" });
  await expect(lyricsSelect).toHaveText("Auto");
  await lyricsSelect.click();
  await expect(page.locator("body")).not.toHaveAttribute("data-scroll-locked");
  const playerAfter = await fullPlayer.boundingBox();
  expect(playerAfter).not.toBeNull();
  expect(Math.abs(playerAfter!.x - playerBefore!.x)).toBeLessThan(0.5);
  expect(Math.abs(playerAfter!.width - playerBefore!.width)).toBeLessThan(0.5);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await lyricsSelect.click();

  const lyricsOptions = page.getByRole("listbox");
  await expect(lyricsOptions.getByRole("option")).toHaveText(["Auto", "lyrics.lrc", "translation.srt"]);
  await lyricsOptions.getByRole("option", { name: "translation.srt", exact: true }).click();
  await expect(lyricsSelect).toHaveText("translation.srt");
});

test("@desktop player keeps speed and compatibility playback under More", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page);
  await seedPlayer(page);
  const mediaRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/media/1/stream" && request.method() === "GET") mediaRequests.push(request.url());
  });
  await page.goto("/");

  await expect
    .poll(() => mediaRequests.some((requestURL) => new URL(requestURL).searchParams.get("forceDirect") === "1"))
    .toBe(true);
  await expect(page.getByRole("button", { name: /Playback speed .* times/ })).toHaveCount(0);
  const more = page.getByRole("button", { name: "More player options" });
  await more.click();
  const speed = page.getByRole("combobox", { name: "Playback speed" });
  const compatibility = page.getByRole("combobox", { name: "Compatibility playback scope" });
  await expect(speed).toHaveText("1×");
  await expect(compatibility).toHaveText("Direct playback");

  await speed.click();
  await page.getByRole("option", { name: "1.25×", exact: true }).click();
  await expect(speed).toHaveText("1.25×");

  await compatibility.click();
  await expect(page.getByRole("listbox", { name: "Compatibility playback scope" }).getByRole("option")).toHaveText([
    "Direct playback",
    "Only current track",
    "Current queue",
    "Always enabled",
  ]);
  await page.getByRole("option", { name: "Only current track", exact: true }).click();
  await expect(compatibility).toHaveText("Only current track");
  await expect
    .poll(() => mediaRequests.some((requestURL) => new URL(requestURL).searchParams.get("forceTranscode") === "1"))
    .toBe(true);

  await compatibility.click();
  await page.getByRole("option", { name: "Current queue", exact: true }).click();
  await expect(compatibility).toHaveText("Current queue");
  await compatibility.click();
  await page.getByRole("option", { name: "Always enabled", exact: true }).click();
  await expect(compatibility).toHaveText("Always enabled");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = `kikoto:player-compatibility:v1:${encodeURIComponent(window.location.origin)}:anonymous`;
        return JSON.parse(localStorage.getItem(key) ?? "null")?.scope;
      }),
    )
    .toBe("always");

  mediaRequests.length = 0;
  await page.reload();
  await expect
    .poll(() => mediaRequests.some((requestURL) => new URL(requestURL).searchParams.get("forceTranscode") === "1"))
    .toBe(true);
  await page.getByRole("button", { name: "More player options" }).click();
  await expect(page.getByRole("combobox", { name: "Compatibility playback scope" })).toHaveText("Always enabled");
  await expect(page.getByRole("button", { name: "Volume" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play", exact: true })).not.toHaveClass(/shadow-primary/);
});

test("@desktop player scrolls overflowing metadata and closes queue options outside the menu", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page);
  const longTitle = "A deliberately long track title that cannot fit inside the compact player or queue row";
  const secondTrack = { ...persistedTrack, queueItemId: "e2e-track-2", locationId: 2, title: "Second queued track" };
  persistedPlayerTracks.set(page, [
    { ...persistedTrack, title: longTitle, workTitle: `${persistedTrack.workTitle} with an extended display name` },
    secondTrack,
  ]);
  await page.addInitScript(
    ({ first, second, baseKey }) => {
      const key = `${baseKey}:${encodeURIComponent(window.location.origin)}:anonymous`;
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          queue: [first, second],
          currentIndex: 0,
          mode: "order",
          playbackRate: 1,
          sleepTimer: null,
        }),
      );
    },
    {
      first: {
        ...persistedTrack,
        title: longTitle,
        workTitle: `${persistedTrack.workTitle} with an extended display name`,
      },
      second: secondTrack,
      baseKey: playerQueueStorageBaseKey,
    },
  );
  await page.goto("/");

  await page.getByRole("button", { name: "Playback queue" }).click();
  const queueMarquee = page.locator(".overflow-marquee--auto", { hasText: longTitle });
  await expect(queueMarquee).toBeVisible();
  await expect(queueMarquee.locator(".overflow-marquee__copy")).toHaveCount(2);
  await expect(queueMarquee.locator(".overflow-marquee__copy").nth(1)).toHaveAttribute("aria-hidden", "true");
  await expect
    .poll(() =>
      queueMarquee
        .locator(".overflow-marquee__track")
        .evaluate((element) => getComputedStyle(element).animationTimingFunction),
    )
    .toBe("linear");
  await page.getByRole("button", { name: `Options for ${longTitle}` }).click();
  await expect(page.getByRole("menuitem", { name: "Move down" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove" })).toBeVisible();
  await page.locator("header").click({ position: { x: 10, y: 10 } });
  await expect(page.getByRole("menuitem", { name: "Remove" })).toBeHidden();

  await page.getByRole("button", { name: "Collapse player" }).click();
  const compactMarquee = page.locator(".overflow-marquee-group", { hasText: longTitle });
  await expect(compactMarquee).toBeVisible();
  await expect(compactMarquee.locator(".overflow-marquee-group__copy")).toHaveCount(2);
  await expect(compactMarquee.locator(".overflow-marquee-group__copy").first()).toContainText("Test circle");
  await expect(compactMarquee).not.toContainText("Tagged mobile work with an extended display name");
  const compactTrack = compactMarquee.locator(".overflow-marquee-group__track");
  await expect(compactTrack).toHaveAttribute("data-marquee-pause-ms", "2500");
  await expect.poll(() => compactTrack.evaluate((element) => element.getAnimations().length)).toBe(1);
  const compactKeyframes = await compactTrack.evaluate(
    (element) =>
      (element.getAnimations()[0]?.effect as KeyframeEffect | null)
        ?.getKeyframes()
        .map((frame) => ({ offset: frame.offset, transform: frame.transform })) ?? [],
  );
  expect(compactKeyframes).toHaveLength(3);
  expect(compactKeyframes[0].transform).toBe(compactKeyframes[1].transform);
  expect(compactKeyframes[1].offset).toBeGreaterThan(0);
});

test("@desktop compact player supports relative drag seeking and global playback shortcuts", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page);
  await seedPlayer(page);
  await page.route(/\/api\/media\/1\/stream(?:\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav(100) }),
  );
  await page.goto("/");
  const audio = page.locator("audio");
  await expect.poll(() => audio.evaluate((element) => element.duration)).toBeGreaterThan(99);
  const seek = page.getByRole("slider", { name: "Seek" });
  await seek.fill("60");
  await expect(seek).toHaveValue("60");
  await audio.evaluate((element) => {
    Object.defineProperty(element, "currentTime", { configurable: true, writable: true, value: 40 });
    element.dispatchEvent(new Event("timeupdate"));
    element.dispatchEvent(new Event("seeked"));
  });
  await expect(seek).toHaveValue("60");
  await audio.evaluate((element) => {
    element.currentTime = 60;
    element.dispatchEvent(new Event("seeked"));
  });

  await page.getByRole("button", { name: "Collapse player" }).click();
  await audio.evaluate((element) => {
    element.currentTime = 40;
    element.dispatchEvent(new Event("timeupdate"));
  });
  await expect.poll(() => audio.evaluate((element) => element.currentTime)).toBeGreaterThan(39);
  const compact = page
    .getByText("Test track", { exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'touch-pan-y')]");
  const box = await compact.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.75, box!.y + box!.height * 0.5, { steps: 4 });
  const scrubOverlay = page.locator('[aria-live="polite"]');
  await expect(scrubOverlay).toBeVisible();
  const scrubDeltaText = await scrubOverlay.textContent();
  const scrubDeltaSeconds = Number(/\+([\d.]+)s/.exec(scrubDeltaText ?? "")?.[1] ?? 0);
  expect(scrubDeltaSeconds).toBeGreaterThan(4.5);
  await page.mouse.up();
  await expect.poll(() => audio.evaluate((element) => element.currentTime)).toBeGreaterThan(44.5);
  await expect(page.locator("section.fixed.inset-0")).toBeHidden();

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => audio.evaluate((element) => element.currentTime)).toBeGreaterThan(53.6);
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  expect(await readScopedPlayerState(page, playerProgressStorageBaseKey)).toBeNull();
});

test("@desktop mini player delays hiding hover actions", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page);
  await seedPlayer(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Collapse player" }).click();
  await page.getByRole("button", { name: "Mini player" }).click();
  const mini = page.locator(".mini-player");
  const compactAction = page.getByRole("button", { name: "Open compact player" });
  await mini.hover();
  await expect.poll(() => compactAction.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");

  await page.mouse.move(0, 0);
  await page.waitForTimeout(350);
  await expect.poll(() => compactAction.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await page.waitForTimeout(700);
  await expect.poll(() => compactAction.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
});

test("@desktop player restores the user's compact dock preference", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page);
  await seedPlayer(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Collapse player" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.playerMode)).toBe("compact");
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.playerMode)).toBe("compact");
});

test("@desktop compact player reserves the final directory action area", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const mediaItems = Array.from({ length: 24 }, (_, index) =>
    mediaFixture(index + 1, `track-${index + 1}.mp3`, `RJ00000000/track-${index + 1}.mp3`, "audio"),
  );
  await mockApplication(page, undefined, false, 1, 0, mediaItems, undefined, { authenticated: true });
  await seedPlayer(page, persistedTrack, 1);
  await page.goto("/RJ00000000");
  await page.getByRole("button", { name: "Collapse player" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.playerMode)).toBe("compact");
  await expect(page.getByTestId("directory-file-row")).toHaveCount(mediaItems.length);

  const compact = page
    .getByText("Test track", { exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'touch-pan-y')]");
  const lastRow = page.getByTestId("directory-file-row").last();
  await expect
    .poll(async () => {
      await page.evaluate(() => window.scrollTo(0, document.scrollingElement?.scrollHeight ?? 0));
      const [compactBox, rowBox] = await Promise.all([compact.boundingBox(), lastRow.boundingBox()]);
      return Boolean(compactBox && rowBox && rowBox.y + rowBox.height < compactBox.y);
    })
    .toBe(true);

  const [compactBox, rowBox, contentPadding, sidebarBox] = await Promise.all([
    compact.boundingBox(),
    lastRow.boundingBox(),
    page.locator(".app-main").evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)),
    page.locator(".app-shell > aside").boundingBox(),
  ]);
  expect(compactBox).not.toBeNull();
  expect(rowBox).not.toBeNull();
  expect(sidebarBox).not.toBeNull();
  expect(contentPadding).toBeGreaterThanOrEqual(120);
  expect(rowBox!.y + rowBox!.height).toBeLessThan(compactBox!.y);
  expect(Math.abs(sidebarBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(sidebarBox!.height - 800)).toBeLessThanOrEqual(1);
  await expect(lastRow.getByRole("button", { name: /More actions for track-24\.mp3/ })).toBeVisible();
});

test("mini player reveals actions on tap, persists its snapped edge, and compact mode reserves page space", async ({
  page,
}) => {
  await mockApplication(page);
  await seedPlayer(page);
  await page.goto("/");

  const padding = await page
    .locator(".app-main")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom));
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
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("kikoto:player-mini-position:v1") ?? "null")?.side))
    .toBe("left");

  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.playerMode)).toBe("mini");
  const restored = await page.locator(".mini-player").boundingBox();
  expect(restored).not.toBeNull();
  expect(restored!.x).toBeLessThanOrEqual(10);
});

test("audio preparation shows a busy control and can be paused before it completes", async ({ page }) => {
  await mockApplication(page);
  await seedPlayer(page);
  let releasePreparation!: () => void;
  const prepared = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  await page.route("**/api/media/1/stream?*", async (route) => {
    await prepared;
    await route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav() });
  });
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByText("Test track", { exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    await expect(pause).toHaveAttribute("aria-busy", "true");
    await pause.click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toHaveAttribute("aria-busy", "false");
    releasePreparation();
    await expect
      .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.readyState))
      .toBeGreaterThanOrEqual(1);
    await expect(page.locator("audio")).toHaveJSProperty("paused", true);
  } finally {
    releasePreparation();
  }
});

test("failed prepared audio retries without repeated compatibility conversion or losing position", async ({ page }) => {
  await mockApplication(page);
  await seedPlayer(page);
  let fail = true;
  const media = silentWav(180);
  const requests: string[] = [];
  await page.route("**/api/media/1/stream?*", async (route) => {
    requests.push(route.request().url());
    if (!fail) {
      await servePreparedAudio(route, media);
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "X-Kikoto-Playback-Delivery": "transcoded" },
      body: '{"code":"media_transcode_unavailable"}',
    });
  });
  await page.goto("/");
  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByRole("button", { name: "Compatibility playback", exact: true })).toHaveCount(0);
  expect(requests.every((url) => !new URL(url).searchParams.has("forceTranscode"))).toBe(true);
  fail = false;
  await retry.click();
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeGreaterThan(0);
  await expect(page.locator("audio")).toHaveJSProperty("error", null);

  await page.locator("audio").evaluate((audio: HTMLAudioElement) => {
    audio.currentTime = 42;
  });
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeGreaterThanOrEqual(42);
  await page.locator("audio").evaluate((audio) => audio.dispatchEvent(new Event("error")));
  await expect(retry).toBeVisible();
  await retry.click();
  await expect
    .poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => !audio.paused && audio.currentTime >= 42))
    .toBe(true);
});

test("replaying the same audio cancels stale failure diagnostics", async ({ page }) => {
  await mockApplication(page);
  await seedPlayer(page);
  const media = silentWav(180);
  let releaseHead!: () => void;
  const headReleased = new Promise<void>((resolve) => {
    releaseHead = resolve;
  });
  let markHeadStarted!: () => void;
  const headStarted = new Promise<void>((resolve) => {
    markHeadStarted = resolve;
  });
  let headAborted = false;
  page.on("requestfailed", (request) => {
    if (request.method() === "HEAD" && new URL(request.url()).pathname === "/api/media/1/stream") {
      headAborted = true;
    }
  });
  await page.route("**/api/media/1/stream?*", async (route) => {
    if (route.request().method() === "HEAD") {
      markHeadStarted();
      await headReleased;
    }
    await servePreparedAudio(route, media);
  });
  try {
    await page.goto("/");
    await page.getByText("Test track", { exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator("audio")).toHaveJSProperty("paused", false);
    await page.locator("audio").evaluate((audio) => audio.dispatchEvent(new Event("error")));
    await headStarted;
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator("audio")).toHaveJSProperty("paused", false);
    releaseHead();
    await expect.poll(() => headAborted).toBe(true);
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Compatibility playback", exact: true })).toHaveCount(0);
  } finally {
    releaseHead();
  }
});

test("failed direct playback offers compatibility before source fallback and the sleep timer survives a reload", async ({
  page,
}) => {
  const mediaRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/media/1/stream") mediaRequests.push(request.url());
  });
  await mockApplication(page, undefined, true);
  await seedPlayer(page, {
    ...persistedTrack,
    locations: [
      ...persistedTrack.locations,
      {
        locationId: 2,
        locationType: "remote_stream",
        streamUrl: "/api/media/2/stream",
        sourceId: 2,
        sourceName: "Remote",
        availability: "remote",
      },
    ],
  });
  await page.goto("/");

  await expect(page.getByText("Playback failed for Test track.")).toBeVisible();
  await expect
    .poll(() => mediaRequests.some((requestURL) => new URL(requestURL).searchParams.get("forceDirect") === "1"))
    .toBe(true);
  await page.getByRole("button", { name: "Compatibility playback", exact: true }).click();
  await expect
    .poll(() => mediaRequests.some((requestURL) => new URL(requestURL).searchParams.get("forceTranscode") === "1"))
    .toBe(true);
  await expect(page.getByText("Playback source failed. Switched to Remote.")).toBeVisible();
  await page.getByText("Test track", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose playback source" })).toContainText("Remote");
  await page.getByRole("button", { name: "Sleep timer" }).click();
  await expect(page.getByRole("button", { name: "30 min" })).toBeVisible();
  await expect(page.getByRole("button", { name: "60 min" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Finish current track" })).toHaveAttribute("data-state", "unchecked");
  const sleepPopover = page
    .getByRole("button", { name: "30 min" })
    .locator("xpath=ancestor::div[contains(@class, 'fixed')]");
  expect((await sleepPopover.boundingBox())!.width).toBeLessThanOrEqual(230);
  await page.getByRole("button", { name: "Custom" }).click();
  const customMinutes = page.getByRole("spinbutton", { name: "Custom sleep minutes" });
  await expect(customMinutes).toBeVisible();
  await customMinutes.fill("75");
  await page.getByRole("button", { name: "Set", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = `kikoto:player-queue:v2:${encodeURIComponent(window.location.origin)}:anonymous`;
        const timer = JSON.parse(localStorage.getItem(key) ?? "null")?.sleepTimer;
        return timer ? Math.round((timer.deadline - Date.now()) / 60_000) : 0;
      }),
    )
    .toBe(75);

  await page.getByRole("button", { name: "Sleep timer" }).click();
  await page.getByText("Test track", { exact: true }).click();
  await expect(page.getByRole("button", { name: "30 min" })).toBeHidden();

  await page.getByRole("button", { name: "Sleep timer" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "30 min" })).toBeHidden();
  await page.getByRole("button", { name: "Sleep timer" }).click();
  await page.getByRole("switch", { name: "Finish current track" }).check();
  await page.getByRole("button", { name: "30 min" }).click();
  await expect
    .poll(async () => (await readScopedPlayerState(page, playerQueueStorageBaseKey))?.sleepTimer?.mode)
    .toBe("deadline");
  await expect
    .poll(async () => (await readScopedPlayerState(page, playerQueueStorageBaseKey))?.sleepTimer?.finishCurrentTrack)
    .toBe(true);

  const restoredPage = await page.context().newPage();
  await mockApplication(restoredPage);
  persistedPlayerTracks.set(restoredPage, [persistedTrack]);
  await restoredPage.goto("/");
  await expect
    .poll(
      async () =>
        (await readScopedPlayerState(restoredPage, playerQueueStorageBaseKey))?.sleepTimer?.deadline > Date.now(),
    )
    .toBe(true);
  await restoredPage.close();
});

test("player restores only the current server and authenticated owner's queue", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  await page.addInitScript(
    ({ track, baseKey }) => {
      const state = JSON.stringify({
        version: 1,
        queue: [track],
        currentIndex: 0,
        mode: "order",
        playbackRate: 1,
        sleepTimer: null,
      });
      const local = encodeURIComponent(window.location.origin);
      localStorage.setItem(baseKey + ":" + local + ":anonymous", state);
      localStorage.setItem(baseKey + ":" + local + ":user-2", state);
      localStorage.setItem(baseKey + ":" + encodeURIComponent("https://other.example.invalid") + ":user-1", state);
    },
    { track: persistedTrack, baseKey: playerQueueStorageBaseKey },
  );
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Account menu", exact: true })).toBeVisible();
  await expect(page.getByText("Test track", { exact: true })).toHaveCount(0);
  await seedPlayer(page, persistedTrack, 1);
  await page.reload();
  await expect(page.getByText("Test track", { exact: true })).toBeVisible();
});
