import { expect, test } from "@playwright/test";
import { syntheticWorkCode } from "../../src/test-support/workCode";
import type {
  LibrarySource,
  MediaItem,
  RemoteWorkSaveResult,
  SourceAvailabilityResponse,
  SourcePresenceItem,
  Work,
  WorkFolderLocation,
} from "../../src/lib/api";
import { remoteWorkDetailFixture, rolePermissions, type ApiErrorBody } from "./fixtures/api";
import {
  work,
  type RemoteTrackControl,
  mockApplication,
  mockRemoteSource,
  selectLibrarySource,
} from "./fixtures/player-library";

test("remote source reuses the library grid, source sorting, localized tags, and bottom pagination", async ({
  page,
}) => {
  const requests: URL[] = [];
  await mockRemoteSource(page, (url) => requests.push(url));
  await page.goto("/");
  await selectLibrarySource(page, "Example Remote");

  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "退廃/背徳/インモラル", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Pages", exact: true })).toBeVisible();
  const displayButton = page.getByRole("button", { name: /^Display options .*Items per page: 24/ });
  await expect(displayButton).toBeVisible();
  await displayButton.click();
  const displayOptions = page.getByRole("dialog", { name: "Display options" });
  await expect(displayOptions.getByRole("radiogroup", { name: "Items per page" })).toBeVisible();
  await expect(displayOptions.getByRole("radiogroup", { name: "Items per page" }).getByRole("radio")).toHaveText([
    "24",
    "48",
    "96",
  ]);
  await displayOptions.getByRole("radio", { name: "48 per page" }).click();
  await expect.poll(() => requests.some((url) => url.searchParams.get("pageSize") === "48")).toBe(true);
  // The source's 30 works span two pages again at 24 per page.
  await displayOptions.getByRole("radio", { name: "24 per page" }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.get("pageSize")).toBe("24");
  await page.keyboard.press("Escape");
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

  await selectLibrarySource(page, "Example Remote");
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  const initialRequestCount = requests.length;

  await selectLibrarySource(page, "Local");
  await expect(page.getByText("Tagged mobile work", { exact: true })).toBeVisible();

  await selectLibrarySource(page, "Example Remote");
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  await expect.poll(() => requests.length).toBeGreaterThan(initialRequestCount);
});

test("the phone source menu lists a disabled source and renders its failure inside the works area", async ({
  page,
}) => {
  await mockRemoteSource(page, () => undefined, { remoteStatus: "disabled" });
  await page.goto("/");
  await page.getByRole("button", { name: "Source: Local", exact: true }).click();
  const remoteItem = page
    .getByRole("menu", { name: "Source" })
    .getByRole("menuitemradio", { name: "Example Remote", exact: true });
  await expect(remoteItem).toHaveAccessibleDescription("Disabled");
  await remoteItem.click();
  await expect(page.getByRole("button", { name: "Source: Example Remote", exact: true })).toBeVisible();

  await expect(page.getByText("Remote source is disabled", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  await expect(page.getByText("Remote Japanese work", { exact: true })).toHaveCount(0);
});

test("@desktop a disabled source stays out of the wide source tabs until source visibility shows it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockRemoteSource(page, () => undefined, { remoteStatus: "disabled" });
  await page.goto("/");
  const remoteTab = page.getByRole("button", { name: "Example Remote", exact: true });
  await expect(page.getByRole("button", { name: "Local", exact: true })).toBeVisible();
  await expect(remoteTab).toHaveCount(0);
  await page.getByRole("button", { name: "Source visibility", exact: true }).click();
  await page
    .getByRole("radiogroup", { name: "Example Remote visibility" })
    .getByRole("radio", { name: "Always show" })
    .click();
  await page.keyboard.press("Escape");
  await remoteTab.click();
  await expect(page.getByText("Remote source is disabled", { exact: true })).toBeVisible();
});

test("remote source unavailable failure lets a reader retry without diagnostic details", async ({ page }) => {
  const requests: URL[] = [];
  await mockRemoteSource(page, (url) => requests.push(url), {
    remoteStatus: "unavailable",
  });
  await page.goto("/");
  await selectLibrarySource(page, "Example Remote");

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
  await selectLibrarySource(page, "Example Remote");

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
  await selectLibrarySource(page, "Example Remote");

  const search = page.getByRole("searchbox", { name: "Search library" });
  await search.fill(aliasWorkCode);
  await expect.poll(() => requests.some((url) => url.searchParams.get("q") === aliasWorkCode)).toBe(true);
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
});

test("remote source remembers sorting after transient browse state is cleared", async ({ page }) => {
  const requests: URL[] = [];
  await mockRemoteSource(page, (url) => requests.push(url));
  await page.goto("/");
  await selectLibrarySource(page, "Example Remote");
  await page.getByRole("button", { name: "Sort: Recently added" }).click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await expect.poll(() => requests.some((url) => url.searchParams.get("sort") === "code")).toBe(true);

  requests.length = 0;
  await page.evaluate(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "");
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Source: Example Remote", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sort: Code" })).toBeVisible();
  await expect.poll(() => requests.some((url) => url.searchParams.get("sort") === "code")).toBe(true);
});

test("remote card Fork queues in place and reports a terminal failure without navigation", async ({ page }) => {
  const trackControl: RemoteTrackControl = {
    status: "queued",
    trackRequests: [],
    statusRequests: 0,
    untracked: false,
    untrackRequests: [],
  };
  await mockRemoteSource(page, () => undefined, { trackControl });
  await page.goto("/");
  await selectLibrarySource(page, "Example Remote");
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  const sourceURL = page.url();

  await page.getByTitle("Fork").click();

  await expect.poll(() => trackControl.trackRequests).toHaveLength(1);
  expect(page.url()).toBe(sourceURL);
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  await expect(page.getByText("Track workflow #91 failed for RJ00000051.", { exact: true })).toHaveCount(0);

  await expect.poll(() => trackControl.statusRequests).toBeGreaterThan(0);
  trackControl.status = "failed";
  await expect(page.getByText("Track workflow #91 failed for RJ00000051.", { exact: true })).toBeVisible();
  expect(page.url()).toBe(sourceURL);
});

test("a User keeps remote actions visible and learns about the missing permission before any request", async ({
  page,
}) => {
  const writes: string[] = [];
  await mockRemoteSource(page, () => undefined, { role: "user" });
  await page.route(
    /\/api\/(remote-sources\/1\/works\/[^/]+\/(track|sync|cache|fetch-plan)|workflow-runs\/remote-bulk)$/,
    async (route) => {
      writes.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        status: 403,
        json: { code: "permission_denied", error: "permission denied", retryable: false },
      });
    },
  );
  await page.goto("/");
  await selectLibrarySource(page, "Example Remote");
  await expect(page.getByText("Remote Japanese work", { exact: true })).toBeVisible();
  const denied = page.getByText("Your account does not have permission to use this feature.");

  await page.getByTitle("Fork").first().click();
  await expect(denied.first()).toBeVisible();

  // Marking a remote work that is not in the Library would add it there, so
  // the mark menu stays closed.
  await page.getByTitle("Mark: Unmarked").first().click();
  await expect(page.getByRole("button", { name: "Listening", exact: true })).toHaveCount(0);

  await page.getByTitle("Fetch").first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("mobile Fetch prepares language editions and switches between local, remote, and result steps", async ({
  page,
}) => {
  await mockRemoteSource(page, () => undefined);
  await page.goto("/");
  await selectLibrarySource(page, "Example Remote");
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
  await expect(page.getByText("0 of 1 selected")).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByLabel("Include MP3")).toBeChecked();
  await expect(page.getByRole("button", { name: "Publish Fetch" })).toBeEnabled();
  await page.getByRole("button", { name: "After Fetch", exact: true }).click();
  await expect(page.getByText("Add", { exact: true })).toBeVisible();
  await expect(page.getByText("Publish target", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Local files", exact: true }).click();
  await expect(page.getByText("Selected local files are copied into the published folder.")).toBeVisible();
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
        json: { error: "Submission unavailable", code: "unavailable", retryable: true } satisfies ApiErrorBody,
      });
      return;
    }
    await route.fulfill({
      status: 202,
      json: {
        runId: 92,
        jobId: 93,
        workId: 11,
        primaryCode: "RJ00000051",
        status: "queued",
        saveRoot: "example_remote/RJ/000/RJ00000051",
        savedFiles: 0,
        skippedFiles: 0,
        cachedFiles: 0,
        promotedFiles: 0,
        plan: { total: 1, skipExisting: 0, cacheHit: 0, cacheDownload: 1, promote: 1, conflict: 0 },
        requestId: String(submissions[submissions.length - 1].requestId ?? ""),
        deduplicated: false,
      } satisfies RemoteWorkSaveResult,
    });
  });
  await page.goto("/");
  await selectLibrarySource(page, "Example Remote");
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
  await selectLibrarySource(page, "Example Remote");
  await page.getByTitle("Fetch").click();

  const warning = page.getByRole("alert");
  await expect(warning).toContainText("Fetch folder requires review");
  await expect(warning).toContainText("example_remote");
  await expect(warning).toContainText("Do not use it for manually managed works");
  await expect(page.getByRole("button", { name: "Publish Fetch" })).toBeDisabled();
});

const localPresence: SourcePresenceItem = {
  type: "local",
  availability: "available",
  fileSourceId: 1,
  fileSourceCode: "local",
  fileSourceName: "Local",
  sourceUrl: work.primaryCode,
};

function localRootFolder(id: number): WorkFolderLocation {
  return {
    id,
    workId: work.id,
    fileSourceId: 1,
    rootPath: work.primaryCode,
    role: "external",
    state: "active",
    availability: "available",
    primary: true,
  };
}

test("local Delete selects by location, summarizes the selection, and requires two confirmations", async ({ page }) => {
  const cleanupBodies: Record<string, unknown>[] = [];
  let localRefreshes = 0;
  let mediaRequests = 0;
  const mediaItems: MediaItem[] = [
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
    work: { ...work, sourcePresence: [localPresence] },
    detailLocalFolders: [localRootFolder(101)],
    onLocalRefresh: () => {
      localRefreshes += 1;
    },
    onMediaRequest: () => {
      mediaRequests += 1;
    },
  });
  await page.goto("/");
  await page.getByText("Tagged mobile work", { exact: true }).click();
  await page.getByRole("button", { name: /Source actions for/ }).click();
  await page.getByRole("menuitem", { name: "Refresh local files", exact: true }).click();
  await expect.poll(() => localRefreshes).toBe(1);
  await page.getByRole("button", { name: /Source actions for/ }).click();
  await page.getByRole("menuitem", { name: "Manage files", exact: true }).click();

  const workRoot = page.getByRole("checkbox", { name: `Select work root ${work.primaryCode}`, exact: true });
  await expect(workRoot).toBeVisible();
  await expect(page.getByRole("button", { name: "Review file deletion" })).toBeDisabled();
  // Selections by location, format, and identical content wait behind Quick select.
  await expect(page.getByLabel("Include Cache", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Quick select" }).click();
  await page.getByLabel("Include Cache", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Cache copy of track.mp3", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText(/^1 selected \/ 3 deletable/)).toBeVisible();
  await workRoot.click();
  await expect(page.getByText(/^3 selected \/ 3 deletable/)).toBeVisible();

  await page.getByRole("button", { name: "Review file deletion" }).click();
  await expect(page.getByRole("heading", { name: "Review file deletion" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Final confirmation" })).toBeVisible();
  const mediaRequestsBeforeDelete = mediaRequests;
  await page.getByRole("button", { name: "Delete files only" }).click();
  await expect.poll(() => cleanupBodies).toHaveLength(1);
  // A finished deletion reloads the detail's files in place.
  await expect.poll(() => mediaRequests).toBeGreaterThan(mediaRequestsBeforeDelete);
  await expect(page.getByRole("heading", { name: work.title, exact: true })).toBeVisible();
  expect(cleanupBodies[0]).toEqual({
    mode: "files_only",
    targets: [
      { kind: "cache", locationId: 2 },
      { kind: "local", locationId: 1 },
      { kind: "local_root", locationId: 1, folderId: 101, expectedPath: work.primaryCode },
    ],
  });
});

test("@desktop wide work detail lists source actions inside Source info", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    work: { ...work, sourcePresence: [localPresence] },
    detailLocalFolders: [localRootFolder(103)],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();

  const sourceActions = page
    .getByRole("complementary", { name: "Source info", exact: true })
    .getByRole("group", { name: /Source actions for/ });
  await expect(sourceActions.getByRole("button", { name: "Refresh local files", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Source actions for/ })).toHaveCount(0);
  await sourceActions.getByRole("button", { name: "Manage files", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Manage files" })).toBeVisible();
});

test("@desktop Edit files lists the family's sources and applies the reviewed folder", async ({ page }) => {
  const applied: Record<string, unknown>[] = [];
  const localFile = (id: number, name: string): MediaItem => ({
    id,
    parentId: null,
    kind: "audio",
    title: name,
    discNo: null,
    trackNo: id,
    durationSeconds: 10,
    sizeBytes: 12,
    fingerprint: `test-${id}`,
    progress: null,
    locations: [
      {
        id,
        fileSourceId: 1,
        fileSourceCode: "local",
        fileSourceName: "Local",
        locationType: "local",
        path: `${work.primaryCode}/${name}`,
        streamUrl: `/api/media/${id}/stream`,
        downloadUrl: "",
        remoteHash: "",
        sizeBytes: 12,
        durationSeconds: 10,
        availability: "available",
        lastCheckedAt: null,
      },
    ],
  });
  await mockApplication(
    page,
    undefined,
    false,
    1,
    0,
    [localFile(1, "track.mp3"), localFile(3, "extra.mp3")],
    undefined,
    {
      work: { ...work, sourcePresence: [localPresence] },
      detailLocalFolders: [localRootFolder(104)],
      authenticated: true,
      permissions: rolePermissions.admin,
    },
  );
  await page.route(`**/api/works/${work.id}/folder-edit/sources`, (route) =>
    route.fulfill({
      json: {
        workId: work.id,
        primaryCode: work.primaryCode,
        warnings: [],
        editions: [
          {
            workId: work.id,
            primaryCode: work.primaryCode,
            title: work.title,
            metadataLanguage: "JPN",
            editionLabel: "",
            translationKind: "origin",
            classificationSource: "",
            makerId: "",
            originMakerId: "",
            origin: true,
            localRoots: [localRootFolder(104)],
            sources: [
              {
                sourceId: 1,
                sourceCode: "example_remote_a",
                displayName: "Example Remote A",
                status: "available",
                remoteId: "",
                primaryCode: work.primaryCode,
                title: work.title,
                coverUrl: "",
                workId: work.id,
                hasRemote: true,
                hasTracked: false,
                hasCache: false,
                hasLocal: true,
                error: "",
                elapsedMs: 0,
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route(`**/api/works/${work.id}/folder-edit`, async (route) => {
    applied.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 202,
      json: { runId: 41, jobId: 42, workId: work.id, primaryCode: work.primaryCode, status: "queued" },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await page
    .getByRole("complementary", { name: "Source info", exact: true })
    .getByRole("button", { name: "Manage files", exact: true })
    .click();
  await page.getByRole("dialog", { name: "Manage files" }).getByRole("button", { name: "Edit files" }).click();

  const editor = page.getByRole("dialog", { name: "Edit files" });
  const sources = editor.getByRole("complementary", { name: "Sources", exact: true });
  await expect(
    sources.getByRole("group", { name: "Local" }).getByRole("button", { name: /This folder/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    sources.getByRole("group", { name: "Remote" }).getByRole("button", { name: /Example Remote A/ }),
  ).toBeVisible();
  const result = editor.getByRole("region", { name: "Final folder", exact: true });
  await expect(result.getByText("Keep", { exact: true })).toHaveCount(2);
  await expect(editor.getByRole("button", { name: "Apply changes" })).toBeDisabled();

  // Clearing a file of the edited folder takes it out of the final folder.
  await editor.getByRole("checkbox", { name: "Select extra.mp3", exact: true }).click();
  await expect(result.getByText("Remove 1", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Apply changes" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Final confirmation" })).toBeVisible();
  await page.getByRole("button", { name: "Delete files only" }).click();

  await expect.poll(() => applied).toHaveLength(1);
  expect(applied[0]).toEqual({
    folderId: 104,
    additions: [],
    removeLocationIds: [3],
    decisions: [],
    requestId: expect.stringMatching(/^edit:/),
  });
  await expect(editor).toBeHidden();
  await expect(page.getByText("Files updated in workflow #41.", { exact: true })).toBeVisible();
});

test("@desktop Manage lyrics resolves a lyrics conflict in place of deleting the file first", async ({ page }) => {
  const plans: Record<string, unknown>[] = [];
  const applied: Record<string, unknown>[] = [];
  const localFile = (id: number, kind: string, name: string): MediaItem => ({
    id,
    parentId: null,
    kind,
    title: name,
    discNo: null,
    trackNo: kind === "audio" ? id : null,
    durationSeconds: kind === "audio" ? 10 : null,
    sizeBytes: 12,
    fingerprint: `test-${id}`,
    progress: null,
    locations: [
      {
        id,
        fileSourceId: 1,
        fileSourceCode: "local",
        fileSourceName: "Local",
        locationType: "local",
        path: `${work.primaryCode}/${name}`,
        streamUrl: kind === "audio" ? `/api/media/${id}/stream` : "",
        downloadUrl: "",
        remoteHash: "",
        sizeBytes: 12,
        durationSeconds: kind === "audio" ? 10 : null,
        availability: "available",
        lastCheckedAt: null,
      },
    ],
  });
  await mockApplication(
    page,
    undefined,
    false,
    1,
    0,
    [
      localFile(1, "audio", "track.mp3"),
      localFile(2, "text", "track.mp3.vtt"),
      localFile(3, "text", "lyrics_kikoto/ja/track.mp3.vtt"),
    ],
    undefined,
    {
      work: { ...work, sourcePresence: [localPresence] },
      detailLocalFolders: [localRootFolder(104)],
      authenticated: true,
      permissions: rolePermissions.admin,
    },
  );
  await page.route(`**/api/works/${work.id}/folder-edit/sources`, (route) =>
    route.fulfill({
      json: {
        workId: work.id,
        primaryCode: work.primaryCode,
        warnings: [],
        editions: [
          {
            workId: work.id,
            primaryCode: work.primaryCode,
            title: work.title,
            metadataLanguage: "JPN",
            editionLabel: "",
            origin: true,
            localRoots: [localRootFolder(104)],
            sources: [],
          },
        ],
      },
    }),
  );
  await page.route(`**/api/works/${work.id}/lyrics-edit/plan`, async (route) => {
    const request = route.request().postDataJSON() as { decisions: { resolution: string }[] };
    plans.push(request);
    const replace = request.decisions.some((decision) => decision.resolution === "replace");
    const target = `${work.primaryCode}/lyrics_kikoto/ja/track.mp3.vtt`;
    await route.fulfill({
      json: {
        workId: work.id,
        folderId: 104,
        saveRoot: work.primaryCode,
        removals: [],
        summary: {
          add: replace ? 1 : 0,
          move: replace ? 1 : 0,
          copy: 0,
          download: 0,
          skip: 0,
          conflict: replace ? 0 : 1,
          remove: 0,
        },
        items: [
          {
            itemKey: "folder:track.mp3.vtt",
            path: "track.mp3.vtt",
            kind: "text",
            sizeBytes: 12,
            sourceKind: "folder",
            action: replace ? "move_local" : "conflict",
            status: replace ? "replace_target" : "target_conflict",
            sourcePath: "",
            localSourcePath: `${work.primaryCode}/track.mp3.vtt`,
            cachePath: "",
            targetPath: target,
            mediaItemId: 0,
            localPaths: [],
            targetExists: true,
            targetConflict: !replace,
            targetConflictReason: replace ? "" : "a different file with this name is already there",
            targetSizeBytes: 12,
            originalTargetPath: target,
            resolution: replace ? "replace" : "auto",
            remoteSourceId: 0,
            remoteSourceCode: "",
            remoteSourceName: "",
            remotePath: "",
            sourceOptions: [],
            language: "ja-jp",
          },
        ],
      },
    });
  });
  await page.route(`**/api/works/${work.id}/lyrics-edit`, async (route) => {
    applied.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      json: {
        workId: work.id,
        saveRoot: work.primaryCode,
        moved: 1,
        copied: 0,
        downloaded: 0,
        removed: 0,
        skipped: 0,
        assigned: 1,
      },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await page
    .getByRole("complementary", { name: "Source info", exact: true })
    .getByRole("button", { name: "Manage files", exact: true })
    .click();

  // A lyrics file in a language's lyrics folder has no row of its own until it is asked for.
  const files = page.getByRole("dialog", { name: "Manage files" });
  const managedRow = files.getByRole("checkbox", { name: "Select lyrics_kikoto", exact: true });
  await expect(managedRow).toHaveCount(0);
  const note = files.getByRole("note");
  await expect(note).toContainText("Lyrics managed by Kikoto");
  await note.getByRole("checkbox", { name: "Show in the list" }).click();
  await expect(managedRow).toBeVisible();
  await note.getByRole("checkbox", { name: "Show in the list" }).click();
  await expect(managedRow).toHaveCount(0);

  // Managing a file as lyrics opens the lyrics files with that file selected.
  await files.getByRole("checkbox", { name: "Select track.mp3.vtt", exact: true }).click();
  await files.getByRole("button", { name: /Manage as lyrics/ }).click();
  const lyrics = page.getByRole("dialog", { name: "Manage lyrics" });
  await expect(lyrics.getByRole("tab", { name: /Lyrics files/ })).toHaveAttribute("aria-selected", "true");
  await expect(lyrics.getByRole("button", { name: /Other lyrics in this folder/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(lyrics.getByRole("checkbox", { name: "Select track.mp3.vtt", exact: true })).toBeChecked();

  // The work's own files are copied by default; this edit moves them instead.
  const folderMode = lyrics.getByRole("combobox", { name: "The work's own files" });
  await expect(folderMode).toContainText("Copy into lyrics_kikoto");
  await folderMode.click();
  await page.getByRole("option", { name: "Move into lyrics_kikoto" }).click();

  // The language is the manager's statement, so nothing is previewed before it is chosen.
  const apply = lyrics.getByRole("button", { name: "Apply changes" });
  await expect(lyrics.getByText("Choose the language of the selected lyrics")).toBeVisible();
  await expect(apply).toBeDisabled();
  expect(plans).toHaveLength(0);
  await lyrics.getByRole("combobox", { name: "Language of these lyrics" }).click();
  await page.getByRole("option", { name: "Japanese" }).click();

  // The file the managed lyrics already hold is a conflict to decide here, not a file to delete first.
  await expect(lyrics.getByText("Conflicts to resolve: 1")).toBeVisible();
  expect(plans[0]).toEqual({
    folderId: 104,
    additions: [{ kind: "folder", path: "track.mp3.vtt", language: "ja-jp" }],
    removeLocationIds: [],
    decisions: [],
    assignments: [],
    folderMode: "move",
  });
  await expect(apply).toBeDisabled();
  await lyrics
    .getByRole("region", { name: "Managed lyrics" })
    .getByRole("combobox")
    .selectOption({ label: "Replace the file in the folder" });
  await expect(lyrics.getByText("Ready: add 1, remove 0")).toBeVisible();
  await apply.click();

  await expect.poll(() => applied).toHaveLength(1);
  expect(applied[0]).toEqual({
    folderId: 104,
    additions: [{ kind: "folder", path: "track.mp3.vtt", language: "ja-jp" }],
    removeLocationIds: [],
    decisions: [
      {
        itemKey: "folder:track.mp3.vtt",
        sourceId: 0,
        resolution: "replace",
        targetPath: "lyrics_kikoto/ja/track.mp3.vtt",
      },
    ],
    assignments: [{ audioMediaItemId: 1, itemKey: "folder:track.mp3.vtt" }],
    folderMode: "move",
  });
  await expect(
    page.getByText("Lyrics updated: 1 added, 0 deleted. Tracks assigned: 1.", { exact: true }),
  ).toBeVisible();
});

test("local Delete enables work forgetting only for a complete root and confirms its data boundary", async ({
  page,
}) => {
  const cleanupBodies: Record<string, unknown>[] = [];
  const mediaItems: MediaItem[] = [
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
    work: { ...work, sourcePresence: [localPresence] },
    detailLocalFolders: [localRootFolder(102)],
    cleanupRunSummary: { mode: "files_and_forget_work", work_forgotten: true, forgotten_family_count: 1 },
  });

  await page.goto("/");
  await page.getByText(work.title, { exact: true }).click();
  await page.getByRole("button", { name: /Source actions for/ }).click();
  await page.getByRole("menuitem", { name: "Manage files", exact: true }).click();

  // Forgetting a work deletes its complete folder, so it is offered only once everything is selected.
  const forgetButton = page.getByRole("button", { name: "Review deletion and forget work" });
  await expect(forgetButton).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Select track.mp3", exact: true }).click();
  await expect(forgetButton).toHaveCount(0);
  await page.getByRole("checkbox", { name: `Select work root ${work.primaryCode}`, exact: true }).click();
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
  // A forgotten work has no detail left, so the page returns to where it was opened from.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("detail-hero")).toHaveCount(0);
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
  const trackedPresences: SourcePresenceItem[] = [
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
  const trackedWork: Work = { ...work, availability: ["local", "tracked"], sourcePresence: trackedPresences };
  const mediaItems: MediaItem[] = [
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
  const availability: SourceAvailabilityResponse = {
    workCode: work.primaryCode,
    checkedAt: "2026-07-13T00:00:00Z",
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
    // Untrack and Check sources need a signed-in account with remote:track.
    authenticated: true,
    permissions: rolePermissions.contributor,
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
    ] satisfies LibrarySource[],
    sourceAvailability: availability,
    remoteDetail: remoteWorkDetailFixture({
      sourceId: 7,
      sourceCode: "remote_a",
      sourceName: "Remote A",
      remoteId: "1",
      primaryCode: work.primaryCode,
      remoteCode: work.primaryCode,
      title: work.title,
      circle: work.circle,
      rating: 4.5,
      sales: 10,
      releaseDate: work.releaseDate ?? "",
      durationSeconds: 10,
      importStatus: "tracked",
      workId: 1,
    }),
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
  await expect(localTab).toHaveAttribute("aria-pressed", "true");
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
  await selectLibrarySource(page, "Tracked");
  await page.getByText(work.title, { exact: true }).click();
  await expect(page).toHaveURL(/view=tracked/);
  await expect(page.locator('button[title^="Tracked:"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('button[title="Remote A: Available"]')).toBeVisible();
  await page.getByRole("button", { name: /Source actions for/ }).click();
  await page.getByRole("menuitem", { name: /Manage cache/ }).click();
  await page.getByRole("checkbox", { name: "Select all", exact: true }).click();
  await expect(page.getByText(/^1 selected \/ 1 deletable/)).toBeVisible();
  await page.getByRole("button", { name: "Review file deletion" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Delete files only" }).click();
  await expect.poll(() => cleanupBodies).toHaveLength(1);
  expect(cleanupBodies[0]).toEqual({ mode: "files_only", targets: [{ kind: "cache", locationId: 2 }] });
});

test("tracked library cards confirm Untrack in an anchored popover", async ({ page }) => {
  const untrackRequests: Array<{ workId: number; sourceId: number }> = [];
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    // Untrack and Check sources need a signed-in account with remote:track.
    authenticated: true,
    permissions: rolePermissions.contributor,
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
  await selectLibrarySource(page, "Tracked");

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
  await selectLibrarySource(page, "Example Remote");
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
  await selectLibrarySource(page, "Example Remote");
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
  await page.getByRole("button", { name: "Directory edition", exact: true }).click();
  const versionMenu = page.getByRole("dialog", { name: "Directory edition", exact: true });
  const versionMenuBox = await versionMenu.boundingBox();
  const viewport = page.viewportSize();
  expect(versionMenuBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(versionMenuBox!.x).toBeGreaterThanOrEqual(0);
  expect(versionMenuBox!.x + versionMenuBox!.width).toBeLessThanOrEqual(viewport!.width);
  await expect(versionMenu.getByRole("group", { name: "Japanese versions" })).toBeVisible();
  const englishCodes = versionMenu.getByRole("menu", { name: "English DLsite codes", exact: true });
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
  await selectLibrarySource(page, "Example Remote");
  await page.getByText("Remote Japanese work", { exact: true }).click();
  await expect(page).toHaveURL(/\/RJ00000051\?source=1/);
  const detailURL = page.url();
  const trackedTab = page.locator('button[title^="Tracked:"]');
  // Nothing is tracked yet, so there is no Tracked tab to browse.
  await expect(page.locator('button[title="Example Remote: Available"]')).toBeVisible();
  await expect(trackedTab).toHaveCount(0);

  await page.getByRole("button", { name: /Source actions for/ }).click();
  await page.getByRole("menuitem", { name: "Track", exact: true }).click();

  await expect.poll(() => trackControl.trackRequests).toHaveLength(1);
  await expect(page.getByText("Track workflow #91 queued.", { exact: true })).toBeVisible();
  expect(page.url()).toBe(detailURL);
  await expect(trackedTab).toHaveCount(0);

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
  await expect(trackedTab).toHaveCount(0);
  await page.getByRole("button", { name: /Source actions for/ }).click();
  await expect(page.getByRole("menuitem", { name: /^Track/ })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: /^Untrack/ })).toHaveCount(0);
});

test("persisted remote result opens the canonical detail with its remote source selected", async ({ page }) => {
  const trackRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/track"))
      trackRequests.push(request.url());
  });
  await mockRemoteSource(page, () => undefined, { persisted: true });
  await page.goto("/");
  await selectLibrarySource(page, "Example Remote");
  await page.getByText("Remote Japanese work", { exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/${work.primaryCode}\\?`));
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("remote");
  expect(new URL(page.url()).searchParams.get("source")).toBe("1");
  expect(new URL(page.url()).searchParams.get("remoteCode")).toBe("RJ00000051");
  await expect(page.locator('button[title="Example Remote: Available"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Previewing remote files from Example Remote.", { exact: true })).toBeVisible();
  expect(trackRequests).toEqual([]);
});
