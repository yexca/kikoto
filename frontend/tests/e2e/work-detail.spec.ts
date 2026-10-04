import { expect, test } from "@playwright/test";
import {
  work,
  playerQueueStorageBaseKey,
  mockApplication,
  persistedTrack,
  readScopedPlayerState,
  mediaFixture,
  seedPlayer,
} from "./fixtures/player-library";
import type { MaintenanceWorkPage, Work, WorkTranslation } from "../../src/lib/api";
import { mediaItemFixture, mediaLocationFixture, workflowRunDetailFixture, workflowRunFixture } from "./fixtures/api";

test("unknown routes and missing work codes render not found states", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/missing-route");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();

  await page.goto("/RJ00000054");
  await expect(page.getByRole("heading", { name: "Work not found" })).toBeVisible();
  await expect(page.getByText("Loading RJ00000054...")).toHaveCount(0);
});

test("detail quick marks preserve the cached directory tree", async ({ page }) => {
  let mediaRequests = 0;
  const mediaItems = [mediaFixture(1, "track.mp3", "RJ00000000/track.mp3", "audio")];
  await mockApplication(page, undefined, false, 1, 0, mediaItems, undefined, {
    authenticated: true,
    onMediaRequest: () => {
      mediaRequests += 1;
    },
  });
  await page.goto("/");

  await page.getByText("Tagged mobile work", { exact: true }).click();
  await expect(page.getByText("track.mp3", { exact: true })).toBeVisible();
  await expect.poll(() => mediaRequests).toBe(1);
  await page.getByRole("button", { name: "Mark: Unmarked" }).click();
  await page.getByRole("button", { name: "Want", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mark: Want" })).toBeVisible();
  await expect(page.getByText("track.mp3", { exact: true })).toBeVisible();
  expect(mediaRequests).toBe(1);

  await page.getByRole("main").getByRole("button", { name: "Library", exact: true }).click();
  await page.getByText("Tagged mobile work", { exact: true }).click();
  await expect(page.getByText("track.mp3", { exact: true })).toBeVisible();
  expect(mediaRequests).toBe(1);
});

test("work detail reserves a structured directory skeleton until media is ready", async ({ page }) => {
  const mediaItems = [mediaFixture(1, "track.mp3", "RJ00000000/track.mp3", "audio")];
  await mockApplication(page, undefined, false, 1, 800, mediaItems, undefined, { authenticated: true });
  await page.goto("/");
  await page.getByText("Tagged mobile work", { exact: true }).click();

  const skeleton = page.getByTestId("directory-skeleton");
  await expect(skeleton).toBeVisible();
  const skeletonBox = await skeleton.boundingBox();
  expect(skeletonBox).not.toBeNull();
  expect(skeletonBox!.height).toBeGreaterThanOrEqual(352);
  await expect(page.getByText("Loading directory...", { exact: true })).toHaveCount(0);

  await expect(page.getByText("track.mp3", { exact: true })).toBeVisible();
  await expect(skeleton).toBeHidden();
});

test("directory database contention preserves loaded work details", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true, mediaBusy: true });
  await page.goto("/");
  await page.getByText("Tagged mobile work", { exact: true }).click();

  await expect(page.getByRole("button", { name: "Mark: Unmarked" })).toBeVisible();
  await expect(page.getByTestId("directory-load-error")).toContainText("The database is busy");
  await expect(page.getByTestId("directory-skeleton")).toBeHidden();
});

test("directory rows wrap long unbroken file names without horizontal overflow", async ({ page }) => {
  const longTitle = `${"very-long-track-name-".repeat(10)}.mp3`;
  const imageTitle = "cover-image-with-a-complete-name.jpg";
  const mediaItems = [
    mediaFixture(1, longTitle, `RJ00000000/${longTitle}`, "audio"),
    mediaItemFixture({
      id: 2,
      kind: "image",
      title: imageTitle,
      sizeBytes: 2048,
      locations: [
        mediaLocationFixture({
          id: 2,
          path: `RJ00000000/${imageTitle}`,
          downloadUrl: "/api/media/2/download",
          sizeBytes: 2048,
        }),
      ],
    }),
  ];
  await mockApplication(page, undefined, false, 1, 0, mediaItems, undefined, { authenticated: true });
  await page.goto("/");
  await page.getByText("Tagged mobile work", { exact: true }).click();

  const fileName = page.getByText(longTitle, { exact: true });
  await expect(fileName).toBeVisible();
  expect(
    await fileName.evaluate((element) => ({
      fits: element.scrollWidth <= element.clientWidth + 1,
      whiteSpace: getComputedStyle(element).whiteSpace,
    })),
  ).toEqual({ fits: true, whiteSpace: "normal" });
  const audioRow = page.getByTestId("directory-file-row").filter({ hasText: longTitle });
  const imageRow = page.getByTestId("directory-file-row").filter({ hasText: imageTitle });
  await expect(audioRow.getByText("0:10", { exact: true })).toBeVisible();
  await expect(imageRow.getByText("2.0 KB", { exact: true })).toBeVisible();
  const [audioTitleBox, audioMetaBox] = await Promise.all([
    fileName.boundingBox(),
    audioRow.getByText("12 B", { exact: true }).boundingBox(),
  ]);
  expect(audioTitleBox).not.toBeNull();
  expect(audioMetaBox).not.toBeNull();
  expect(audioMetaBox!.y).toBeGreaterThan(audioTitleBox!.y);
});

test("directory folds matched lyrics into the audio row while preserving text preview", async ({ page }) => {
  const lyricsWork = { ...work, primaryCode: "RJ00000000", title: "Lyrics attachment work" };
  const mediaItems = [
    mediaFixture(1, "01.mp3", "library/RJ00000000/Main/01.mp3", "audio"),
    mediaFixture(9, "01.lrc", "library/RJ00000000/Main/01.lrc", "text"),
    mediaFixture(10, "notes.txt", "library/RJ00000000/Main/notes.txt", "text"),
  ];
  let preferenceRequest: {
    method: "PUT" | "DELETE";
    audioMediaItemId: number;
    lyricsMediaItemId: number | null;
  } | null = null;
  await mockApplication(page, undefined, false, 1, 0, mediaItems, undefined, {
    work: lyricsWork,
    authenticated: true,
    onLyricsPreference: (method, audioMediaItemId, lyricsMediaItemId) => {
      preferenceRequest = { method, audioMediaItemId, lyricsMediaItemId };
    },
  });
  await page.goto("/");
  await page.getByText(lyricsWork.title, { exact: true }).click();

  await expect(page.getByText("01.lrc", { exact: true })).toHaveCount(0);
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show attached lyrics (1)" })).toBeVisible();

  const audioRow = page.getByTestId("directory-file-row").filter({ hasText: "01.mp3" });
  await expect(audioRow.getByRole("button", { name: "Lyrics for 01.mp3" })).toHaveCount(0);
  await audioRow.getByRole("button", { name: "More actions for 01.mp3" }).click();
  await page.getByRole("menuitem", { name: "Lyrics" }).click();
  const lyricsDialog = page.getByRole("dialog", { name: "Lyrics for 01.mp3" });
  await expect(lyricsDialog.getByRole("radio", { name: /Auto.*Matches 01\.lrc/ })).toBeChecked();
  await lyricsDialog.getByRole("radio", { name: /01\.lrc.*Matching file name/ }).click();
  await expect.poll(() => preferenceRequest).toEqual({ method: "PUT", audioMediaItemId: 1, lyricsMediaItemId: 9 });

  await lyricsDialog.getByRole("button", { name: "Preview" }).click();
  const lyricsViewer = page.getByRole("dialog", { name: "01.lrc" });
  // Timed lyrics open as time-stamped lines, with the file text one toggle away.
  await expect(lyricsViewer.getByText("0:05", { exact: true })).toBeVisible();
  await expect(lyricsViewer.getByText("Second line", { exact: true })).toBeVisible();
  await lyricsViewer.getByRole("button", { name: "Raw text" }).click();
  await expect(lyricsViewer.getByText("[00:05.00]Second line", { exact: false })).toBeVisible();
  await lyricsViewer.getByRole("button", { name: "Close", exact: true }).click();

  await audioRow.click();
  await expect
    .poll(async () => {
      const state = await readScopedPlayerState(page, playerQueueStorageBaseKey, 1);
      return state?.queue?.[0]?.preferredLyricsMediaItemId;
    })
    .toBe(9);

  await audioRow.getByRole("button", { name: "More actions for 01.mp3" }).click();
  await page.getByRole("menuitem", { name: "Lyrics" }).click();
  preferenceRequest = null;
  const queuedLyricsDialog = page.getByRole("dialog", { name: "Lyrics for 01.mp3" });
  await queuedLyricsDialog.getByRole("radio", { name: /Auto.*Matches 01\.lrc/ }).click();
  await expect
    .poll(() => preferenceRequest)
    .toEqual({ method: "DELETE", audioMediaItemId: 1, lyricsMediaItemId: null });
  await expect
    .poll(async () => {
      const state = await readScopedPlayerState(page, playerQueueStorageBaseKey, 1);
      return state?.queue?.[0]?.preferredLyricsMediaItemId;
    })
    .toBeNull();
  await queuedLyricsDialog.getByRole("button", { name: "Show in directory" }).click();
  await expect(page.getByText("01.lrc", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 800, height: 800 });
  await expect(audioRow.getByRole("button", { name: "Lyrics for 01.mp3" })).toHaveCount(0);
  await audioRow.getByRole("button", { name: "More actions for 01.mp3" }).click();
  await expect(page.getByRole("menuitem", { name: "Lyrics" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(audioRow.getByRole("button", { name: "Lyrics for 01.mp3" })).toBeVisible();

  await page.getByText("notes.txt", { exact: true }).click();
  await expect(page.getByText("Synthetic notes", { exact: true })).toBeVisible();
});

const imageFixture = (id: number, title: string, folder = "Images") =>
  mediaItemFixture({
    id,
    kind: "image",
    title,
    sizeBytes: 2048,
    locations: [mediaLocationFixture({ id, path: `RJ00000000/${folder}/${title}`, sizeBytes: 2048 })],
  });

test("image viewer steps through the folder's images and confirms a cover change", async ({ page }) => {
  const mediaItems = [
    mediaFixture(1, "01.mp3", "RJ00000000/Main/01.mp3", "audio"),
    imageFixture(2, "cover.jpg"),
    imageFixture(3, "variant.png"),
  ];
  await mockApplication(page, undefined, false, 1, 0, mediaItems, undefined, { authenticated: true });
  const coverOverrides: unknown[] = [];
  await page.route("**/api/works/*/cover-override", (route) => {
    coverOverrides.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  await page.goto("/RJ00000000");
  await page.getByRole("button", { name: "Show folders" }).click();
  await page
    .getByRole("dialog", { name: "Folders" })
    .getByRole("button", { name: /^Images/ })
    .click();
  await page.getByTestId("directory-file-row").filter({ hasText: "cover.jpg" }).click();

  const viewer = page.getByRole("dialog", { name: "cover.jpg" });
  await expect(viewer.getByText("1 / 2", { exact: true })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  const nextViewer = page.getByRole("dialog", { name: "variant.png" });
  await expect(nextViewer.getByText("2 / 2", { exact: true })).toBeVisible();
  await nextViewer.getByRole("button", { name: "cover.jpg", exact: true }).click();
  const coverViewer = page.getByRole("dialog", { name: "cover.jpg" });

  // Replacing the cover takes a second click, and stepping away withdraws the first.
  await coverViewer.getByRole("button", { name: "Set cover", exact: true }).click();
  await expect(coverViewer.getByRole("button", { name: "Confirm cover", exact: true })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await coverViewer.getByRole("button", { name: "Set cover", exact: true }).click();
  expect(coverOverrides).toEqual([]);
  await coverViewer.getByRole("button", { name: "Confirm cover", exact: true }).click();
  await expect.poll(() => coverOverrides).toEqual([{ locationId: 2 }]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("@desktop file viewer opens above the floating full player", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mediaItems = [mediaFixture(1, "track.mp3", "RJ00000000/track.mp3", "audio"), imageFixture(2, "cover.jpg", "")];
  await mockApplication(page, undefined, false, 1, 0, mediaItems, undefined, { authenticated: true });
  await seedPlayer(page, persistedTrack, 1);
  await page.goto("/RJ00000000");

  const fullPlayer = page.locator('[data-player-surface="full"]');
  await expect(fullPlayer).toBeVisible();
  await page.getByTestId("directory-file-row").filter({ hasText: "cover.jpg" }).click();
  await expect(page.getByRole("dialog", { name: "cover.jpg" })).toBeVisible();
  const box = await fullPlayer.boundingBox();
  expect(box).not.toBeNull();
  const viewerOnTop = await page.evaluate(
    ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest("[role='dialog']")),
    { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
  );
  expect(viewerOnTop).toBe(true);
});

test("mobile directory breadcrumbs collapse long ancestors without losing navigation", async ({ page }) => {
  const first = "First folder with a deliberately long descriptive name";
  const second = "Second folder with another deliberately long descriptive name";
  const current = "Current folder with an especially long descriptive suffix CHI_HANS";
  const mediaItems = [
    mediaFixture(1, "root-note.txt", `RJ00000000/root-note.txt`, "file"),
    mediaFixture(2, "first-note.txt", `RJ00000000/${first}/first-note.txt`, "file"),
    mediaFixture(3, "second-note.txt", `RJ00000000/${first}/${second}/second-note.txt`, "file"),
    mediaFixture(4, "track.mp3", `RJ00000000/${first}/${second}/${current}/track.mp3`, "audio"),
  ];
  await mockApplication(page, undefined, false, 1, 0, mediaItems, undefined, { authenticated: true });
  await page.goto("/");
  await page.getByText("Tagged mobile work", { exact: true }).click();
  await page.getByRole("button", { name: "root", exact: true }).click();
  await page.getByText(first, { exact: true }).click();
  await page.getByText(second, { exact: true }).click();
  await page.getByText(current, { exact: true }).click();

  const breadcrumb = page.getByTestId("directory-breadcrumb");
  const currentSegment = page.getByTestId("directory-breadcrumb-current");
  await expect(currentSegment).toHaveAttribute("title", current);
  await expect(currentSegment).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Show 2 parent folders" })).toBeVisible();
  expect((await breadcrumb.boundingBox())!.height).toBeLessThanOrEqual(44);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
  ).toBe(true);

  await page.getByRole("button", { name: "Show 2 parent folders" }).click();
  const parentMenu = page.getByRole("menu", { name: "Parent folder" });
  await expect(parentMenu.getByRole("menuitem", { name: first, exact: true })).toBeVisible();
  await parentMenu.getByRole("menuitem", { name: second, exact: true }).click();
  await expect(page.getByTestId("directory-breadcrumb-current")).toHaveAttribute("title", second);
});

const folderNavigatorMedia = () => [
  mediaFixture(1, "01.mp3", "RJ00000000/Main/With SE/01.mp3", "audio"),
  mediaFixture(2, "02.mp3", "RJ00000000/Main/With SE/02.mp3", "audio"),
  mediaFixture(3, "01.mp3", "RJ00000000/Main/Without SE/01.mp3", "audio"),
  mediaFixture(4, "bonus.mp3", "RJ00000000/Bonus/bonus.mp3", "audio"),
  mediaFixture(5, "notes.txt", "RJ00000000/notes.txt", "text"),
];

test("mobile folder sheet switches folders and returns to the recommended folder", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, folderNavigatorMedia(), undefined, { authenticated: true });
  await page.goto("/");
  await page.getByText("Tagged mobile work", { exact: true }).click();

  const currentFolder = page.getByTestId("directory-breadcrumb-current");
  await expect(currentFolder).toHaveText("With SE");
  await expect(page.getByText("Recommended", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Show folders" }).click();
  const sheet = page.getByRole("dialog", { name: "Folders" });
  await expect(sheet.getByRole("button", { name: /^With SE/ })).toHaveAttribute("aria-current", "location");
  await sheet.getByRole("button", { name: /^Bonus/ }).click();
  await expect(sheet).toBeHidden();
  await expect(currentFolder).toHaveText("Bonus");
  await expect(page.getByText("bonus.mp3", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Go to recommended folder" }).click();
  await expect(currentFolder).toHaveText("With SE");
});

test("@desktop folder rail navigates the work and marks the resume track", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mediaItems = folderNavigatorMedia();
  mediaItems[1] = {
    ...mediaItems[1],
    progress: { positionSeconds: 6, durationSeconds: 10, completed: false, lastPlayedAt: "2026-01-01 00:00:00" },
  };
  await mockApplication(page, undefined, false, 1, 0, mediaItems, undefined, { authenticated: true });
  await page.goto("/RJ00000000");

  const rail = page.getByRole("navigation", { name: "Folders" });
  await expect(rail.getByRole("button", { name: /^With SE/ })).toHaveAttribute("aria-current", "location");
  const resumeRow = page.getByTestId("directory-file-row").filter({ hasText: "02.mp3" });
  await expect(resumeRow.getByText("0:04 left", { exact: true })).toBeVisible();

  await rail.getByRole("button", { name: "Collapse Main" }).click();
  await expect(rail.getByRole("button", { name: /^With SE/ })).toHaveCount(0);

  await rail.getByRole("button", { name: "Work root", exact: true }).click();
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Play Bonus", exact: true }).click();
  await expect
    .poll(async () => {
      const state = await readScopedPlayerState(page, playerQueueStorageBaseKey, 1);
      return state?.queue?.map((track: { mediaItemId: number }) => track.mediaItemId);
    })
    .toEqual([4]);
});

test("work detail summarizes DLsite stats in the hero and groups active source information", async ({ page }) => {
  const mediaItems = [
    mediaItemFixture({
      id: 1,
      title: "track.mp3",
      trackNo: 1,
      durationSeconds: 90,
      sizeBytes: 2048,
      locations: [
        mediaLocationFixture({
          id: 1,
          fileSourceName: "Main local library",
          path: "RJ00000000/track.mp3",
          streamUrl: "/api/media/1/stream",
          sizeBytes: 2048,
          durationSeconds: 90,
        }),
      ],
    }),
  ];
  await mockApplication(page, undefined, false, 1, 0, mediaItems, undefined, { authenticated: true });
  await page.goto("/");
  await page.getByText("Tagged mobile work", { exact: true }).click();
  await page.getByRole("button", { name: "Info", exact: true }).click();

  const dlsiteInfo = page.getByTestId("dlsite-info");
  await expect(dlsiteInfo.getByText("Rate", { exact: true })).toBeVisible();
  await expect(dlsiteInfo.getByText("Age", { exact: true })).toBeVisible();
  await expect(dlsiteInfo.getByText("Sales", { exact: true })).toBeVisible();
  await expect(dlsiteInfo.getByText("Released", { exact: true })).toBeVisible();
  await expect(dlsiteInfo.getByText("Duration", { exact: true })).toBeVisible();
  // Mobile keeps every hero stat on one row.
  const statTops = await dlsiteInfo
    .locator("dt")
    .evaluateAll((labels) => labels.map((label) => Math.round(label.getBoundingClientRect().top)));
  expect(new Set(statTops).size).toBe(1);
  const sourceInfo = page.getByTestId("active-source-info");
  await expect(sourceInfo.getByText("Source info", { exact: true })).toBeVisible();
  await expect(sourceInfo.getByText("Main local library", { exact: true })).toBeVisible();
  await expect(sourceInfo.getByText("Playable duration", { exact: true })).toBeVisible();
  await expect(sourceInfo.getByText("1m", { exact: true })).toBeVisible();
  await expect(page.getByTestId("source-info-audio-row")).toContainText(
    "Playable1Playable duration1m(All playable durations measured)",
  );
  await expect(page.getByTestId("source-info-files-row")).toContainText("Files1Size2.0 KB(All file sizes measured)");
  const sourcePrimaryMetrics = page.locator("[data-source-primary-metrics]");
  await expect(sourcePrimaryMetrics).toHaveCount(2);
  expect(
    await sourcePrimaryMetrics.evaluateAll((elements) =>
      elements.every((element) => element.getBoundingClientRect().height <= 18),
    ),
  ).toBe(true);
});

test("work detail prompts for missing metadata and refreshes after sync completes", async ({ page }) => {
  const metadataSyncControl = {
    runId: 77,
    status: "queued" as const,
    detailReady: false,
    postRequests: 0,
    statusRequests: 0,
    detailRequests: 0,
  };
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "playback:use", "metadata:sync"],
    detailMetadataSync: { status: "not_synced", checkedAt: "" },
    metadataSyncControl,
  });
  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await page.getByRole("button", { name: "Info", exact: true }).click();

  await expect(page.getByTestId("metadata-sync-notice")).toContainText("Metadata has not been synced yet.");
  const syncButton = page.getByRole("button", { name: "Metadata refresh", exact: true });
  await expect(syncButton).toBeVisible();
  const initialDetailRequests = metadataSyncControl.detailRequests;
  const syncRequest = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/api/works/1/metadata-sync"),
  );
  await syncButton.click();
  await syncRequest;
  await expect.poll(() => metadataSyncControl.postRequests).toBe(1);

  await expect.poll(() => metadataSyncControl.statusRequests).toBeGreaterThan(0);
  await expect.poll(() => metadataSyncControl.detailRequests).toBeGreaterThan(initialDetailRequests);
  await expect(page.getByRole("group", { name: "Metadata language", exact: true })).toContainText("Japanese");
  await expect(page.getByTestId("metadata-sync-notice")).toHaveCount(0);
});

test("local work detail lists Origin first and expands from local to all editions", async ({ page }) => {
  const detailTranslations: WorkTranslation[] = [
    {
      workId: 1,
      primaryCode: "RJ00000000",
      title: "Origin",
      metadataLanguage: "JPN",
      editionLabel: "Japanese",
      origin: true,
      official: false,
      translationKind: "origin",
      current: true,
      hasMedia: true,
      mediaState: "indexed_available",
      localAvailable: true,
    },
    {
      workId: 2,
      primaryCode: "RJ00000001",
      title: "English local",
      metadataLanguage: "ENG",
      editionLabel: "English",
      origin: false,
      official: true,
      translationKind: "official",
      current: false,
      hasMedia: false,
      mediaState: "present_unindexed",
      localAvailable: true,
    },
    {
      workId: 3,
      primaryCode: "RJ00000002",
      title: "Chinese remote",
      metadataLanguage: "CHI_HANS",
      editionLabel: "Simplified Chinese",
      origin: false,
      official: true,
      translationKind: "official",
      current: false,
      hasMedia: true,
      mediaState: "indexed_available",
      localAvailable: false,
    },
    {
      workId: null,
      primaryCode: "RJ00000003",
      title: "Korean metadata",
      metadataLanguage: "KO_KR",
      editionLabel: "Korean",
      origin: false,
      official: false,
      translationKind: "unknown",
      current: false,
      hasMedia: false,
      mediaState: "metadata_only",
      localAvailable: false,
    },
  ];
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    detailTranslations,
    detailMetadataPresentation: {
      defaultVariantKey: "english-metadata",
      variants: [
        { key: "english-metadata", language: "en-us", title: "English title", tags: [], origin: false },
        { key: "origin-metadata", language: "ja-jp", title: "Origin title", tags: [], origin: true },
      ],
    },
  });
  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();

  const metadataTrigger = page.getByRole("button", { name: "Metadata language", exact: true });
  await expect(metadataTrigger).toContainText("English");
  await metadataTrigger.click();
  const metadataLanguages = page
    .getByRole("dialog", { name: "Metadata language", exact: true })
    .getByRole("menu", { name: "Metadata language", exact: true });
  await expect(metadataLanguages.getByRole("menuitemradio").first()).toHaveText("Original · Japanese");
  await expect(metadataLanguages.getByRole("menuitemradio", { name: "English", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");

  const editionTrigger = page.getByRole("button", { name: "Directory edition", exact: true });
  await expect(editionTrigger).toHaveText("Origin · Japanese");
  await editionTrigger.click();
  const versionMenu = page.getByRole("dialog", { name: "Directory edition", exact: true });
  await expect(versionMenu.getByRole("group", { name: "Japanese versions" })).toBeVisible();
  await expect(versionMenu.getByRole("group", { name: "English versions" })).toBeVisible();
  await expect(versionMenu.getByRole("group", { name: "Simplified Chinese versions" })).toHaveCount(0);
  await expect(versionMenu.getByRole("group", { name: "Korean versions" })).toHaveCount(0);
  await versionMenu.getByRole("button", { name: "Show all 2 editions", exact: true }).click();
  await expect(versionMenu.getByRole("group", { name: "Simplified Chinese versions" })).toBeVisible();
  await expect(versionMenu.getByRole("group", { name: "Korean versions" })).toBeVisible();

  await expect(
    versionMenu
      .getByRole("menu", { name: "Simplified Chinese DLsite codes", exact: true })
      .getByRole("menuitemradio", { name: /RJ00000002 Official Remote only/ }),
  ).toBeDisabled();
});

test("local work detail stays loading while an automatically selected local edition is opening", async ({ page }) => {
  let releaseEdition: () => void = () => undefined;
  let reportEditionRequest: () => void = () => undefined;
  const editionGate = new Promise<void>((resolve) => {
    releaseEdition = resolve;
  });
  const editionRequested = new Promise<void>((resolve) => {
    reportEditionRequest = resolve;
  });
  const detailTranslations: WorkTranslation[] = [
    {
      workId: 1,
      primaryCode: "RJ00000000",
      title: "Origin",
      metadataLanguage: "JPN",
      editionLabel: "Japanese",
      origin: true,
      official: false,
      translationKind: "origin",
      current: true,
      hasMedia: false,
      mediaState: "metadata_only",
      localAvailable: false,
    },
    {
      workId: 2,
      primaryCode: "RJ00000001",
      title: "English local",
      metadataLanguage: "ENG",
      editionLabel: "English",
      origin: false,
      official: true,
      translationKind: "official",
      current: false,
      hasMedia: false,
      mediaState: "present_unindexed",
      localAvailable: true,
    },
  ];
  await mockApplication(
    page,
    undefined,
    false,
    1,
    0,
    [mediaFixture(201, "translated.mp3", "RJ00000001/translated.mp3", "audio")],
    undefined,
    {
      detailTranslations,
      beforeWorkDetailResponse: async (workId) => {
        if (workId !== 2) return;
        reportEditionRequest();
        await editionGate;
      },
    },
  );
  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await editionRequested;

  await expect(page.getByTestId("directory-skeleton")).toBeVisible();
  await expect(page.getByText("No local files detected.", { exact: true })).toHaveCount(0);

  releaseEdition();
  await expect(page.getByText("translated.mp3", { exact: true })).toBeVisible();
});

test("mobile work detail keeps tags in the hero and work-code utilities together", async ({ page }) => {
  const detailWork: Work = {
    ...work,
    dlsiteUrl: "https://example.invalid/work/RJ00000000",
    tags: ["Example tag"],
    userTags: [{ id: 1, name: "Personal tag", color: "" }],
    voiceActors: ["Example Voice"],
    voiceCredits: [{ personId: 7, displayName: "Example Voice" }],
  };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          localStorage.setItem("kikoto:e2e-copied-work-code", value);
          return Promise.resolve();
        },
      },
    });
  });
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true, work: detailWork });
  await page.goto("/");
  await page.getByText(detailWork.title, { exact: true }).click();

  const workCodeActions = page.getByRole("group", { name: "Work code actions" });
  const copyWorkCode = workCodeActions.getByRole("button", { name: `Copy work code ${detailWork.primaryCode}` });
  await expect(copyWorkCode).toBeVisible();
  await expect(
    workCodeActions.getByRole("link", { name: `Open DLsite for ${detailWork.primaryCode}` }),
  ).toHaveAttribute("href", detailWork.dlsiteUrl);
  await expect(page.getByTestId("hero-actions").getByRole("link", { name: /Open DLsite/ })).toHaveCount(0);

  await copyWorkCode.click();
  await expect(page.getByText(`Copied ${detailWork.primaryCode}.`, { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("kikoto:e2e-copied-work-code")))
    .toBe(detailWork.primaryCode);

  const detail = page.getByRole("main");
  await expect(detail.getByRole("button", { name: "Example Voice", exact: true })).toBeVisible();
  // Provider tags and personal tags share one hero row, with personal tags after provider tags.
  const providerTag = detail
    .getByRole("list", { name: "Tags", exact: true })
    .getByRole("button", { name: "Example tag" });
  const personalTag = detail.getByRole("list", { name: "My tags", exact: true }).getByText("Personal tag");
  await expect(providerTag).toBeVisible();
  await expect(personalTag).toBeVisible();
  await expect(detail.getByRole("button", { name: "Edit tags", exact: true })).toBeVisible();
  const [providerTagBox, personalTagBox, statsBox] = await Promise.all([
    providerTag.boundingBox(),
    personalTag.boundingBox(),
    detail.getByTestId("dlsite-info").boundingBox(),
  ]);
  expect(providerTagBox).not.toBeNull();
  expect(personalTagBox).not.toBeNull();
  expect(statsBox).not.toBeNull();
  expect(
    personalTagBox!.y > providerTagBox!.y ||
      (personalTagBox!.y === providerTagBox!.y && personalTagBox!.x > providerTagBox!.x),
  ).toBe(true);
  expect(statsBox!.y).toBeGreaterThan(personalTagBox!.y);

  await page.getByRole("button", { name: "Info", exact: true }).click();
  await expect(detail.getByTestId("active-source-info")).toBeVisible();
});

test("metadata refresh failures open the canonical run-scoped recovery list", async ({ page }) => {
  const control = {
    runId: 77,
    status: "failed" as const,
    detailReady: false,
    postRequests: 0,
    detailRequests: 0,
    statusRequests: 0,
  };
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "metadata:sync", "workflows:run"],
    detailMetadataSync: { status: "not_synced", checkedAt: "" },
    metadataSyncControl: control,
  });
  await page.route("**/api/workflow-runs/77", (route) =>
    route.fulfill({
      json: workflowRunDetailFixture(
        workflowRunFixture({
          id: 77,
          workflowCode: "metadata_family_sync",
          displayName: "Refresh metadata",
          status: "failed",
        }),
        { metadataIssues: { encountered: 1, pending: 1 } },
      ),
    }),
  );
  await page.route("**/api/maintenance/works?*", (route) =>
    route.fulfill({ json: { works: [], page: 1, pageSize: 25, total: 0 } satisfies MaintenanceWorkPage }),
  );
  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await page.getByRole("button", { name: "Info", exact: true }).click();
  await page.getByRole("button", { name: "Metadata refresh", exact: true }).click();
  await page.getByRole("button", { name: "Open metadata issues", exact: true }).click();
  await expect(page).toHaveURL(/\/metadata\?reason=metadata&metadataRun=77$/);
  await expect(page.getByRole("heading", { name: "Metadata", exact: true })).toBeVisible();
});
