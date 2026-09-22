import { type Page } from "@playwright/test";
import type { WorkMetadataPresentation, WorkMetadataSyncStatus, WorkTranslation } from "../../../src/lib/api";
import { syntheticWorkCode } from "../../../src/test-support/workCode";

export const work = {
  id: 1,
  primaryCode: syntheticWorkCode("RJ", 0),
  title: "Tagged mobile work",
  ageRating: "R18",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  releaseDate: "2026-01-01",
  coverUrl: "",
  dlsiteUrl: "",
  circle: "Test circle",
  circleExternalId: "RG00000001",
  rating: 4.5,
  ratingCount: 240,
  sales: 10,
  tags: ["ロリ"],
  userTags: [],
  voiceActors: [],
  voiceCredits: [],
  series: "",
  seriesTitleId: "",
  trackCount: 1,
  availableLocations: 1,
  availability: ["local"],
  sourcePresence: [],
  localFolders: [],
  progress: {
    mediaItemId: null,
    title: "",
    positionSeconds: 0,
    durationSeconds: null,
    lastPlayedAt: null,
    completed: false,
  },
  listeningStatus: "none",
  favorite: false,
  recommendScore: 0,
};

export const persistedTrack = {
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
  workCode: "RJ00000000",
  workTitle: "Tagged mobile work",
  coverUrl: "",
  circle: "Test circle",
  progress: null,
  progressRecordable: true,
  lyricsLocationId: null,
  lyricsTitle: "",
  locations: [
    {
      locationId: 1,
      locationType: "local",
      streamUrl: "/api/media/1/stream",
      sourceId: 1,
      sourceName: "Local",
      availability: "available",
    },
  ],
};

export const persistedPlayerTracks = new WeakMap<Page, (typeof persistedTrack)[]>();

export const playerQueueStorageBaseKey = "kikoto:player-queue:v2";

export const playerProgressStorageBaseKey = "kikoto:player-progress:v2";

export type MockWork = Omit<typeof work, "voiceActors" | "voiceCredits"> & {
  voiceActors: string[];
  voiceCredits: { personId: number; displayName: string }[];
};

type MockApplicationFixture = {
  work?: MockWork;
  recentWorks?: MockWork[];
  librarySources?: Record<string, unknown>[];
  sourceAvailability?: Record<string, unknown>;
  remoteDetail?: Record<string, unknown>;
  onSourceCheck?: () => void;
  onUntrack?: (workId: number, sourceId: number) => void;
  onLocalRefresh?: () => void;
  onMediaRequest?: () => void;
  mediaBusy?: boolean;
  authenticated?: boolean;
  permissions?: string[];
  onLyricsPreference?: (method: "PUT" | "DELETE", audioMediaItemId: number, lyricsMediaItemId: number | null) => void;
  beforeWorksResponse?: () => Promise<void>;
  beforeWorkDetailResponse?: (workId: number) => Promise<void>;
  detailTranslations?: WorkTranslation[];
  detailMetadataPresentation?: WorkMetadataPresentation;
  detailMetadataSync?: WorkMetadataSyncStatus;
  metadataSyncControl?: {
    runId: number;
    status: "queued" | "running" | "succeeded" | "partial" | "failed";
    detailReady?: boolean;
    postRequests: number;
    statusRequests: number;
    detailRequests: number;
  };
};

export type RemoteTrackControl = {
  status: "queued" | "running" | "succeeded" | "failed";
  trackRequests: string[];
  statusRequests: number;
  untracked: boolean;
  untrackRequests: string[];
};

export function silentWav(durationSeconds = 0.1) {
  const sampleCount = Math.round(8000 * durationSeconds);
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

export async function mockApplication(
  page: Page,
  onWorksRequest?: (url: URL) => void,
  failLocalAudio = false,
  workCount = 1,
  mediaDelayMs = 0,
  mediaItems: Record<string, unknown>[] = [],
  onCleanup?: (body: Record<string, unknown>) => void,
  fixture: MockApplicationFixture = {},
) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: fixture.authenticated
          ? {
              authenticated: true,
              user: {
                id: 1,
                username: "listener",
                displayName: "Listener",
                role: "user",
                permissions: fixture.permissions ?? ["library:read", "playback:use", "favorites:write"],
                devMode: true,
              },
            }
          : { authenticated: false },
      });
      return;
    }
    if (url.pathname === "/api/works/1/user-state" && route.request().method() === "PATCH") {
      await route.fulfill(
        fixture.authenticated
          ? { json: { workId: 1, listeningStatus: "want_to_listen", favorite: false } }
          : { status: 401, json: { error: "login required" } },
      );
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({ json: fixture.librarySources ?? [] });
      return;
    }
    if (url.pathname === "/api/favorite-lists") {
      await route.fulfill({ json: [{ id: 1, name: "Marked", description: "", sortOrder: -1, kind: "marked" }] });
      return;
    }
    if (url.pathname === "/api/works/1/favorite-lists") {
      await route.fulfill({
        json: [{ id: 1, name: "Marked", description: "", sortOrder: -1, kind: "marked", selected: false }],
      });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({
        json: {
          mode: "development",
          demoMode: false,
          anonymousAccessEnabled: true,
          cacheEnabled: false,
          directoryRoutingRules: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/recently-played-works") {
      await route.fulfill({ json: { works: fixture.recentWorks ?? [] } });
      return;
    }
    if (url.pathname === "/api/voices/7") {
      await route.fulfill({
        json: {
          personId: 7,
          displayName: "Example Voice",
          aliases: ["Example Voice"],
          aliasRecords: [],
          knownWorks: 1,
          localWorks: 1,
          remoteWorks: 0,
          cachedWorks: 0,
          playableWorks: 1,
          lastSeenAt: "2026-01-01T00:00:00Z",
          lastSyncedAt: "2026-01-01T00:00:00Z",
          syncState: "synced",
          syncReason: "",
          rating: null,
          note: "",
          favorite: false,
          userTags: [],
          sourceSummaries: [{ key: "local", sourceId: null, displayName: "Local", status: "available", count: 1 }],
          latestWork: null,
          works: [],
          remoteMatches: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/voices/7/works") {
      await route.fulfill({ json: { personId: 7, works: [] } });
      return;
    }
    if (url.pathname === "/api/voices/7/remote-matches") {
      await route.fulfill({
        json: {
          personId: 7,
          remoteMatches: [],
          refresh: {
            status: "succeeded",
            reason: "",
            lastStatus: "succeeded",
            generation: 1,
            lastAttemptAt: "",
            lastSuccessAt: "",
            complete: true,
            pagesFetched: 1,
            catalogWorks: 0,
            metadataQueued: 0,
            queries: ["Example Voice"],
            sources: [],
            error: "",
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/voices/7/merges") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/works") {
      onWorksRequest?.(url);
      await fixture.beforeWorksResponse?.();
      const fixtureWork = fixture.work ?? work;
      const works = Array.from({ length: workCount }, (_, index) =>
        index === 0
          ? fixtureWork
          : {
              ...fixtureWork,
              id: index + 1,
              primaryCode: syntheticWorkCode("RJ", index),
              title: `Mobile work ${index + 1}`,
            },
      );
      await route.fulfill({ json: { works, page: 1, pageSize: 24, total: works.length } });
      return;
    }
    if (url.pathname === `/api/works/${fixture.work?.primaryCode ?? work.primaryCode}/resolve`) {
      const fixtureWork = fixture.work ?? work;
      await route.fulfill({
        json: {
          requestedCode: fixtureWork.primaryCode,
          resolvedCode: fixtureWork.primaryCode,
          workId: fixtureWork.id,
          baseCode: "",
          isTranslation: false,
          title: fixtureWork.title,
          coverUrl: fixtureWork.coverUrl,
          circle: fixtureWork.circle,
          circleExternalId: fixtureWork.circleExternalId,
          releaseDate: fixtureWork.releaseDate,
          rating: fixtureWork.rating,
          sales: fixtureWork.sales,
          regularPrice: null,
          price: null,
          priceCurrency: "JPY",
          permanentlyFree: false,
          tags: fixtureWork.tags,
          voiceActors: fixtureWork.voiceActors,
          voiceCredits: fixtureWork.voiceCredits,
        },
      });
      return;
    }
    if (url.pathname === `/api/works/${fixture.work?.primaryCode ?? work.primaryCode}/source-availability`) {
      if (route.request().method() === "POST") fixture.onSourceCheck?.();
      await route.fulfill({
        json: fixture.sourceAvailability ?? {
          workCode: fixture.work?.primaryCode ?? work.primaryCode,
          checkedAt: "",
          sources: [],
        },
      });
      return;
    }
    if (
      fixture.remoteDetail &&
      url.pathname === `/api/remote-sources/7/works/${fixture.work?.primaryCode ?? work.primaryCode}/tracks`
    ) {
      await route.fulfill({
        json: {
          sourceId: fixture.remoteDetail.sourceId,
          sourceCode: fixture.remoteDetail.sourceCode,
          sourceName: fixture.remoteDetail.sourceName,
          remoteId: fixture.remoteDetail.remoteId,
          primaryCode: fixture.remoteDetail.primaryCode,
          remoteCode: fixture.remoteDetail.remoteCode,
          tracks: fixture.remoteDetail.tracks,
        },
      });
      return;
    }
    if (
      fixture.remoteDetail &&
      url.pathname === `/api/remote-sources/7/works/${fixture.work?.primaryCode ?? work.primaryCode}`
    ) {
      await route.fulfill({ json: fixture.remoteDetail });
      return;
    }
    if (url.pathname === "/api/works/1/metadata-sync" && route.request().method() === "POST") {
      const control = fixture.metadataSyncControl;
      if (!control) {
        await route.fulfill({ status: 404, json: { error: "Not mocked" } });
        return;
      }
      control.postRequests += 1;
      control.status = "succeeded";
      control.detailReady = true;
      await route.fulfill({
        status: 202,
        json: {
          runId: control.runId,
          jobId: control.runId + 1,
          workId: 1,
          primaryCode: (fixture.work ?? work).primaryCode,
          status: "queued",
          deduplicated: false,
        },
      });
      return;
    }
    const metadataRunMatch = url.pathname.match(/^\/api\/workflow-runs\/(\d+)$/);
    if (
      metadataRunMatch &&
      fixture.metadataSyncControl &&
      Number(metadataRunMatch[1]) === fixture.metadataSyncControl.runId
    ) {
      fixture.metadataSyncControl.statusRequests += 1;
      await route.fulfill({
        json: {
          id: fixture.metadataSyncControl.runId,
          workflowCode: "metadata_family_sync",
          displayName: "Refresh metadata",
          status: fixture.metadataSyncControl.status,
          triggerType: "manual",
          triggerReason: "work_detail",
          createdAt: "2026-01-01T00:00:00Z",
          startedAt: "2026-01-01T00:00:00Z",
          finishedAt: fixture.metadataSyncControl.status === "running" ? "" : "2026-01-01T00:01:00Z",
          summaryJson: "{}",
          nodeRunCount: 1,
          completedNodeRuns: fixture.metadataSyncControl.status === "running" ? 0 : 1,
          failedNodeRuns: 0,
          skippedNodeRuns: 0,
          jobCount: 1,
          completedJobs: fixture.metadataSyncControl.status === "running" ? 0 : 1,
          failedJobs: 0,
          skippedJobs: 0,
          progressBytesCurrent: 0,
          progressBytesTotal: 0,
          progressBytesUnknownItems: 0,
          candidateCount: 0,
          pendingCandidates: 0,
          acceptedCandidates: 0,
          rejectedCandidates: 0,
          reviewedAt: "",
          reviewedByUserId: null,
          definitionId: null,
          triggerId: null,
          nodeRuns: [],
          graphJson: "{}",
        },
      });
      return;
    }
    const metadataEventsMatch = url.pathname.match(/^\/api\/workflow-runs\/(\d+)\/events$/);
    if (
      metadataEventsMatch &&
      fixture.metadataSyncControl &&
      Number(metadataEventsMatch[1]) === fixture.metadataSyncControl.runId
    ) {
      await route.fulfill({ json: [] });
      return;
    }
    const metadataStreamMatch = url.pathname.match(/^\/api\/workflow-runs\/(\d+)\/events\/stream$/);
    if (
      metadataStreamMatch &&
      fixture.metadataSyncControl &&
      Number(metadataStreamMatch[1]) === fixture.metadataSyncControl.runId
    ) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      return;
    }
    const detailMatch = url.pathname.match(/^\/api\/works\/(\d+)$/);
    if (detailMatch) {
      const id = Number(detailMatch[1]);
      await fixture.beforeWorkDetailResponse?.(id);
      if (id === 1 && fixture.metadataSyncControl) fixture.metadataSyncControl.detailRequests += 1;
      const fixtureWork = fixture.work ?? work;
      const detailWork =
        id === 1
          ? fixtureWork
          : {
              ...fixtureWork,
              id,
              primaryCode: syntheticWorkCode("RJ", id - 1),
              title: `Mobile work ${id}`,
            };
      await route.fulfill({
        json: {
          ...detailWork,
          baseCode: "",
          metadataLanguage:
            fixture.metadataSyncControl?.detailReady || fixture.detailMetadataSync?.status !== "not_synced"
              ? "JPN"
              : "",
          workType: "audio",
          titleKana: "",
          description: "",
          ageRating: "",
          durationSeconds: null,
          dlsiteFetchedAt: "",
          voiceCredits: detailWork.voiceCredits,
          translations: fixture.detailTranslations ?? [],
          ...(fixture.detailMetadataPresentation ? { metadataPresentation: fixture.detailMetadataPresentation } : {}),
          metadataSync: fixture.metadataSyncControl?.detailReady
            ? { status: "available", checkedAt: "2026-01-01T00:01:00Z" }
            : (fixture.detailMetadataSync ?? { status: "available", checkedAt: "" }),
          manualOverrides: {},
          mediaItems: url.searchParams.get("includeMedia") === "false" ? [] : mediaItems,
        },
      });
      return;
    }
    const mediaMatch = url.pathname.match(/^\/api\/works\/(\d+)\/media$/);
    if (mediaMatch) {
      fixture.onMediaRequest?.();
      if (mediaDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, mediaDelayMs));
      if (fixture.mediaBusy) {
        await route.fulfill({
          status: 503,
          json: { error: "database is busy; please retry", code: "database_busy", retryable: true },
        });
        return;
      }
      const workId = Number(mediaMatch[1]);
      const restoredTracks =
        mediaItems.length > 0 ? [] : (persistedPlayerTracks.get(page) ?? []).filter((track) => track.workId === workId);
      const restoredMediaItems = restoredTracks.map((track) => ({
        id: track.mediaItemId,
        parentId: null,
        kind: "audio",
        title: track.title,
        discNo: null,
        trackNo: 1,
        durationSeconds: null,
        sizeBytes: track.sizeBytes,
        progress: track.progress,
        locations: track.locations.map((location) => ({
          id: location.locationId,
          fileSourceId: location.sourceId,
          fileSourceCode: "test",
          fileSourceName: location.sourceName,
          locationType: location.locationType,
          path: `${track.workCode}/${track.title}`,
          streamUrl: location.streamUrl,
          downloadUrl: "",
          remoteHash: "",
          sizeBytes: track.sizeBytes,
          durationSeconds: null,
          availability: location.availability,
          lastCheckedAt: null,
        })),
      }));
      await route.fulfill({ json: { workId, mediaItems: mediaItems.length > 0 ? mediaItems : restoredMediaItems } });
      return;
    }
    if (url.pathname === "/api/media/cleanup" && route.request().method() === "POST") {
      onCleanup?.(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 202, json: { runId: 41, jobId: 42, status: "queued", queued: 2 } });
      return;
    }
    const untrackMatch = url.pathname.match(/^\/api\/works\/(\d+)\/tracked-sources\/(\d+)$/);
    if (untrackMatch && route.request().method() === "DELETE") {
      const workId = Number(untrackMatch[1]);
      const sourceId = Number(untrackMatch[2]);
      fixture.onUntrack?.(workId, sourceId);
      await route.fulfill({
        json: {
          workId,
          sourceId,
          status: "succeeded",
          clearedCaches: 0,
          deletedFiles: 0,
          cachePaths: [],
          trackedCleared: true,
          workPreserved: true,
          localPreserved: true,
        },
      });
      return;
    }
    if (url.pathname === "/api/works/1/local-files/refresh" && route.request().method() === "POST") {
      fixture.onLocalRefresh?.();
      await route.fulfill({
        json: { workId: 1, fileSourceId: 1, status: "succeeded", indexedFiles: mediaItems.length },
      });
      return;
    }
    if (url.pathname === "/api/workflow-runs/41") {
      await route.fulfill({ json: { id: 41, status: "succeeded" } });
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
    const lyricsPreferenceMatch = url.pathname.match(/^\/api\/media\/(\d+)\/lyrics-preference$/);
    if (lyricsPreferenceMatch && (route.request().method() === "PUT" || route.request().method() === "DELETE")) {
      const audioMediaItemId = Number(lyricsPreferenceMatch[1]);
      const lyricsMediaItemId =
        route.request().method() === "PUT"
          ? Number((route.request().postDataJSON() as { lyricsMediaItemId?: number }).lyricsMediaItemId ?? 0)
          : null;
      fixture.onLyricsPreference?.(route.request().method() as "PUT" | "DELETE", audioMediaItemId, lyricsMediaItemId);
      await route.fulfill({ json: { audioMediaItemId, lyricsMediaItemId } });
      return;
    }
    const textPreviewMatch = url.pathname.match(/^\/api\/media\/(\d+)\/text$/);
    if (textPreviewMatch) {
      const locationID = Number(textPreviewMatch[1]);
      await route.fulfill({
        json:
          locationID === 9
            ? {
                path: "lyrics.lrc",
                content:
                  "[00:00.00]First line\n[00:05.00]Second line\n[00:10.00]Third line\n[00:15.00]Fourth line\n[00:20.00]Fifth line\n[00:25.00]Sixth line\n[00:30.00]Seventh line\n[00:35.00]Eighth line",
              }
            : { path: "notes.txt", content: "Synthetic notes" },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not mocked" } });
  });
}

export async function seedPlayer(page: Page, track = persistedTrack, principalID: number | null = null) {
  await seedPlayerQueue(page, [track], principalID);
}

export async function seedPlayerQueue(
  page: Page,
  tracks: (typeof persistedTrack)[],
  principalID: number | null = null,
) {
  persistedPlayerTracks.set(page, tracks);
  await page.addInitScript(
    ({ tracks, principalID, baseKey }) => {
      const principal = principalID === null ? "anonymous" : `user-${principalID}`;
      const key = `${baseKey}:${encodeURIComponent(window.location.origin)}:${principal}`;
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          queue: tracks,
          currentIndex: 0,
          mode: "order",
          playbackRate: 1,
          sleepTimer: null,
        }),
      );
    },
    { tracks, principalID, baseKey: playerQueueStorageBaseKey },
  );
}

export function queuedTrackFixture(index: number, title: string) {
  const locationId = index + 1;
  const streamUrl = `/api/media/${locationId}/stream`;
  return {
    ...persistedTrack,
    queueItemId: `e2e-track-${locationId}`,
    mediaItemId: locationId,
    locationId,
    title,
    streamUrl,
    locations: [{ ...persistedTrack.locations[0], locationId, streamUrl }],
  };
}

export async function readScopedPlayerState(page: Page, baseKey: string, principalID: number | null = null) {
  return page.evaluate(
    ({ baseKey, principalID }) => {
      const principal = principalID === null ? "anonymous" : `user-${principalID}`;
      const key = `${baseKey}:${encodeURIComponent(window.location.origin)}:${principal}`;
      return JSON.parse(localStorage.getItem(key) ?? "null");
    },
    { baseKey, principalID },
  );
}

export async function mockRemoteSource(
  page: Page,
  onRemoteRequest: (url: URL) => void,
  options: {
    conflict?: boolean;
    fetchRootConflict?: boolean;
    persisted?: boolean;
    authenticated?: boolean;
    permissions?: string[];
    remoteStatus?: "ok" | "disabled" | "unavailable";
    remoteErrorURL?: string;
    trackControl?: RemoteTrackControl;
  } = {},
) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const workMaterialized = options.trackControl?.status === "succeeded";
    const trackCompleted = workMaterialized && !options.trackControl?.untracked;
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json:
          options.authenticated === false
            ? { authenticated: false }
            : {
                authenticated: true,
                user: {
                  id: 1,
                  username: "listener",
                  displayName: "Listener",
                  role: "user",
                  permissions: options.permissions ?? ["library:read", "playback:use", "downloads:manage"],
                  devMode: true,
                },
              },
      });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({
        json: [
          {
            id: 1,
            code: "example_remote",
            displayName: "Example Remote",
            sourceType: "kikoeru_compatible",
            enabled: options.remoteStatus !== "disabled",
          },
        ],
      });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({
        json: {
          mode: "development",
          demoMode: false,
          anonymousAccessEnabled: true,
          cacheEnabled: false,
          directoryRoutingRules: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/works") {
      await route.fulfill({ json: { works: [work], page: 1, pageSize: 24, total: 1 } });
      return;
    }
    if (
      url.pathname === `/api/works/${work.primaryCode}/source-availability` ||
      url.pathname === "/api/works/RJ00000051/source-availability"
    ) {
      const remoteOnlyWork = url.pathname.includes("RJ00000051");
      await route.fulfill({
        json: {
          workCode: remoteOnlyWork ? "RJ00000051" : work.primaryCode,
          checkedAt: "2026-07-17T00:00:00Z",
          sources: [
            {
              sourceId: 1,
              sourceCode: "example_remote",
              displayName: "Example Remote",
              status: "available",
              remoteId: "1",
              primaryCode: remoteOnlyWork ? "RJ00000051" : work.primaryCode,
              title: remoteOnlyWork ? "Remote Japanese work" : work.title,
              coverUrl: "",
              workId: remoteOnlyWork ? (workMaterialized ? 91 : null) : 1,
              hasRemote: remoteOnlyWork ? workMaterialized : true,
              hasTracked: remoteOnlyWork ? trackCompleted : false,
              hasCache: false,
              hasLocal: !remoteOnlyWork,
              error: "",
              elapsedMs: 1,
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/api/works/91") {
      await route.fulfill({
        json: {
          ...work,
          id: 91,
          primaryCode: "RJ00000051",
          title: "Remote Japanese work",
          circle: "Remote circle",
          ratingCount: 240,
          availability: trackCompleted ? ["tracked", "remote"] : ["remote"],
          sourcePresence: trackCompleted
            ? [
                {
                  type: "tracked",
                  availability: "available",
                  workId: 91,
                  fileSourceId: 1,
                  fileSourceCode: "example_remote",
                  fileSourceName: "Example Remote",
                  remoteCode: "RJ00000051",
                  forked: true,
                },
              ]
            : [
                {
                  type: "source",
                  availability: "available",
                  workId: 91,
                  fileSourceId: 1,
                  fileSourceCode: "example_remote",
                  fileSourceName: "Example Remote",
                  remoteCode: "RJ00000051",
                },
              ],
          baseCode: "",
          metadataLanguage: "JPN",
          workType: "audio",
          titleKana: "",
          description: "",
          durationSeconds: 10,
          dlsiteFetchedAt: "",
          translations: [],
          manualOverrides: {},
          mediaItems: [
            {
              id: 91,
              parentId: null,
              kind: "audio",
              title: "track.mp3",
              discNo: null,
              trackNo: 1,
              durationSeconds: 10,
              sizeBytes: 12,
              locations: [
                {
                  id: 91,
                  fileSourceId: 1,
                  fileSourceCode: "example_remote",
                  fileSourceName: "Example Remote",
                  locationType: "remote_stream",
                  path: "track.mp3",
                  streamUrl: "/stream",
                  downloadUrl: "/download",
                  remoteHash: "hash",
                  sizeBytes: 12,
                  durationSeconds: 10,
                  availability: "available",
                  lastCheckedAt: null,
                },
              ],
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/api/works/1") {
      await route.fulfill({
        json: {
          ...work,
          baseCode: "",
          metadataLanguage: "JPN",
          workType: "audio",
          titleKana: "",
          description: "",
          durationSeconds: null,
          dlsiteFetchedAt: "",
          translations: [],
          manualOverrides: {},
          mediaItems: [],
        },
      });
      return;
    }
    if (url.pathname === "/api/works/1/media") {
      await route.fulfill({ json: { workId: 1, mediaItems: [] } });
      return;
    }
    if (url.pathname === "/api/favorite-lists") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/api/recently-played-works") {
      await route.fulfill({ json: { works: [] } });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works") {
      onRemoteRequest(url);
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      const sort = url.searchParams.get("sort") ?? "recent";
      if (options.remoteStatus && options.remoteStatus !== "ok") {
        await route.fulfill({
          json: {
            sourceId: 1,
            page: pageNumber,
            pageSize: 24,
            total: 0,
            status: options.remoteStatus,
            error: {
              code: options.remoteStatus,
              message:
                options.remoteStatus === "disabled"
                  ? "Remote source is disabled."
                  : "Remote source service is unavailable.",
              url: options.remoteErrorURL,
              retryable: options.remoteStatus === "unavailable",
            },
            sort,
            direction: url.searchParams.get("direction") ?? "desc",
            sortApplied: false,
            works: [],
          },
        });
        return;
      }
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
          works: [
            {
              remoteId: String(pageNumber),
              primaryCode:
                options.persisted && pageNumber === 1
                  ? work.primaryCode
                  : pageNumber === 1
                    ? "RJ00000051"
                    : "RJ00000052",
              remoteCode: pageNumber === 1 ? "RJ00000051" : "RJ00000052",
              title: pageNumber === 1 ? "Remote Japanese work" : "Remote page two work",
              releaseDate: "2026-04-03",
              updatedAt: "2026-04-03",
              coverUrl: "",
              circle: "Remote circle",
              ageRating: "R15",
              rating: 4.5,
              ratingCount: 240,
              sales: 100,
              tags: ["退廃/背徳/インモラル"],
              importStatus: trackCompleted ? "tracked" : workMaterialized ? "synced" : "remote_only",
              remotePlayable: true,
              workId: pageNumber === 1 && workMaterialized ? 91 : options.persisted && pageNumber === 1 ? 1 : null,
              favorite: false,
              listeningStatus: "none",
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works/RJ00000051/tracks" && route.request().method() === "GET") {
      await route.fulfill({
        json: {
          sourceId: 1,
          sourceCode: "example_remote",
          sourceName: "Example Remote",
          remoteId: "1",
          primaryCode: "RJ00000051",
          remoteCode: "RJ00000051",
          tracks: [
            {
              type: "audio",
              title: "track.mp3",
              hash: "hash",
              streamUrl: "/stream",
              downloadUrl: "/download",
              durationSeconds: 10,
              sizeBytes: 12,
              cacheLocationId: null,
              cachePath: "",
              cacheAvailable: false,
              localLocationId: null,
              localPath: "",
              localAvailable: false,
              children: [],
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works/RJ00000051" && route.request().method() === "GET") {
      await route.fulfill({
        json: {
          sourceId: 1,
          sourceCode: "example_remote",
          sourceName: "Example Remote",
          remoteId: "1",
          primaryCode: "RJ00000051",
          remoteCode: "RJ00000051",
          title: "Remote Japanese work",
          coverUrl: "",
          sourceUrl: "",
          circle: "Remote circle",
          rating: 4.5,
          ratingCount: 240,
          sales: 100,
          ageRating: "",
          releaseDate: "2026-04-03",
          durationSeconds: null,
          tags: [],
          voiceActors: [],
          importStatus: trackCompleted ? "tracked" : workMaterialized ? "synced" : "remote_only",
          workId: workMaterialized ? 91 : null,
          languageEditions: [
            {
              remoteCode: "RJ00000051",
              language: "JPN",
              label: "Japanese",
              displayOrder: 1,
              current: true,
              origin: true,
            },
            {
              remoteCode: "RJ00000053",
              language: "ENG",
              label: "English",
              displayOrder: 2,
              current: false,
              origin: false,
            },
          ],
          tracks: [
            {
              type: "audio",
              title: "track.mp3",
              hash: "hash",
              streamUrl: "/stream",
              downloadUrl: "/download",
              durationSeconds: 10,
              sizeBytes: 12,
              cacheLocationId: null,
              cachePath: "",
              cacheAvailable: false,
              localLocationId: null,
              localPath: "",
              localAvailable: false,
              children: [],
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works/RJ00000053/tracks" && route.request().method() === "GET") {
      await route.fulfill({
        json: {
          sourceId: 1,
          sourceCode: "example_remote",
          sourceName: "Example Remote",
          remoteId: "3",
          primaryCode: "RJ00000053",
          remoteCode: "RJ00000053",
          tracks: [
            {
              type: "audio",
              title: "english.mp3",
              hash: "english",
              streamUrl: "/stream-en",
              downloadUrl: "/download-en",
              durationSeconds: 10,
              sizeBytes: 12,
              cacheLocationId: null,
              cachePath: "",
              cacheAvailable: false,
              localLocationId: null,
              localPath: "",
              localAvailable: false,
              children: [],
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works/RJ00000053" && route.request().method() === "GET") {
      await route.fulfill({
        json: {
          sourceId: 1,
          sourceCode: "example_remote",
          sourceName: "Example Remote",
          remoteId: "3",
          primaryCode: "RJ00000053",
          remoteCode: "RJ00000053",
          title: "Remote English work",
          coverUrl: "",
          sourceUrl: "",
          circle: "Remote circle",
          rating: 4.5,
          ratingCount: 240,
          sales: 100,
          ageRating: "",
          releaseDate: "2026-04-03",
          durationSeconds: null,
          tags: [],
          voiceActors: [],
          importStatus: "remote_only",
          workId: null,
          languageEditions: [
            {
              remoteCode: "RJ00000051",
              language: "JPN",
              label: "Japanese",
              displayOrder: 1,
              current: false,
              origin: true,
            },
            {
              remoteCode: "RJ00000053",
              language: "ENG",
              label: "English",
              displayOrder: 2,
              current: true,
              origin: false,
            },
          ],
          tracks: [
            {
              type: "audio",
              title: "english.mp3",
              hash: "english",
              streamUrl: "/stream-en",
              downloadUrl: "/download-en",
              durationSeconds: 10,
              sizeBytes: 12,
              cacheLocationId: null,
              cachePath: "",
              cacheAvailable: false,
              localLocationId: null,
              localPath: "",
              localAvailable: false,
              children: [],
            },
          ],
        },
      });
      return;
    }
    const trackMatch = url.pathname.match(/^\/api\/remote-sources\/1\/works\/([^/]+)\/track$/);
    if (trackMatch && route.request().method() === "POST") {
      const requestedCode = decodeURIComponent(trackMatch[1]).toUpperCase();
      options.trackControl?.trackRequests.push(url.pathname);
      const body = route.request().postDataJSON() as { triggerReason?: string };
      await route.fulfill({
        status: 202,
        json: {
          runId: 91,
          jobId: 92,
          workId: null,
          primaryCode: requestedCode,
          status: "queued",
          triggerReason: body.triggerReason ?? "manual_track",
          deduplicated: false,
        },
      });
      return;
    }
    if (url.pathname === "/api/remote-track-runs/91") {
      if (!options.trackControl) {
        await route.fulfill({ status: 404, json: { error: "Track run not found" } });
        return;
      }
      options.trackControl.statusRequests += 1;
      const summaryJson =
        options.trackControl.status === "succeeded"
          ? JSON.stringify({ work_id: 91, primary_code: "RJ00000051", source_id: 1, forked: true })
          : "{}";
      await route.fulfill({ json: { runId: 91, status: options.trackControl.status, summaryJson } });
      return;
    }
    if (url.pathname === "/api/works/91/tracked-sources/1" && route.request().method() === "DELETE") {
      if (options.trackControl) {
        options.trackControl.untracked = true;
        options.trackControl.untrackRequests.push(url.pathname);
      }
      await route.fulfill({
        json: {
          workId: 91,
          sourceId: 1,
          status: "succeeded",
          clearedCaches: 0,
          deletedFiles: 0,
          cachePaths: [],
          trackedCleared: true,
          workPreserved: true,
          localPreserved: true,
        },
      });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works/RJ00000051/fetch-plan") {
      const requestBody = route.request().postDataJSON() as {
        decisions?: Array<{ sourceId?: number; resolution?: string; targetPath?: string }>;
      };
      const decision = requestBody.decisions?.[0];
      const unresolvedConflict = Boolean(options.conflict && (!decision?.resolution || decision.resolution === "auto"));
      const fetchRootConflict = Boolean(options.fetchRootConflict);
      const keepBoth = decision?.resolution === "keep_both";
      await route.fulfill({
        json: {
          sourceId: 1,
          primaryCode: "RJ00000051",
          saveRoot: "example_remote/RJ/000/RJ00000051",
          fetchRoot: fetchRootConflict
            ? {
                rootPath: "example_remote",
                status: "conflict",
                conflict: true,
                message:
                  "This Fetch folder already exists and is not managed by Kikoto. Do not use it for manually managed works.",
              }
            : { rootPath: "example_remote", status: "ready", conflict: false, message: "" },
          localFiles: [{ mediaItemId: 2, path: "Existing/RJ00000051/local.txt", sizeBytes: 4, available: true }],
          items: [
            {
              itemKey: "remote:track.mp3",
              path: "track.mp3",
              kind: "audio",
              sizeBytes: 12,
              sourceKind: "remote",
              action: unresolvedConflict ? "conflict" : "cache_download",
              status: unresolvedConflict ? "target_conflict" : "remote_only",
              sourcePath: "/download",
              localSourcePath: "",
              cachePath: "remote/track.mp3",
              targetPath: keepBoth
                ? "example_remote/RJ/000/RJ00000051/track (mirror).mp3"
                : "example_remote/RJ/000/RJ00000051/track.mp3",
              originalTargetPath: "example_remote/RJ/000/RJ00000051/track.mp3",
              resolution: decision?.resolution ?? "auto",
              remoteSourceId: decision?.sourceId ?? 1,
              remoteSourceCode: decision?.sourceId === 2 ? "mirror" : "example_remote",
              remoteSourceName: decision?.sourceId === 2 ? "Mirror" : "Example Remote",
              remotePath: "track.mp3",
              sourceOptions: [
                {
                  sourceId: 1,
                  sourceCode: "example_remote",
                  sourceName: "Example Remote",
                  path: "track.mp3",
                  sizeBytes: 12,
                },
                { sourceId: 2, sourceCode: "mirror", sourceName: "Mirror", path: "track.mp3", sizeBytes: 12 },
              ],
              mediaItemId: 1,
              localPaths: [],
              targetExists: unresolvedConflict,
              targetConflict: unresolvedConflict,
              targetConflictReason: unresolvedConflict ? "target exists with a different size" : "",
              targetSizeBytes: unresolvedConflict ? 8 : null,
            },
          ],
          summary: {
            total: 1,
            skipExisting: 0,
            cacheHit: 0,
            cacheDownload: unresolvedConflict ? 0 : 1,
            promote: unresolvedConflict ? 0 : 1,
            conflict: (unresolvedConflict ? 1 : 0) + (fetchRootConflict ? 1 : 0),
          },
          preparation: {
            requestedCode: "RJ00000051",
            canonicalCode: "RJ00000050",
            metadataStatus: "complete",
            warnings: [],
            editions: [
              {
                workId: 10,
                primaryCode: "RJ00000050",
                title: "Origin",
                metadataLanguage: "JPN",
                editionLabel: "日本語",
                translationKind: "origin",
                classificationSource: "canonical",
                makerId: "RG1",
                originMakerId: "RG1",
                origin: true,
                localRoots: [],
                sources: [
                  {
                    sourceId: 1,
                    sourceCode: "example_remote",
                    displayName: "Example Remote",
                    status: "available",
                    remoteId: "2",
                    primaryCode: "RJ00000050",
                    title: "Origin",
                    coverUrl: "",
                    workId: 10,
                    hasRemote: true,
                    hasCache: false,
                    hasLocal: false,
                    error: "",
                    elapsedMs: 1,
                  },
                ],
              },
              {
                workId: 11,
                primaryCode: "RJ00000051",
                title: "Community",
                metadataLanguage: "CHI_HANS",
                editionLabel: "簡体中文",
                translationKind: "community",
                classificationSource: "translation_umbrella",
                makerId: "RG00001",
                originMakerId: "RG1",
                origin: false,
                localRoots: [
                  {
                    id: 1,
                    fileSourceId: 2,
                    rootPath: "Existing/RJ00000051",
                    role: "external",
                    state: "active",
                    primary: false,
                  },
                ],
                sources: [
                  {
                    sourceId: 1,
                    sourceCode: "example_remote",
                    displayName: "Example Remote",
                    status: "unavailable",
                    remoteId: "1",
                    primaryCode: "RJ00000051",
                    title: "Community",
                    coverUrl: "",
                    workId: 11,
                    hasRemote: true,
                    hasCache: false,
                    hasLocal: true,
                    error: "stale availability",
                    elapsedMs: 1,
                  },
                ],
              },
            ],
          },
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not mocked" } });
  });
}

export function mediaFixture(id: number, title: string, path: string, kind: "audio" | "file" | "text") {
  return {
    id,
    parentId: null,
    kind,
    title,
    discNo: null,
    trackNo: kind === "audio" ? id : null,
    durationSeconds: kind === "audio" ? 10 : null,
    sizeBytes: 12,
    fingerprint: `fixture-${id}`,
    progress: null,
    locations: [
      {
        id,
        fileSourceId: 1,
        fileSourceCode: "local",
        fileSourceName: "Local",
        locationType: "local",
        path,
        streamUrl: kind === "audio" ? `/api/media/${id}/stream` : "",
        downloadUrl: kind === "file" ? `/api/media/${id}/download` : "",
        remoteHash: "",
        sizeBytes: 12,
        durationSeconds: kind === "audio" ? 10 : null,
        availability: "available",
        lastCheckedAt: null,
      },
    ],
  };
}
