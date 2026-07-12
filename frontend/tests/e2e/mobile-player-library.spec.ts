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
  voiceCredits: [],
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

async function mockApplication(
  page: Page,
  onWorksRequest?: (url: URL) => void,
  failLocalAudio = false,
  workCount = 1,
  mediaDelayMs = 0,
  mediaItems: Record<string, unknown>[] = [],
  onCleanup?: (body: Record<string, unknown>) => void,
) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { authenticated: false } });
      return;
    }
    if (url.pathname === "/api/works/1/user-state" && route.request().method() === "PATCH") {
      await route.fulfill({ status: 401, json: { error: "login required" } });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/favorite-lists") {
	  await route.fulfill({ json: [{ id: 1, name: "Favorites", description: "", sortOrder: 0 }] });
	  return;
	}
	if (url.pathname === "/api/works/1/favorite-lists") {
	  await route.fulfill({ json: [{ id: 1, name: "Favorites", description: "", sortOrder: 0, selected: false }] });
	  return;
	}
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: { cacheEnabled: false, directoryRoutingRules: [] } });
      return;
    }
    if (url.pathname === "/api/works") {
      onWorksRequest?.(url);
      const works = Array.from({ length: workCount }, (_, index) => index === 0 ? work : {
        ...work,
        id: index + 1,
        primaryCode: `RJ${String(9999999 + index).padStart(8, "0")}`,
        title: `Mobile work ${index + 1}`,
      });
      await route.fulfill({ json: { works, page: 1, pageSize: 24, total: works.length } });
      return;
    }
    const detailMatch = url.pathname.match(/^\/api\/works\/(\d+)$/);
    if (detailMatch) {
      const id = Number(detailMatch[1]);
      const detailWork = id === 1 ? work : { ...work, id, primaryCode: `RJ${String(9999998 + id).padStart(8, "0")}`, title: `Mobile work ${id}` };
      await route.fulfill({ json: {
        ...detailWork,
        baseCode: "", metadataLanguage: "JPN", workType: "audio", titleKana: "", description: "", ageRating: "", durationSeconds: null,
        dlsiteFetchedAt: "", voiceCredits: [], translations: [], manualOverrides: {}, mediaItems,
      } });
      return;
    }
    const mediaMatch = url.pathname.match(/^\/api\/works\/(\d+)\/media$/);
    if (mediaMatch) {
      if (mediaDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, mediaDelayMs));
      await route.fulfill({ json: { workId: Number(mediaMatch[1]), mediaItems } });
      return;
    }
    if (url.pathname === "/api/media/cleanup" && route.request().method() === "POST") {
      onCleanup?.(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 202, json: { runId: 41, jobId: 42, status: "queued", queued: 2 } });
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
      await route.fulfill({ json: { path: "lyrics.lrc", content: "[00:00.00]First line\n[00:05.00]Second line\n[00:10.00]Third line\n[00:15.00]Fourth line\n[00:20.00]Fifth line\n[00:25.00]Sixth line\n[00:30.00]Seventh line\n[00:35.00]Eighth line" } });
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

async function mockRemoteSource(page: Page, onRemoteRequest: (url: URL) => void, options: { conflict?: boolean; onFetchPlan?: (body: Record<string, unknown>) => void } = {}) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ json: { authenticated: false } });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({ json: [{ id: 1, code: "example_remote", displayName: "Example Remote", sourceType: "kikoeru_compatible", enabled: true, cacheEnabled: true }] });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: { cacheEnabled: false, directoryRoutingRules: [] } });
      return;
    }
    if (url.pathname === "/api/works") {
      await route.fulfill({ json: { works: [work], page: 1, pageSize: 24, total: 1 } });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works") {
      onRemoteRequest(url);
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      const sort = url.searchParams.get("sort") ?? "recent";
      await route.fulfill({
        json: {
          sourceId: 1,
          page: pageNumber,
          pageSize: 24,
          total: 30,
          status: "ok",
          sort,
          direction: url.searchParams.get("direction") ?? "desc",
          sortApplied: true,
          works: [{
            remoteId: String(pageNumber),
            primaryCode: pageNumber === 1 ? "RJ09999991" : "RJ09999992",
            remoteCode: pageNumber === 1 ? "RJ09999991" : "RJ09999992",
            title: pageNumber === 1 ? "Remote Japanese work" : "Remote page two work",
            releaseDate: "2026-04-03",
            updatedAt: "2026-04-03",
            coverUrl: "",
            circle: "Remote circle",
            rating: 4.5,
            sales: 100,
            tags: ["退廃/背徳/インモラル"],
            importStatus: "remote_only",
            remotePlayable: true,
            workId: null,
            favorite: false,
            listeningStatus: "none",
          }],
        },
      });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works/RJ09999991" && route.request().method() === "GET") {
      await route.fulfill({ json: {
        sourceId: 1, sourceCode: "example_remote", sourceName: "Example Remote", remoteId: "1",
        primaryCode: "RJ09999991", remoteCode: "RJ09999991", title: "Remote Japanese work", coverUrl: "", sourceUrl: "",
        circle: "Remote circle", rating: 4.5, sales: 100, ageRating: "", releaseDate: "2026-04-03", durationSeconds: null,
        tags: [], voiceActors: [], importStatus: "remote_only", workId: null,
        tracks: [{ type: "audio", title: "track.mp3", hash: "hash", streamUrl: "/stream", downloadUrl: "/download", durationSeconds: 10, sizeBytes: 12, cacheLocationId: null, cachePath: "", cacheAvailable: false, localLocationId: null, localPath: "", localAvailable: false, children: [] }],
      } });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works/RJ09999991/fetch-plan") {
      const requestBody = route.request().postDataJSON() as { decisions?: Array<{ sourceId?: number; resolution?: string; targetPath?: string }> };
      options.onFetchPlan?.(requestBody as Record<string, unknown>);
      const decision = requestBody.decisions?.[0];
      const unresolvedConflict = Boolean(options.conflict && (!decision?.resolution || decision.resolution === "auto"));
      const keepBoth = decision?.resolution === "keep_both";
      await route.fulfill({ json: {
        sourceId: 1, primaryCode: "RJ09999991", saveRoot: "example_remote/RJ/015/RJ09999991",
        localFiles: [{ mediaItemId: 2, path: "Existing/RJ09999991/local.txt", sizeBytes: 4, available: true }],
        items: [{ itemKey: "remote:track.mp3", path: "track.mp3", kind: "audio", sizeBytes: 12, sourceKind: "remote", action: unresolvedConflict ? "conflict" : "cache_download", status: unresolvedConflict ? "target_conflict" : "remote_only", sourcePath: "/download", localSourcePath: "", cachePath: "remote/track.mp3", targetPath: keepBoth ? "example_remote/RJ/015/RJ09999991/track (mirror).mp3" : "example_remote/RJ/015/RJ09999991/track.mp3", originalTargetPath: "example_remote/RJ/015/RJ09999991/track.mp3", resolution: decision?.resolution ?? "auto", remoteSourceId: decision?.sourceId ?? 1, remoteSourceCode: decision?.sourceId === 2 ? "mirror" : "example_remote", remoteSourceName: decision?.sourceId === 2 ? "Mirror" : "Example Remote", remotePath: "track.mp3", sourceOptions: [{ sourceId: 1, sourceCode: "example_remote", sourceName: "Example Remote", path: "track.mp3", sizeBytes: 12 }, { sourceId: 2, sourceCode: "mirror", sourceName: "Mirror", path: "track.mp3", sizeBytes: 12 }], mediaItemId: 1, localPaths: [], targetExists: unresolvedConflict, targetConflict: unresolvedConflict, targetConflictReason: unresolvedConflict ? "target exists with a different size" : "", targetSizeBytes: unresolvedConflict ? 8 : null }],
        summary: { total: 1, skipExisting: 0, cacheHit: 0, cacheDownload: unresolvedConflict ? 0 : 1, promote: unresolvedConflict ? 0 : 1, conflict: unresolvedConflict ? 1 : 0 },
        preparation: {
          requestedCode: "RJ09999991", canonicalCode: "RJ09999990", metadataStatus: "complete", warnings: [],
          editions: [
            { workId: 10, primaryCode: "RJ09999990", title: "Origin", metadataLanguage: "JPN", editionLabel: "日本語", translationKind: "origin", classificationSource: "canonical", makerId: "RG1", originMakerId: "RG1", origin: true, localRoots: [], sources: [{ sourceId: 1, sourceCode: "example_remote", displayName: "Example Remote", status: "available", remoteId: "2", primaryCode: "RJ09999990", title: "Origin", coverUrl: "", workId: 10, hasRemote: true, hasCache: false, hasLocal: false, error: "", elapsedMs: 1 }] },
            { workId: 11, primaryCode: "RJ09999991", title: "Community", metadataLanguage: "CHI_HANS", editionLabel: "簡体中文", translationKind: "community", classificationSource: "translation_umbrella", makerId: "RG60289", originMakerId: "RG1", origin: false, localRoots: [{ id: 1, fileSourceId: 2, rootPath: "Existing/RJ09999991", role: "external", state: "active", primary: false }], sources: [{ sourceId: 1, sourceCode: "example_remote", displayName: "Example Remote", status: "unavailable", remoteId: "1", primaryCode: "RJ09999991", title: "Community", coverUrl: "", workId: 11, hasRemote: true, hasCache: false, hasLocal: true, error: "stale availability", elapsedMs: 1 }] },
          ],
        },
      } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not mocked" } });
  });
}

test("remote source reuses library layout, source sorting, localized tags, and bottom pagination", async ({ page }) => {
  const requests: URL[] = [];
  await mockRemoteSource(page, (url) => requests.push(url));
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();

  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "退廃/背徳/インモラル", exact: true })).toBeVisible();
  await expect(page.getByText("Page 1 / 2 · 30 works", { exact: true })).toHaveCount(2);
  await expect(page.getByTitle("Mark filters are unavailable for source browsing")).toBeDisabled();

  await page.getByRole("button", { name: "Sort: Recently added" }).click();
  await page.getByRole("button", { name: "Sales", exact: true }).click();
  await expect.poll(() => requests.some((url) => url.searchParams.get("sort") === "sales")).toBe(true);

  await page.getByRole("button", { name: "View: Grid" }).click();
  await page.getByRole("button", { name: "Masonry", exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("masonry");
  await expect(page.locator("section[class*='column-count']")).toBeVisible();

  await page.getByTitle("Next page").last().click();
  await expect(page.getByText("Remote page two work", { exact: true })).toBeVisible();
  await expect.poll(() => requests.some((url) => url.searchParams.get("page") === "2")).toBe(true);
});

test("new detail navigation starts at the top, preserves user scroll while media loads, and returning restores the library position", async ({ page }) => {
  await mockApplication(page, undefined, false, 24, 350);
  await page.goto("/");
  const target = page.getByText("Mobile work 18", { exact: true });
  await target.scrollIntoViewIfNeeded();
  const savedScroll = await page.evaluate(() => window.scrollY);
  expect(savedScroll).toBeGreaterThan(500);
  await target.click();
  await expect(page).toHaveURL(/\/RJ10000016/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(10);
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(650);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(50);
  await page.getByRole("button", { name: "Back to library" }).click();
  await expect(page).toHaveURL(/^http:\/\/[^/]+\/(?:\?.*)?$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(savedScroll - 80);
});

test("mobile Fetch prepares language editions and switches between local, remote, and result steps", async ({ page }) => {
  await mockRemoteSource(page, () => undefined);
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await page.getByTitle("Fetch").click();
  await expect(page.getByText("Fetch selection", { exact: true })).toBeVisible();
  await expect(page.getByText("Language editions", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Origin", { exact: true })).toBeVisible();
	await expect(page.getByText("Community", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Publish Fetch" })).toBeDisabled();
	await expect(page.getByLabel("Select RJ09999991")).toBeEnabled();
	await page.getByLabel("Select RJ09999991").click();
	await expect(page.getByRole("button", { name: "Refreshing preview" })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Publish Fetch" })).toBeEnabled();
	await page.getByLabel("Exclude MP3").click();
	await expect(page.getByLabel("Exclude MP3")).toBeChecked();
	await expect(page.getByText("0 remote / 1")).toBeVisible();
	await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByLabel("Exclude MP3")).not.toBeChecked();
	await expect(page.getByRole("button", { name: "Publish Fetch" })).toBeEnabled();
  await page.getByRole("button", { name: "result", exact: true }).click();
  await expect(page.getByText("After Fetch", { exact: true })).toBeVisible();
  await expect(page.getByText("Add", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "local", exact: true }).click();
  await expect(page.getByText("Publish target", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish Fetch" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByText("Local files", { exact: true })).toBeVisible();
  await expect(page.getByText("Remote files", { exact: true })).toBeVisible();
  await expect(page.getByText("After Fetch", { exact: true })).toBeVisible();
});

test("mobile Fetch resolves conflicts and selects a source per file before publishing", async ({ page }) => {
  const planBodies: Record<string, unknown>[] = [];
  await mockRemoteSource(page, () => undefined, { conflict: true, onFetchPlan: (body) => planBodies.push(body) });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await page.getByTitle("Fetch").click();
	await page.getByLabel("Select RJ09999991").click();
  await page.getByRole("button", { name: "result", exact: true }).click();
  await expect(page.getByText("target exists with a different size", { exact: true })).toBeVisible();
  await page.getByLabel("Remote source").selectOption("2");
  await page.getByLabel("Conflict action").selectOption("keep_both");
  await expect.poll(() => planBodies.some((body) => JSON.stringify(body).includes('"sourceId":2') && JSON.stringify(body).includes('"resolution":"keep_both"'))).toBe(true);
  await expect(page.getByRole("button", { name: "Publish Fetch" })).toBeEnabled();
  await expect(page.getByText("track (mirror).mp3", { exact: true })).toBeVisible();
});

test("local Delete builds a refreshed preview and requires two confirmations", async ({ page }) => {
  const cleanupBodies: Record<string, unknown>[] = [];
  const mediaItems = [{
    id: 1,
    parentId: null,
    kind: "audio",
    title: "track.mp3",
    discNo: null,
    trackNo: 1,
    durationSeconds: 10,
    sizeBytes: 12,
    fingerprint: "test-track",
    progress: null,
    locations: [
      { id: 1, fileSourceId: 1, fileSourceCode: "local", fileSourceName: "Local", locationType: "local", path: "RJ09999999/track.mp3", streamUrl: "/api/media/1/stream", downloadUrl: "", remoteHash: "", sizeBytes: 12, durationSeconds: 10, availability: "available", lastCheckedAt: null },
      { id: 2, fileSourceId: 1, fileSourceCode: "local", fileSourceName: "Local", locationType: "cache", path: "local/RJ09999999/track.mp3", streamUrl: "/api/media/2/stream", downloadUrl: "", remoteHash: "", sizeBytes: 12, durationSeconds: 10, availability: "available", lastCheckedAt: null },
    ],
  }];
  await mockApplication(page, undefined, false, 1, 0, mediaItems, (body) => cleanupBodies.push(body));
  await page.goto("/");
  await page.getByText("Tagged mobile work", { exact: true }).click();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("button", { name: "Manage files", exact: true }).click();

  await expect(page.getByText("Select files", { exact: true })).toBeVisible();
  await expect(page.getByText("Delete preview", { exact: true })).toBeVisible();
  await page.getByLabel("Select local copy").click();
  await page.getByLabel("Select cache copy").click();
  await expect(page.getByRole("button", { name: "Refreshing preview" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Review deletion" })).toBeEnabled();
  await expect(page.getByText("2 files", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Review deletion" }).click();
  await expect(page.getByRole("heading", { name: "Review deletion" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Final confirmation" })).toBeVisible();
  await page.getByRole("button", { name: "Permanently delete" }).click();
  await expect.poll(() => cleanupBodies).toHaveLength(1);
  expect(cleanupBodies[0]).toEqual({ targets: [{ kind: "cache", locationId: 2 }, { kind: "local", locationId: 1 }] });
});

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

  await page.getByRole("button", { name: "All records" }).click();
  await page.getByRole("button", { name: "Sort: Recently added" }).click();
  const selectedSort = page.getByRole("button", { name: "Recently added", exact: true });
  await expect(selectedSort).toHaveClass(/bg-primary\/10/);
	await expect(selectedSort.locator("svg")).toHaveCount(0);
  expect((await selectedSort.locator("xpath=parent::div").boundingBox())!.width).toBeLessThanOrEqual(200);
});

test("favorite list popovers use measured mobile placement and stay inside the usable viewport", async ({ page }) => {
	await mockApplication(page);
	await page.goto("/");

	const trigger = page.getByRole("button", { name: "Add to list" });
	await trigger.scrollIntoViewIfNeeded();
	await trigger.click();
	const popover = page.locator(".fixed.z-50").filter({ hasText: "Favorite lists" });
	await expect(popover).toBeVisible();
	const [triggerBox, popoverBox, viewport] = await Promise.all([
		trigger.boundingBox(),
		popover.boundingBox(),
		page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
	]);
	expect(triggerBox).not.toBeNull();
	expect(popoverBox).not.toBeNull();
	expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
	expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(viewport.width);
	expect(popoverBox!.y).toBeGreaterThanOrEqual(0);
	expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(viewport.height - 150);
});

test("library URL state and per-scope search state survive navigation", async ({ page }) => {
	await mockApplication(page);
	await page.goto("/");

	const search = page.getByPlaceholder("Search title, code, circle, tag, or creator");
	await search.fill("local term");
	await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("local term");
	await page.getByRole("button", { name: "Tracked", exact: true }).click();
	await expect(search).toHaveValue("");
	await search.fill("tracked term");
	await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("tracked term");
	await page.getByRole("button", { name: "Local", exact: true }).click();
	await expect(search).toHaveValue("local term");
	await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("local term");
	await page.reload();
	await expect(search).toHaveValue("local term");
});

test("anonymous quick marks show an actionable toast above protected mobile controls", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Mark: Unmarked" }).click();
  await expect(page.getByRole("button", { name: "Unmarked", exact: true })).toHaveClass(/bg-primary\/10/);
  await page.getByRole("button", { name: "Want", exact: true }).click();
  await expect(page.getByText("Please sign in to use this feature.")).toBeVisible();

  const toastViewport = page.locator('[aria-live="polite"]');
  const [toastBox, protectedBoxes] = await Promise.all([
    toastViewport.boundingBox(),
    page.locator("[data-toast-avoid]").evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, top: rect.top };
    })),
  ]);
  expect(toastBox).not.toBeNull();
  const protectedBottom = Math.max(...protectedBoxes.filter((rect) => rect.bottom > 0).map((rect) => rect.bottom));
  expect(toastBox!.y).toBeGreaterThanOrEqual(protectedBottom + 10);

  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Kikoto" })).toBeVisible();
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
  await expect(fullPlayer.getByText("Test circle", { exact: true })).toHaveCount(0);
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

test("inline lyrics adapt visible rows to height and keep the active line centered", async ({ page }) => {
  await mockApplication(page);
  await seedPlayer(page, { ...persistedTrack, lyricsLocationId: 9, lyricsTitle: "lyrics.lrc" });
  await page.goto("/");
  await page.getByText("Test track", { exact: true }).click();

  const preview = page.getByRole("button", { name: "Open lyrics" });
  await expect(preview).toBeVisible();
  await expect(preview.locator('[data-lyric-index="0"]')).toHaveClass(/text-primary/);
  await page.locator("audio").evaluate((audio) => {
    Object.defineProperty(audio, "currentTime", { configurable: true, value: 31 });
    audio.dispatchEvent(new Event("timeupdate"));
  });
  const activeIndex = 6;
  await expect(preview.locator(`[data-lyric-index="${activeIndex}"]`)).toHaveClass(/text-primary/);
  await page.waitForTimeout(500);
  const previewBox = await preview.boundingBox();
  expect(previewBox).not.toBeNull();
  const visibleRows = Math.round(previewBox!.height / 28);
  expect(visibleRows).toBeGreaterThanOrEqual(3);
  expect(visibleRows).toBeLessThanOrEqual(10);
  const lineCount = await preview.locator("[data-lyric-index]").count();
  const firstVisibleIndex = Math.max(0, Math.min(activeIndex - Math.floor(visibleRows / 2), Math.max(0, lineCount - visibleRows)));
  for (let index = 0; index < lineCount; index += 1) {
    const line = preview.locator(`[data-lyric-index="${index}"]`);
    if (index >= firstVisibleIndex && index < firstVisibleIndex + visibleRows) await expect(line).not.toHaveClass(/opacity-0/);
    else await expect(line).toHaveClass(/opacity-0/);
  }
  await expect(preview.locator(":scope > div")).toHaveAttribute("style", new RegExp(`translateY\\(-${firstVisibleIndex * 28}px\\)`));
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

test("desktop mini player delays hiding hover actions", async ({ page }) => {
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
  await expect(page.getByRole("switch", { name: "Finish current track" })).toHaveAttribute("data-state", "unchecked");
  const sleepPopover = page.getByRole("button", { name: "30 min" }).locator("xpath=ancestor::div[contains(@class, 'fixed')]");
  expect((await sleepPopover.boundingBox())!.width).toBeLessThanOrEqual(230);
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
