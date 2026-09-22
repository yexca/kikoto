import { expect, test } from "@playwright/test";
import { syntheticWorkCode } from "../../src/test-support/workCode";
import { work, RemoteTrackControl, mockApplication, mockRemoteSource } from "./fixtures/player-library";

test("remote source reuses the library grid, source sorting, localized tags, and bottom pagination", async ({
  page,
}) => {
  const requests: URL[] = [];
  await mockRemoteSource(page, (url) => requests.push(url));
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();

  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "退廃/背徳/インモラル", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Pages", exact: true })).toBeVisible();
  const pageSizeButton = page.getByRole("button", { name: "Items per page: 24" });
  await expect(pageSizeButton).toBeVisible();
  await pageSizeButton.click();
  await expect(page.getByRole("menu", { name: "Items per page" })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "12 / page" }).click();
  await expect.poll(() => requests.some((url) => url.searchParams.get("pageSize") === "12")).toBe(true);
  const selectButton = page.getByRole("button", { name: "Select", exact: true });
  await expect(selectButton).toBeVisible();
  await selectButton.click();
  await expect(page.getByLabel("Select work").first()).toBeVisible();

  await page.getByRole("button", { name: "Sort: Recently added" }).click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect.poll(() => requests.some((url) => url.searchParams.get("sort") === "code")).toBe(true);
  await page.getByRole("button", { name: "Sort: Code" }).click();
  await page.getByRole("button", { name: "Sales", exact: true }).click();
  await expect.poll(() => requests.some((url) => url.searchParams.get("sort") === "sales")).toBe(true);

  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBeNull();
  await expect(page.locator("section[class*='grid-template-columns']").first()).toBeVisible();

  await page.getByTitle("Next page").last().click();
  await expect(page.getByText("Remote page two work", { exact: true })).toBeVisible();
  await expect.poll(() => requests.some((url) => url.searchParams.get("page") === "2")).toBe(true);
});

test("remote source reloads after switching through the local library", async ({ page }) => {
  const requests: URL[] = [];
  await mockRemoteSource(page, (url) => requests.push(url));
  await page.goto("/");

  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  const initialRequestCount = requests.length;

  await page.getByRole("button", { name: "Local", exact: true }).click();
  await expect(page.getByText("Tagged mobile work", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  await expect.poll(() => requests.length).toBeGreaterThan(initialRequestCount);
});

test("remote source renders disabled and unavailable failures inside the works area", async ({ page }) => {
  await mockRemoteSource(page, () => undefined, { remoteStatus: "disabled" });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();

  await expect(page.getByText("Remote source is disabled", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  await expect(page.getByText("Remote Japanese work", { exact: true })).toHaveCount(0);
});

test("remote source unavailable failure lets a reader retry without diagnostic details", async ({ page }) => {
  const requests: URL[] = [];
  await mockRemoteSource(page, (url) => requests.push(url), {
    remoteStatus: "unavailable",
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();

  await expect(page.getByText("Remote source is unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: /^https?:\/\// })).toHaveCount(0);
  const initialRequests = requests.length;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(initialRequests);
});

test("remote source administrators can open the sanitized diagnostic URL", async ({ page }) => {
  await mockRemoteSource(page, () => undefined, {
    permissions: ["library:read", "playback:use", "sources:write"],
    remoteStatus: "unavailable",
    remoteErrorURL: "https://source.example.invalid/api",
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();

  await expect(page.getByRole("link", { name: "https://source.example.invalid/api", exact: true })).toHaveAttribute(
    "href",
    "https://source.example.invalid/api",
  );
});

test("remote source keeps alias matches returned by the backend", async ({ page }) => {
  const aliasWorkCode = syntheticWorkCode("RJ", 54);
  const requests: URL[] = [];
  await mockRemoteSource(page, (url) => requests.push(url));
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();

  await page.getByRole("button", { name: "Search library" }).click();
  const search = page.getByPlaceholder("Search title, code, circle, tag, or creator");
  await search.fill(aliasWorkCode);
  await expect.poll(() => requests.some((url) => url.searchParams.get("q") === aliasWorkCode)).toBe(true);
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
});

test("remote source remembers sorting after transient browse state is cleared", async ({ page }) => {
  const requests: URL[] = [];
  await mockRemoteSource(page, (url) => requests.push(url));
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await page.getByRole("button", { name: "Sort: Recently added" }).click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect.poll(() => requests.some((url) => url.searchParams.get("sort") === "code")).toBe(true);

  requests.length = 0;
  await page.evaluate(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "");
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Example Remote", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Sort: Code" })).toBeVisible();
  await expect.poll(() => requests.some((url) => url.searchParams.get("sort") === "code")).toBe(true);
});

test("remote card Track queues in place and reports a terminal failure without navigation", async ({ page }) => {
  const trackControl: RemoteTrackControl = { status: "queued", trackRequests: [], statusRequests: 0 };
  await mockRemoteSource(page, () => undefined, { trackControl });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  const sourceURL = page.url();

  await page.getByTitle("Track").click();

  await expect.poll(() => trackControl.trackRequests).toHaveLength(1);
  expect(page.url()).toBe(sourceURL);
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  await expect(page.getByText("Track workflow #91 failed for RJ00000051.", { exact: true })).toHaveCount(0);

  await expect.poll(() => trackControl.statusRequests).toBeGreaterThan(0);
  trackControl.status = "failed";
  await expect(page.getByText("Track workflow #91 failed for RJ00000051.", { exact: true })).toBeVisible();
  expect(page.url()).toBe(sourceURL);
});

test("mobile Fetch prepares language editions and switches between local, remote, and result steps", async ({
  page,
}) => {
  await mockRemoteSource(page, () => undefined);
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await page.getByTitle("Fetch").click();
  await expect(page.getByText("Fetch selection", { exact: true })).toBeVisible();
  await expect(page.getByText("Language editions", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Origin", { exact: true })).toBeVisible();
  await expect(page.getByText("Community", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Select RJ00000051")).toBeChecked();
  await expect(page.getByLabel("Include MP3")).toBeChecked();
  await expect(page.getByRole("button", { name: "Publish Fetch" })).toBeEnabled();
  await expect(page.getByLabel("Select RJ00000051")).toBeEnabled();
  await page.getByLabel("Include MP3").click();
  await expect(page.getByLabel("Include MP3")).not.toBeChecked();
  await expect(page.getByText("0 remote / 1")).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByLabel("Include MP3")).toBeChecked();
  await expect(page.getByRole("button", { name: "Publish Fetch" })).toBeEnabled();
  await page.getByRole("button", { name: "After Fetch", exact: true }).click();
  await expect(page.getByText("Add", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Local files", exact: true }).click();
  await expect(page.getByText("Publish target", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish Fetch" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByText("Local files", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Remote files", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("After Fetch", { exact: true }).last()).toBeVisible();
});

test("mobile Fetch preserves reviewed choices after an unconfirmed submission and retries the same request", async ({
  page,
}) => {
  const submissions: Record<string, unknown>[] = [];
  await mockRemoteSource(page, () => undefined, { conflict: true });
  await page.route("**/api/remote-sources/1/works/RJ00000051/fetch", async (route) => {
    expect(route.request().method()).toBe("POST");
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) {
      await route.fulfill({
        status: 503,
        json: { error: "Submission unavailable", code: "unavailable", retryable: true },
      });
      return;
    }
    await route.fulfill({ status: 202, json: { primaryCode: "RJ00000051", runId: 92, status: "queued" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await page.getByTitle("Fetch").click();
  await page.getByRole("button", { name: "After Fetch", exact: true }).click();
  await expect(page.getByText("target exists with a different size", { exact: true })).toBeVisible();
  await page.getByLabel("Remote source").selectOption("2");
  await page.getByLabel("Conflict action").selectOption("keep_both");
  await expect(page.getByText("track (mirror).mp3", { exact: true })).toBeVisible();
  const publish = page.getByRole("button", { name: "Publish Fetch" });
  await publish.click();
  await expect(
    page.getByText(
      "Fetch submission could not be confirmed. It may still be running; check Activity or retry this selection.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    paths: ["track.mp3"],
    localPaths: [],
    targetRoot: "example_remote/RJ/000/RJ00000051",
    decisions: [{ itemKey: "remote:track.mp3", sourceId: 2, resolution: "keep_both" }],
  });
  expect(submissions[0].requestId).toEqual(expect.any(String));
  expect((submissions[0].requestId as string).trim()).not.toBe("");
  await expect(page.getByLabel("Remote source")).toHaveValue("2");
  await expect(page.getByLabel("Conflict action")).toHaveValue("keep_both");

  await publish.click();
  await expect(page.getByText("Fetch queued for RJ00000051 as workflow run #92.", { exact: true })).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  await expect(publish).toHaveCount(0);
});

test("mobile Fetch reviews an unclaimed destination folder before publishing", async ({ page }) => {
  await mockRemoteSource(page, () => undefined, { fetchRootConflict: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await page.getByTitle("Fetch").click();

  const warning = page.getByRole("alert");
  await expect(warning).toContainText("Fetch folder requires review");
  await expect(warning).toContainText("example_remote");
  await expect(warning).toContainText("Do not use it for manually managed works");
  await expect(page.getByRole("button", { name: "Publish Fetch" })).toBeDisabled();
});

test("local Delete builds a refreshed preview and requires two confirmations", async ({ page }) => {
  const cleanupBodies: Record<string, unknown>[] = [];
  let localRefreshes = 0;
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
      fingerprint: "test-track",
      progress: null,
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
        {
          id: 2,
          fileSourceId: 1,
          fileSourceCode: "local",
          fileSourceName: "Local",
          locationType: "cache",
          path: "local/RJ00000000/track.mp3",
          streamUrl: "/api/media/2/stream",
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
  await mockApplication(page, undefined, false, 1, 0, mediaItems, (body) => cleanupBodies.push(body), {
    work: {
      ...work,
      sourcePresence: [
        {
          type: "local",
          availability: "available",
          fileSourceId: 1,
          fileSourceCode: "local",
          fileSourceName: "Local",
          sourceUrl: work.primaryCode,
        },
      ],
      localFolders: [
        {
          id: 101,
          workId: work.id,
          fileSourceId: 1,
          rootPath: work.primaryCode,
          role: "external",
          state: "active",
          primary: true,
        },
      ],
    },
    onLocalRefresh: () => {
      localRefreshes += 1;
    },
  });
  await page.goto("/");
  await page.getByText("Tagged mobile work", { exact: true }).click();
  await page.getByRole("button", { name: /Source actions for/ }).click();
  await page.getByRole("menuitem", { name: "Refresh local files", exact: true }).click();
  await expect.poll(() => localRefreshes).toBe(1);
  await page.getByRole("button", { name: /Source actions for/ }).click();
  await page.getByRole("menuitem", { name: "Manage files", exact: true }).click();

  await expect(page.getByRole("button", { name: "All", exact: true })).toBeVisible();
  await expect(page.getByLabel("Include MP3")).toBeVisible();
  await expect(page.getByLabel(`Select work root ${work.primaryCode}`)).toBeVisible();
  await expect(page.getByText("Delete preview", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refreshing preview" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Review file deletion" })).toBeEnabled();
  await expect(page.getByText("3 items", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Review file deletion" }).click();
  await expect(page.getByRole("heading", { name: "Review file deletion" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Final confirmation" })).toBeVisible();
  await page.getByRole("button", { name: "Delete files only" }).click();
  await expect.poll(() => cleanupBodies).toHaveLength(1);
  expect(cleanupBodies[0]).toEqual({
    mode: "files_only",
    targets: [
      { kind: "cache", locationId: 2 },
      { kind: "local", locationId: 1 },
      { kind: "local_root", locationId: 1, folderId: 101, expectedPath: work.primaryCode },
    ],
  });
});

test("local Delete enables work forgetting only for a complete root and confirms its data boundary", async ({
  page,
}) => {
  const cleanupBodies: Record<string, unknown>[] = [];
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
      fingerprint: "forget-work-track",
      progress: null,
      locations: [
        {
          id: 1,
          fileSourceId: 1,
          fileSourceCode: "local",
          fileSourceName: "Local",
          locationType: "local",
          path: `${work.primaryCode}/track.mp3`,
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
  await mockApplication(page, undefined, false, 1, 0, mediaItems, (body) => cleanupBodies.push(body), {
    authenticated: true,
    permissions: ["library:read", "playback:use", "downloads:manage", "sources:write"],
    work: {
      ...work,
      sourcePresence: [
        {
          type: "local",
          availability: "available",
          fileSourceId: 1,
          fileSourceCode: "local",
          fileSourceName: "Local",
          sourceUrl: work.primaryCode,
        },
      ],
      localFolders: [
        {
          id: 102,
          workId: work.id,
          fileSourceId: 1,
          rootPath: work.primaryCode,
          role: "external",
          state: "active",
          primary: true,
        },
      ],
    },
  });

  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await page.getByRole("button", { name: /Source actions for/ }).click();
  await page.getByRole("menuitem", { name: "Manage files", exact: true }).click();

  const forgetButton = page.getByRole("button", { name: "Review deletion and forget work" });
  await expect(forgetButton).toBeDisabled();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(forgetButton).toBeEnabled();
  await forgetButton.click();

  await expect(page.getByRole("heading", { name: "Review deletion and forget work" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Will be deleted" })).toBeVisible();
  await expect(
    page.getByText(/complete logical work family, all metadata, playback history, Quick mark/),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Will be kept" })).toBeVisible();
  await expect(page.getByText(/Any other available remote, tracked, cache, or local source/)).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Delete files and forget work" }).click();

  await expect.poll(() => cleanupBodies).toHaveLength(1);
  expect(cleanupBodies[0]).toEqual({
    mode: "files_and_forget_work",
    targets: [
      { kind: "local", locationId: 1 },
      { kind: "local_root", locationId: 1, folderId: 102, expectedPath: work.primaryCode },
    ],
  });
});

test("work detail preserves Local and Tracked entry intent while keeping every remote source tab", async ({ page }) => {
  let sourceChecks = 0;
  const cleanupBodies: Record<string, unknown>[] = [];
  const trackedPresences = [
    {
      type: "tracked",
      availability: "available",
      fileSourceId: 7,
      fileSourceCode: "remote_a",
      fileSourceName: "Remote A",
      remoteCode: work.primaryCode,
    },
    {
      type: "tracked",
      availability: "available",
      fileSourceId: 8,
      fileSourceCode: "remote_b",
      fileSourceName: "Remote B",
      remoteCode: work.primaryCode,
    },
  ];
  const trackedWork = { ...work, availability: ["local", "tracked"], sourcePresence: trackedPresences };
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
      fingerprint: "source-tab-track",
      progress: null,
      locations: [
        {
          id: 1,
          fileSourceId: 9,
          fileSourceCode: "local",
          fileSourceName: "Local",
          locationType: "local",
          path: `${work.primaryCode}/track.mp3`,
          streamUrl: "/api/media/1/stream",
          downloadUrl: "",
          remoteHash: "",
          sizeBytes: 12,
          durationSeconds: 10,
          availability: "available",
          lastCheckedAt: null,
        },
        {
          id: 2,
          fileSourceId: 7,
          fileSourceCode: "remote_a",
          fileSourceName: "Remote A",
          locationType: "cache",
          path: `remote_a/${work.primaryCode}/track.mp3`,
          streamUrl: "/api/media/2/stream",
          downloadUrl: "",
          remoteHash: "hash",
          sizeBytes: 12,
          durationSeconds: 10,
          availability: "available",
          lastCheckedAt: null,
        },
        {
          id: 3,
          fileSourceId: 7,
          fileSourceCode: "remote_a",
          fileSourceName: "Remote A",
          locationType: "remote_stream",
          path: "track.mp3",
          streamUrl: "/remote/track.mp3",
          downloadUrl: "/remote/track.mp3",
          remoteHash: "hash",
          sizeBytes: 12,
          durationSeconds: 10,
          availability: "available",
          lastCheckedAt: null,
        },
      ],
    },
  ];
  const availability = {
    workCode: work.primaryCode,
    checkedAt: "2026-07-13T00:00:00Z",
    runId: 9,
    sources: [
      {
        sourceId: 7,
        sourceCode: "remote_a",
        displayName: "Remote A",
        status: "available",
        remoteId: "1",
        primaryCode: work.primaryCode,
        title: work.title,
        coverUrl: "",
        workId: 1,
        hasRemote: true,
        hasTracked: true,
        hasCache: false,
        hasLocal: true,
        error: "",
        elapsedMs: 1,
      },
      {
        sourceId: 8,
        sourceCode: "remote_b",
        displayName: "Remote B",
        status: "not_found",
        remoteId: "",
        primaryCode: work.primaryCode,
        title: "",
        coverUrl: "",
        workId: 1,
        hasRemote: false,
        hasTracked: true,
        hasCache: false,
        hasLocal: true,
        error: "",
        elapsedMs: 1,
      },
    ],
  };
  await mockApplication(page, undefined, false, 1, 0, mediaItems, (body) => cleanupBodies.push(body), {
    work: trackedWork,
    librarySources: [
      {
        id: 7,
        code: "remote_a",
        displayName: "Remote A",
        sourceType: "kikoeru_compatible",
        enabled: true,
      },
      {
        id: 8,
        code: "remote_b",
        displayName: "Remote B",
        sourceType: "kikoeru_compatible",
        enabled: true,
      },
    ],
    sourceAvailability: availability,
    remoteDetail: {
      sourceId: 7,
      sourceCode: "remote_a",
      sourceName: "Remote A",
      remoteId: "1",
      primaryCode: work.primaryCode,
      remoteCode: work.primaryCode,
      title: work.title,
      coverUrl: "",
      sourceUrl: "",
      circle: work.circle,
      rating: 4.5,
      sales: 10,
      ageRating: "",
      releaseDate: work.releaseDate,
      durationSeconds: 10,
      tags: [],
      voiceActors: [],
      importStatus: "tracked",
      workId: 1,
      tracks: [],
    },
    onSourceCheck: () => {
      sourceChecks += 1;
    },
  });

  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await expect(page).toHaveURL(/view=local/);
  const localTab = page.locator('button[title="Local: Local files available"]');
  const trackedTab = page.locator('button[title^="Tracked:"]');
  const remoteTab = page.locator('button[title="Remote A: Available"]');
  await expect(localTab).toHaveClass(/bg-primary/);
  await expect(trackedTab).toBeVisible();
  await expect(page.locator('button[title^="Tracked:"]')).toHaveCount(1);
  await expect(remoteTab).toBeVisible();
  const missingRemoteTab = page.locator('button[title="Remote B: Not found"]');
  await expect(missingRemoteTab).toBeVisible();
  const sourceOptions = page.getByRole("button", { name: /Source actions for/ });
  await expect(page.getByTestId("hero-actions").getByRole("button", { name: /Source actions for/ })).toBeVisible();
  await sourceOptions.click();
  await expect(page.getByRole("menu", { name: "Selected source options" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Refresh local files", exact: true })).toBeFocused();
  await expect(page.getByRole("menuitem", { name: "Manage files", exact: true })).toBeVisible();
  // Dismiss on a non-interactive surface; a screen corner can fall inside a control's touch target.
  await page.getByRole("heading", { name: work.title, exact: true }).click();
  await expect(page.getByRole("menu", { name: "Selected source options" })).toHaveCount(0);

  await remoteTab.click();
  await sourceOptions.click();
  await expect(page.getByRole("menuitem", { name: /^Track/ })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: /^Untrack/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Fetch", exact: true })).toBeVisible();
  await trackedTab.click();
  await expect(page.getByRole("menu", { name: "Selected source options" })).toHaveCount(0);
  await expect(page.getByText("Browsing the tracked directory forked from Remote A.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Switch fork", exact: true }).click();
  const trackedSourcesMenu = page.getByRole("menu", { name: "Tracked sources" });
  await expect(trackedSourcesMenu).toBeVisible();
  await page.getByRole("menuitemradio", { name: /Remote B/ }).click();
  await expect(trackedSourcesMenu).toHaveCount(0);
  await expect(page).toHaveURL(/view=tracked&trackedSource=8/);
  await expect(
    page.getByText("Remote B is tracked, but its directory has not been forked.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch fork", exact: true }).click();
  await page.getByRole("menuitemradio", { name: /Remote A/ }).click();
  await expect(page).toHaveURL(/view=tracked&trackedSource=7/);
  await sourceOptions.click();
  await expect(page.getByText("Switch fork", { exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Untrack/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Manage cache/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Selected source options" })).toHaveCount(0);
  await page.getByRole("button", { name: "Directory actions", exact: true }).click();
  await page
    .getByRole("menu", { name: "Directory actions" })
    .getByRole("menuitem", { name: "Check sources", exact: true })
    .click();
  await expect.poll(() => sourceChecks).toBe(1);

  await page.getByRole("main").getByRole("button", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Tracked", exact: true }).click();
  await page.getByText(work.title, { exact: true }).click();
  await expect(page).toHaveURL(/view=tracked/);
  await expect(page.locator('button[title^="Tracked:"]').locator("..")).toHaveClass(/bg-primary/);
  await expect(page.locator('button[title="Remote A: Available"]')).toBeVisible();
  await page.getByRole("button", { name: /Source actions for/ }).click();
  await page.getByRole("menuitem", { name: /Manage cache/ }).click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByText("1 selected / 1 deletable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review file deletion" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Delete files only" }).click();
  await expect.poll(() => cleanupBodies).toHaveLength(1);
  expect(cleanupBodies[0]).toEqual({ mode: "files_only", targets: [{ kind: "cache", locationId: 2 }] });
});

test("tracked library cards confirm Untrack in an anchored popover", async ({ page }) => {
  const untrackRequests: Array<{ workId: number; sourceId: number }> = [];
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    work: {
      ...work,
      availability: ["tracked", "remote"],
      sourcePresence: [
        {
          type: "tracked",
          availability: "available",
          workId: 12,
          fileSourceId: 7,
          fileSourceCode: "remote_a",
          fileSourceName: "Remote A",
          remoteCode: work.primaryCode,
        },
      ],
    },
    onUntrack: (workId, sourceId) => untrackRequests.push({ workId, sourceId }),
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Tracked", exact: true }).click();

  const untrackTrigger = page.getByRole("button", { name: "Untrack", exact: true });
  await untrackTrigger.click();
  await expect(page.getByText("Untrack source?", { exact: true })).toBeVisible();
  expect(untrackRequests).toHaveLength(0);

  await page.getByRole("button", { name: "Untrack Remote A", exact: true }).click();
  await expect.poll(() => untrackRequests).toEqual([{ workId: 12, sourceId: 7 }]);
  await expect(page.getByText(`Untracked ${work.primaryCode} from Remote A.`, { exact: true })).toBeVisible();
});

test("anonymous Fetch opens login before loading remote detail or a fetch plan", async ({ page }) => {
  const preparationRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/api\/remote-sources\/1\/works\/[^/]+/.test(path)) preparationRequests.push(path);
  });
  await mockRemoteSource(page, () => undefined, { authenticated: false });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  await page.getByTitle("Fetch").click();

  await expect(page.getByRole("heading", { name: "Sign in to Kikoto" })).toBeVisible();
  expect(preparationRequests).toEqual([]);
});

test("remote-only work uses the shared mobile detail shell without becoming persisted", async ({ page }) => {
  const trackRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/track"))
      trackRequests.push(request.url());
  });
  await mockRemoteSource(page, () => undefined);
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await page.getByText("Remote Japanese work", { exact: true }).click();

  await expect.poll(() => new URL(page.url()).searchParams.get("source")).toBe("1");
  expect(new URL(page.url()).searchParams.get("view")).toBeNull();
  await expect(page.getByRole("button", { name: "Info", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Directory", exact: true })).toBeVisible();
  await expect(
    page.getByText("Previewing remote files from Example Remote; temporary playback does not save progress.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Info", exact: true }).click();
  const japaneseVersions = page.getByRole("group", { name: "Japanese versions" });
  await japaneseVersions.getByRole("button", { name: "Choose Japanese DLsite code", exact: true }).click();
  const japaneseCodes = page.getByRole("menu", { name: "Japanese DLsite codes", exact: true });
  const [japaneseVersionsBox, japaneseCodesBox] = await Promise.all([
    japaneseVersions.boundingBox(),
    japaneseCodes.boundingBox(),
  ]);
  expect(japaneseVersionsBox).not.toBeNull();
  expect(japaneseCodesBox).not.toBeNull();
  expect(Math.abs(japaneseCodesBox!.x - Math.max(12, japaneseVersionsBox!.x))).toBeLessThanOrEqual(6);
  await japaneseVersions.getByRole("button", { name: "Choose Japanese DLsite code", exact: true }).click();
  const englishVersions = page.getByRole("group", { name: "English versions" });
  await englishVersions.getByRole("button", { name: "Choose English DLsite code", exact: true }).click();
  const englishCodes = page.getByRole("menu", { name: "English DLsite codes", exact: true });
  await englishCodes.getByRole("menuitemradio", { name: "RJ00000053 Official Available", exact: true }).click();
  await page.getByRole("button", { name: "Directory", exact: true }).click();
  await expect(page.getByText("english.mp3", { exact: true })).toBeVisible();
  expect(trackRequests).toEqual([]);
});

test("remote detail Track completes in place and makes the forked Tracked source available", async ({ page }) => {
  const trackControl: RemoteTrackControl = {
    status: "queued",
    trackRequests: [],
    statusRequests: 0,
    untracked: false,
    untrackRequests: [],
  };
  await mockRemoteSource(page, () => undefined, { trackControl });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await page.getByText("Remote Japanese work", { exact: true }).click();
  await expect(page).toHaveURL(/\/RJ00000051\?source=1/);
  const detailURL = page.url();
  const trackedTab = page.locator('button[title^="Tracked:"]');
  await expect(trackedTab).toHaveAttribute("title", "Tracked: No tracked source linked");

  await page.getByRole("button", { name: /Source actions for/ }).click();
  await page.getByRole("menuitem", { name: "Track", exact: true }).click();

  await expect.poll(() => trackControl.trackRequests).toHaveLength(1);
  await expect(page.getByText("Track workflow #91 queued.", { exact: true })).toBeVisible();
  expect(page.url()).toBe(detailURL);
  await expect(trackedTab).toHaveAttribute("title", "Tracked: No tracked source linked");

  trackControl.status = "succeeded";
  await expect(page.getByText("Track workflow #91 completed for RJ00000051.", { exact: true })).toBeVisible();
  expect(page.url()).toBe(detailURL);
  await expect(trackedTab).toHaveAttribute("title", "Tracked: Forked directory available");
  await page.getByRole("button", { name: /Source actions for/ }).click();
  await expect(page.getByRole("menuitem", { name: /^Track/ })).toBeDisabled();
  await page.getByRole("menuitem", { name: /^Untrack/ }).click();
  await expect(page.getByRole("menuitem", { name: /^Confirm untrack/ })).toBeVisible();
  expect(trackControl.untrackRequests).toHaveLength(0);
  await page.getByRole("menuitem", { name: /^Confirm untrack/ }).click();
  await expect.poll(() => trackControl.untrackRequests).toHaveLength(1);
  await expect(page.getByText("Untracked RJ00000051 from Example Remote.", { exact: true })).toBeVisible();
  await expect(trackedTab).toHaveAttribute("title", "Tracked: No tracked source linked");
  await page.getByRole("button", { name: /Source actions for/ }).click();
  await expect(page.getByRole("menuitem", { name: /^Track/ })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: /^Untrack/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await trackedTab.click();
  await expect(page.getByText("Tracked is not selected for this preview.", { exact: true })).toBeVisible();
});

test("persisted remote result opens the canonical detail with its remote source selected", async ({ page }) => {
  const trackRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/track"))
      trackRequests.push(request.url());
  });
  await mockRemoteSource(page, () => undefined, { persisted: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Example Remote", exact: true }).click();
  await page.getByText("Remote Japanese work", { exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/${work.primaryCode}\\?`));
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("remote");
  expect(new URL(page.url()).searchParams.get("source")).toBe("1");
  expect(new URL(page.url()).searchParams.get("remoteCode")).toBe("RJ00000051");
  await expect(page.locator('button[title="Example Remote: Available"]')).toHaveClass(/bg-primary/);
  await expect(page.getByText("Previewing remote files from Example Remote.", { exact: true })).toBeVisible();
  expect(trackRequests).toEqual([]);
});
