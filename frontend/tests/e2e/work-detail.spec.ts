import { expect, test } from "@playwright/test";
import {
  work,
  playerQueueStorageBaseKey,
  mockApplication,
  readScopedPlayerState,
  mediaFixture,
} from "./fixtures/player-library";
import type { WorkTranslation } from "../../src/lib/api";

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
  const mediaItems = [
    {
      id: 1,
      parentId: null,
      kind: "audio",
      title: "track.mp3",
      discNo: null,
      trackNo: 1,
      durationSeconds: 10,
      sizeBytes: 12,
      locations: [
        {
          id: 1,
          fileSourceId: 1,
          fileSourceCode: "local",
          fileSourceName: "Local",
          locationType: "local",
          path: "RJ00000000/track.mp3",
          streamUrl: "/api/media/1/stream",
          downloadUrl: "",
          remoteHash: "",
          sizeBytes: 12,
          durationSeconds: 10,
          availability: "available",
          lastCheckedAt: null,
        },
      ],
    },
  ];
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
    {
      id: 1,
      parentId: null,
      kind: "audio",
      title: longTitle,
      discNo: null,
      trackNo: 1,
      durationSeconds: 10,
      sizeBytes: 12,
      locations: [
        {
          id: 1,
          fileSourceId: 1,
          fileSourceCode: "local",
          fileSourceName: "Local",
          locationType: "local",
          path: `RJ00000000/${longTitle}`,
          streamUrl: "/api/media/1/stream",
          downloadUrl: "",
          remoteHash: "",
          sizeBytes: 12,
          durationSeconds: 10,
          availability: "available",
          lastCheckedAt: null,
        },
      ],
    },
    {
      id: 2,
      parentId: null,
      kind: "image",
      title: imageTitle,
      discNo: null,
      trackNo: null,
      durationSeconds: null,
      sizeBytes: 2048,
      locations: [
        {
          id: 2,
          fileSourceId: 1,
          fileSourceCode: "local",
          fileSourceName: "Local",
          locationType: "local",
          path: `RJ00000000/${imageTitle}`,
          streamUrl: "",
          downloadUrl: "/api/media/2/download",
          remoteHash: "",
          sizeBytes: 2048,
          durationSeconds: null,
          availability: "available",
          lastCheckedAt: null,
        },
      ],
    },
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
  await expect(audioRow.getByText("Audio · 0:10 · 12 B", { exact: true })).toBeVisible();
  await expect(imageRow.getByText("Image · 2.0 KB", { exact: true })).toBeVisible();
  const [audioTitleBox, audioMetaBox] = await Promise.all([
    fileName.boundingBox(),
    audioRow.getByText("Audio · 0:10 · 12 B", { exact: true }).boundingBox(),
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
  await expect(page.getByText("First line", { exact: false })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();

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

test("work detail groups DLsite and active source information", async ({ page }) => {
  const mediaItems = [
    {
      id: 1,
      parentId: null,
      kind: "audio",
      title: "track.mp3",
      discNo: null,
      trackNo: 1,
      durationSeconds: 90,
      sizeBytes: 2048,
      locations: [
        {
          id: 1,
          fileSourceId: 1,
          fileSourceCode: "local",
          fileSourceName: "Main local library",
          locationType: "local",
          path: "RJ00000000/track.mp3",
          streamUrl: "/api/media/1/stream",
          downloadUrl: "",
          remoteHash: "",
          sizeBytes: 2048,
          durationSeconds: 90,
          availability: "available",
          lastCheckedAt: null,
        },
      ],
    },
  ];
  await mockApplication(page, undefined, false, 1, 0, mediaItems, undefined, { authenticated: true });
  await page.goto("/");
  await page.getByText("Tagged mobile work", { exact: true }).click();
  await page.getByRole("button", { name: "Info", exact: true }).click();

  await expect(page.getByText("DLsite info", { exact: true })).toHaveCount(1);
  const dlsiteInfo = page.getByTestId("dlsite-info");
  await expect(dlsiteInfo.getByText("Rate", { exact: true })).toBeVisible();
  await expect(dlsiteInfo.getByText("Age", { exact: true })).toBeVisible();
  await expect(dlsiteInfo.getByText("Sales", { exact: true })).toBeVisible();
  expect(
    await page.getByTestId("dlsite-primary-metrics").evaluate((element) => element.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(18);
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
  await expect(page.getByText("Metadata language", { exact: true })).toBeVisible();
  await expect(page.getByText("Japanese", { exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "Info", exact: true }).click();

  const metadataSelect = page.getByRole("combobox", { name: "Metadata language" });
  await expect(metadataSelect).toHaveText("English");
  await metadataSelect.click();
  const metadataListbox = page.getByRole("listbox");
  await expect(metadataListbox.getByRole("option").first()).toHaveText("Original · Japanese");
  await page.keyboard.press("Escape");

  await expect(page.getByRole("group", { name: "Japanese versions" })).toBeVisible();
  await expect(page.getByRole("group", { name: "English versions" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Simplified Chinese versions" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Korean versions" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show all 2 editions", exact: true }).click();
  await expect(page.getByRole("group", { name: "Simplified Chinese versions" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Korean versions" })).toBeVisible();

  const chineseVersions = page.getByRole("group", { name: "Simplified Chinese versions" });
  await chineseVersions.getByRole("button", { name: "Choose Simplified Chinese DLsite code", exact: true }).click();
  await expect(
    page
      .getByRole("menu", { name: "Simplified Chinese DLsite codes", exact: true })
      .getByRole("menuitemradio", { name: /RJ00000002 Official Remote only/ }),
  ).toBeDisabled();
});

test("local work detail stays loading while an automatically selected local edition is opening", async ({ page }) => {
  let releaseEdition = () => undefined;
  let reportEditionRequest = () => undefined;
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

test("mobile work detail orders Info sections and keeps work-code utilities together", async ({ page }) => {
  const detailWork = {
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

  await page.getByRole("button", { name: "Info", exact: true }).click();
  const sections = [
    page.getByText("Voice actors", { exact: true }),
    page.getByText("Tags", { exact: true }),
    page.getByText("My tags", { exact: true }),
    page.getByText("Metadata language", { exact: true }),
    page.getByTestId("dlsite-info"),
    page.getByTestId("active-source-info"),
  ];
  const positions = await Promise.all(
    sections.map(async (section) => {
      await expect(section).toHaveCount(1);
      return (await section.boundingBox())?.y ?? -1;
    }),
  );
  expect(positions.every((position, index) => index === 0 || positions[index - 1] < position)).toBe(true);
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
      json: {
        id: 77,
        workflowCode: "metadata_family_sync",
        status: "failed",
        summaryJson: "{}",
        nodeRuns: [],
        metadataIssues: { encountered: 1, pending: 1, resolved: 0 },
      },
    }),
  );
  await page.route("**/api/maintenance/works?*", (route) =>
    route.fulfill({ json: { works: [], page: 1, pageSize: 25, total: 0 } }),
  );
  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await page.getByRole("button", { name: "Info", exact: true }).click();
  await page.getByRole("button", { name: "Metadata refresh", exact: true }).click();
  await page.getByRole("button", { name: "Open metadata issues", exact: true }).click();
  await expect(page).toHaveURL(/\/metadata\?reason=metadata&metadataRun=77$/);
  await expect(page.getByRole("heading", { name: "Metadata", exact: true })).toBeVisible();
});
