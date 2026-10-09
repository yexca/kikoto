import { type Page } from "@playwright/test";
import type { PlaybackReport } from "../../../src/lib/playbackReportApi";
import { playbackReportResultFixture } from "./playback-reports";
import type {
  FavoriteList,
  LibrarySource,
  LocalMediaRefreshResult,
  MediaCleanupResult,
  MediaItem,
  MediaProgress,
  MediaTextPreview,
  RecentlyPlayedWorksResponse,
  RemoteFetchFileDecision,
  RemoteTrackRunStatus,
  RemoteWorkDetail,
  RemoteWorkSavePlan,
  RemoteWorkTrackResult,
  SourceAvailabilityResponse,
  VoiceMergeReview,
  Work,
  WorkflowEvent,
  WorkFolderLocation,
  WorkMetadataPresentation,
  WorkMetadataSyncRunResult,
  WorkMetadataSyncStatus,
  WorkPurchaseBonus,
  WorkSourceUntrackResult,
  WorkTranslation,
} from "../../../src/lib/api";
import { syntheticWorkCode } from "../../../src/test-support/workCode";
import {
  anonymousAuthState,
  authenticatedStateFixture,
  favoriteListFixture,
  fixtureTimestamp,
  librarySourceFixture,
  mediaItemFixture,
  mediaLocationFixture,
  remoteTrackFixture,
  remoteWorkDetailFixture,
  remoteWorkFixture,
  remoteWorksResponseFixture,
  remoteWorkTracksFixture,
  runtimeSettingsFixture,
  sourceAvailabilitySourceFixture,
  voiceCatalogRefreshFixture,
  voiceDetailFixture,
  voiceSummaryFixture,
  workDetailFixture,
  workflowRunDetailFixture,
  workflowRunFixture,
  workFixture,
  workResolveFixture,
  worksPageFixture,
  type ApiErrorBody,
  type ApiResponse,
} from "./api";

export const work: Work = workFixture({
  id: 1,
  primaryCode: syntheticWorkCode("RJ", 0),
  title: "Tagged mobile work",
  ageRating: "R18",
  releaseDate: "2026-01-01",
  circle: "Test circle",
  circleExternalId: "RG00000001",
  rating: 4.5,
  ratingCount: 240,
  sales: 10,
  tags: ["ロリ"],
  trackCount: 1,
  availableLocations: 1,
  availability: ["local"],
});

/** A persisted player queue entry. Local storage state, not an API response. */
export type PersistedPlayerTrack = {
  queueItemId: string;
  mediaItemId: number;
  locationId: number;
  title: string;
  folderPath: string;
  locationType: string;
  streamUrl: string;
  sizeBytes: number | null;
  availability: string;
  workId: number;
  workCode: string;
  workTitle: string;
  coverUrl: string;
  circle: string;
  progress: MediaProgress | null;
  progressRecordable: boolean;
  lyricsLocationId: number | null;
  lyricsTitle: string;
  autoLyricsLocationId?: number | null;
  lyricsChoices?: {
    mediaItemId: number;
    locationId: number;
    title: string;
    path: string;
    reason: "same_stem" | "shared_folder";
  }[];
  locations: {
    locationId: number;
    locationType: string;
    streamUrl: string;
    sourceId: number;
    sourceName: string;
    availability: string;
  }[];
};

export const persistedTrack: PersistedPlayerTrack = {
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

export const persistedPlayerTracks = new WeakMap<Page, PersistedPlayerTrack[]>();

export const playerQueueStorageBaseKey = "kikoto:player-queue:v2";

export const playerProgressStorageBaseKey = "kikoto:player-progress:v2";

export type MockWork = Work;

type MockApplicationFixture = {
  work?: Work;
  recentWorks?: Work[];
  librarySources?: LibrarySource[];
  sourceAvailability?: SourceAvailabilityResponse;
  remoteDetail?: RemoteWorkDetail;
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
  detailLocalFolders?: WorkFolderLocation[];
  detailPurchaseBonus?: WorkPurchaseBonus;
  /** Summary the finished media cleanup run reports, such as a forgotten work. */
  cleanupRunSummary?: Record<string, unknown>;
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

const notMocked = { error: "Not mocked" } satisfies ApiErrorBody;

function untrackResult(workId: number, sourceId: number): WorkSourceUntrackResult {
  return {
    workId,
    sourceId,
    status: "succeeded",
    clearedCaches: 0,
    deletedFiles: 0,
    cachePaths: [],
    trackedCleared: true,
    workPreserved: true,
    localPreserved: true,
  };
}

export async function mockApplication(
  page: Page,
  onWorksRequest?: (url: URL) => void,
  failLocalAudio = false,
  workCount = 1,
  mediaDelayMs = 0,
  mediaItems: MediaItem[] = [],
  onCleanup?: (body: Record<string, unknown>) => void,
  fixture: MockApplicationFixture = {},
) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/listening-sessions" && route.request().method() === "GET") {
      await route.fulfill({ json: { generation: 0 } });
      return;
    }
    if (url.pathname === "/api/playback-reports") {
      await route.fulfill({ json: playbackReportResultFixture(route.request().postDataJSON() as PlaybackReport) });
      return;
    }
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        json: fixture.authenticated
          ? authenticatedStateFixture({
              permissions: fixture.permissions ?? ["library:read", "playback:use", "favorites:write"],
              devMode: true,
            })
          : anonymousAuthState,
      });
      return;
    }
    if (url.pathname === "/api/works/1/metadata-tags" && route.request().method() === "GET") {
      await route.fulfill({
        json: { tags: [], inheritedTags: [], overrides: [] } satisfies ApiResponse<"getWorkMetadataTags">,
      });
      return;
    }
    if (url.pathname === "/api/works/1/user-state" && route.request().method() === "PATCH") {
      await route.fulfill(
        fixture.authenticated
          ? {
              json: {
                workId: 1,
                listeningStatus: "want_to_listen",
                favorite: false,
              } satisfies ApiResponse<"updateWorkUserState">,
            }
          : { status: 401, json: { error: "login required" } satisfies ApiErrorBody },
      );
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({ json: fixture.librarySources ?? ([] satisfies LibrarySource[]) });
      return;
    }
    if (url.pathname === "/api/favorite-lists") {
      await route.fulfill({ json: [favoriteListFixture()] satisfies FavoriteList[] });
      return;
    }
    if (url.pathname === "/api/works/1/favorite-lists") {
      await route.fulfill({ json: [favoriteListFixture({ selected: false })] satisfies FavoriteList[] });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: runtimeSettingsFixture() });
      return;
    }
    if (url.pathname === "/api/recently-played-works") {
      await route.fulfill({ json: { works: fixture.recentWorks ?? [] } satisfies RecentlyPlayedWorksResponse });
      return;
    }
    if (url.pathname === "/api/voices/7") {
      await route.fulfill({
        json: voiceDetailFixture(
          voiceSummaryFixture({
            personId: 7,
            displayName: "Example Voice",
            aliases: ["Example Voice"],
            knownWorks: 1,
            localWorks: 1,
            playableWorks: 1,
            lastSeenAt: fixtureTimestamp,
            lastSyncedAt: fixtureTimestamp,
            syncState: "synced",
            sourceSummaries: [{ key: "local", sourceId: null, displayName: "Local", status: "available", count: 1 }],
          }),
        ),
      });
      return;
    }
    if (url.pathname === "/api/voices/7/works") {
      await route.fulfill({ json: { personId: 7, works: [] } satisfies ApiResponse<"getVoiceWorks"> });
      return;
    }
    if (url.pathname === "/api/voices/7/remote-matches") {
      await route.fulfill({
        json: {
          personId: 7,
          remoteMatches: [],
          refresh: voiceCatalogRefreshFixture({ queries: ["Example Voice"] }),
        } satisfies ApiResponse<"getVoiceRemoteMatches">,
      });
      return;
    }
    if (url.pathname === "/api/voices/7/merges") {
      await route.fulfill({ json: [] satisfies VoiceMergeReview[] });
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
      await route.fulfill({ json: worksPageFixture(works) });
      return;
    }
    if (url.pathname === `/api/works/${fixture.work?.primaryCode ?? work.primaryCode}/resolve`) {
      await route.fulfill({
        json: workResolveFixture(fixture.work ?? work, { priceCurrency: "JPY", permanentlyFree: false }),
      });
      return;
    }
    if (url.pathname === `/api/works/${fixture.work?.primaryCode ?? work.primaryCode}/source-availability`) {
      if (route.request().method() === "POST") fixture.onSourceCheck?.();
      await route.fulfill({
        json:
          fixture.sourceAvailability ??
          ({
            workCode: fixture.work?.primaryCode ?? work.primaryCode,
            checkedAt: "",
            sources: [],
          } satisfies SourceAvailabilityResponse),
      });
      return;
    }
    if (
      fixture.remoteDetail &&
      url.pathname === `/api/remote-sources/7/works/${fixture.work?.primaryCode ?? work.primaryCode}/tracks`
    ) {
      await route.fulfill({ json: remoteWorkTracksFixture(fixture.remoteDetail) });
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
        await route.fulfill({ status: 404, json: notMocked });
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
        } satisfies WorkMetadataSyncRunResult,
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
      const running = fixture.metadataSyncControl.status === "running";
      await route.fulfill({
        json: workflowRunDetailFixture(
          workflowRunFixture({
            id: fixture.metadataSyncControl.runId,
            workflowCode: "metadata_family_sync",
            displayName: "Refresh metadata",
            status: fixture.metadataSyncControl.status,
            triggerReason: "work_detail",
            finishedAt: running ? "" : "2026-01-01T00:01:00Z",
            nodeRunCount: 1,
            completedNodeRuns: running ? 0 : 1,
            jobCount: 1,
            completedJobs: running ? 0 : 1,
          }),
        ),
      });
      return;
    }
    const metadataEventsMatch = url.pathname.match(/^\/api\/workflow-runs\/(\d+)\/events$/);
    if (
      metadataEventsMatch &&
      fixture.metadataSyncControl &&
      Number(metadataEventsMatch[1]) === fixture.metadataSyncControl.runId
    ) {
      await route.fulfill({ json: [] satisfies WorkflowEvent[] });
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
    const readWorkID = (value: string) => {
      if (/^\d+$/.test(value)) return Number(value);
      if (value === (fixture.work ?? work).primaryCode) return 1;
      const ordinal = Number(value.slice(2));
      return value.startsWith("RJ") && ordinal < workCount ? ordinal + 1 : null;
    };
    const detailMatch = url.pathname.match(/^\/api\/works\/(\d+|[RBV]J\d{8}|CC\d{8})$/);
    if (detailMatch) {
      const id = readWorkID(detailMatch[1]);
      if (id === null) {
        await route.fulfill({ status: 404, json: { error: "work not found" } satisfies ApiErrorBody });
        return;
      }
      await fixture.beforeWorkDetailResponse?.(id);
      if (id === 1 && fixture.metadataSyncControl) fixture.metadataSyncControl.detailRequests += 1;
      const fixtureWork = fixture.work ?? work;
      const detailWork: Work =
        id === 1
          ? fixtureWork
          : {
              ...fixtureWork,
              id,
              primaryCode: syntheticWorkCode("RJ", id - 1),
              title: `Mobile work ${id}`,
            };
      await route.fulfill({
        json: workDetailFixture(detailWork, {
          metadataLanguage:
            fixture.metadataSyncControl?.detailReady || fixture.detailMetadataSync?.status !== "not_synced"
              ? "JPN"
              : "",
          ageRating: "",
          translations: fixture.detailTranslations ?? [],
          localFolders: fixture.detailLocalFolders ?? [],
          ...(fixture.detailMetadataPresentation ? { metadataPresentation: fixture.detailMetadataPresentation } : {}),
          ...(fixture.detailPurchaseBonus ? { purchaseBonus: fixture.detailPurchaseBonus } : {}),
          metadataSync: fixture.metadataSyncControl?.detailReady
            ? { status: "available", checkedAt: "2026-01-01T00:01:00Z" }
            : (fixture.detailMetadataSync ?? { status: "available", checkedAt: "" }),
          mediaItems: url.searchParams.get("includeMedia") === "false" ? [] : mediaItems,
        }),
      });
      return;
    }
    const mediaMatch = url.pathname.match(/^\/api\/works\/(\d+|[RBV]J\d{8}|CC\d{8})\/media$/);
    if (mediaMatch) {
      const workId = readWorkID(mediaMatch[1]);
      if (workId === null) {
        await route.fulfill({ status: 404, json: { error: "work not found" } satisfies ApiErrorBody });
        return;
      }
      fixture.onMediaRequest?.();
      if (mediaDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, mediaDelayMs));
      if (fixture.mediaBusy) {
        await route.fulfill({
          status: 503,
          json: {
            error: "database is busy; please retry",
            code: "database_busy",
            retryable: true,
          } satisfies ApiErrorBody,
        });
        return;
      }
      const restoredTracks =
        mediaItems.length > 0 ? [] : (persistedPlayerTracks.get(page) ?? []).filter((track) => track.workId === workId);
      const restoredMediaItems = restoredTracks.map((track) =>
        mediaItemFixture({
          id: track.mediaItemId,
          title: track.title,
          trackNo: 1,
          sizeBytes: track.sizeBytes,
          progress: track.progress,
          locations: track.locations.map((location) =>
            mediaLocationFixture({
              id: location.locationId,
              fileSourceId: location.sourceId,
              fileSourceCode: "test",
              fileSourceName: location.sourceName,
              locationType: location.locationType,
              path: `${track.workCode}/${track.title}`,
              streamUrl: location.streamUrl,
              sizeBytes: track.sizeBytes,
              availability: location.availability,
            }),
          ),
        }),
      );
      await route.fulfill({
        json: {
          workId,
          mediaWorkId: workId,
          mediaItems: mediaItems.length > 0 ? mediaItems : restoredMediaItems,
        } satisfies ApiResponse<"getWorkMedia">,
      });
      return;
    }
    if (url.pathname === "/api/media/cleanup" && route.request().method() === "POST") {
      onCleanup?.(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 202,
        json: { runId: 41, jobId: 42, status: "queued", queued: 2 } satisfies MediaCleanupResult,
      });
      return;
    }
    const untrackMatch = url.pathname.match(/^\/api\/works\/(\d+)\/tracked-sources\/(\d+)$/);
    if (untrackMatch && route.request().method() === "DELETE") {
      const workId = Number(untrackMatch[1]);
      const sourceId = Number(untrackMatch[2]);
      fixture.onUntrack?.(workId, sourceId);
      await route.fulfill({ json: untrackResult(workId, sourceId) });
      return;
    }
    if (url.pathname === "/api/works/1/local-files/refresh" && route.request().method() === "POST") {
      fixture.onLocalRefresh?.();
      await route.fulfill({
        json: {
          workId: 1,
          fileSourceId: 1,
          status: "succeeded",
          indexedFiles: mediaItems.length,
        } satisfies LocalMediaRefreshResult,
      });
      return;
    }
    if (url.pathname === "/api/workflow-runs/41") {
      await route.fulfill({
        json: workflowRunDetailFixture(
          workflowRunFixture({
            id: 41,
            workflowCode: "media_cleanup",
            displayName: "Media cleanup",
            summaryJson: JSON.stringify(fixture.cleanupRunSummary ?? {}),
          }),
        ),
      });
      return;
    }
    if (url.pathname === "/api/workflow-runs/41/events") {
      await route.fulfill({ json: [] satisfies WorkflowEvent[] });
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
      if (route.request().method() === "PUT") {
        const lyricsMediaItemId = Number(
          (route.request().postDataJSON() as { lyricsMediaItemId?: number }).lyricsMediaItemId ?? 0,
        );
        fixture.onLyricsPreference?.("PUT", audioMediaItemId, lyricsMediaItemId);
        await route.fulfill({
          json: { audioMediaItemId, lyricsMediaItemId } satisfies ApiResponse<"setMediaLyricsPreference">,
        });
        return;
      }
      fixture.onLyricsPreference?.("DELETE", audioMediaItemId, null);
      await route.fulfill({
        json: { audioMediaItemId, lyricsMediaItemId: null } satisfies ApiResponse<"clearMediaLyricsPreference">,
      });
      return;
    }
    const textPreviewMatch = url.pathname.match(/^\/api\/media\/(\d+)\/text$/);
    if (textPreviewMatch) {
      const locationID = Number(textPreviewMatch[1]);
      await route.fulfill({
        json:
          locationID === 9
            ? ({
                path: "lyrics.lrc",
                content:
                  "[00:00.00]First line\n[00:05.00]Second line\n[00:10.00]Third line\n[00:15.00]Fourth line\n[00:20.00]Fifth line\n[00:25.00]Sixth line\n[00:30.00]Seventh line\n[00:35.00]Eighth line",
              } satisfies MediaTextPreview)
            : ({ path: "notes.txt", content: "Synthetic notes" } satisfies MediaTextPreview),
      });
      return;
    }
    await route.fulfill({ status: 404, json: notMocked });
  });
}

export async function seedPlayer(page: Page, track = persistedTrack, principalID: number | null = null) {
  await seedPlayerQueue(page, [track], principalID);
}

export async function seedPlayerQueue(page: Page, tracks: PersistedPlayerTrack[], principalID: number | null = null) {
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

export async function seedPlaybackSourcePreferences(
  page: Page,
  preferences: { sourceSwitching: boolean; sourceFallback: boolean },
  principalID: number | null = null,
) {
  await page.addInitScript(
    ({ preferences, principalID }) => {
      const principal = principalID === null ? "anonymous" : `user-${principalID}`;
      const key = `kikoto:player-source-preferences:v1:${encodeURIComponent(window.location.origin)}:${principal}`;
      localStorage.setItem(key, JSON.stringify(preferences));
    },
    { preferences, principalID },
  );
}

export function queuedTrackFixture(index: number, title: string): PersistedPlayerTrack {
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

const exampleRemoteSource = {
  sourceId: 1,
  sourceCode: "example_remote",
  sourceName: "Example Remote",
} as const;

function exampleRemoteTrack(title: string, hash: string, suffix = "") {
  return remoteTrackFixture({
    title,
    hash,
    streamUrl: `/stream${suffix}`,
    downloadUrl: `/download${suffix}`,
    durationSeconds: 10,
    sizeBytes: 12,
  });
}

function exampleRemoteDetail(overrides: Partial<RemoteWorkDetail>): RemoteWorkDetail {
  return remoteWorkDetailFixture({
    ...exampleRemoteSource,
    circle: "Remote circle",
    rating: 4.5,
    ratingCount: 240,
    sales: 100,
    releaseDate: "2026-04-03",
    ...overrides,
  });
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
            ? anonymousAuthState
            : authenticatedStateFixture({
                permissions: options.permissions ?? ["library:read", "playback:use", "downloads:manage"],
                devMode: true,
              }),
      });
      return;
    }
    if (url.pathname === "/api/library-sources") {
      await route.fulfill({
        json: [
          librarySourceFixture({
            id: 1,
            code: "example_remote",
            displayName: "Example Remote",
            enabled: options.remoteStatus !== "disabled",
          }),
        ] satisfies LibrarySource[],
      });
      return;
    }
    if (url.pathname === "/api/runtime-settings") {
      await route.fulfill({ json: runtimeSettingsFixture() });
      return;
    }
    if (url.pathname === "/api/works") {
      await route.fulfill({ json: worksPageFixture([work]) });
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
            sourceAvailabilitySourceFixture({
              sourceId: 1,
              sourceCode: "example_remote",
              displayName: "Example Remote",
              status: "available",
              remoteId: "1",
              primaryCode: remoteOnlyWork ? "RJ00000051" : work.primaryCode,
              title: remoteOnlyWork ? "Remote Japanese work" : work.title,
              workId: remoteOnlyWork ? (workMaterialized ? 91 : null) : 1,
              hasRemote: remoteOnlyWork ? workMaterialized : true,
              hasTracked: remoteOnlyWork ? trackCompleted : false,
              hasCache: false,
              hasLocal: !remoteOnlyWork,
            }),
          ],
        } satisfies SourceAvailabilityResponse,
      });
      return;
    }
    if (url.pathname === "/api/works/91") {
      const remoteWork: Work = {
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
      };
      await route.fulfill({
        json: workDetailFixture(remoteWork, {
          durationSeconds: 10,
          mediaItems: [
            mediaItemFixture({
              id: 91,
              title: "track.mp3",
              trackNo: 1,
              durationSeconds: 10,
              sizeBytes: 12,
              locations: [
                mediaLocationFixture({
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
                }),
              ],
            }),
          ],
        }),
      });
      return;
    }
    if (url.pathname === "/api/works/1" || url.pathname === "/api/works/RJ00000000") {
      await route.fulfill({ json: workDetailFixture(work) });
      return;
    }
    if (url.pathname === "/api/works/1/media" || url.pathname === "/api/works/RJ00000000/media") {
      await route.fulfill({
        json: { workId: 1, mediaWorkId: 1, mediaItems: [] } satisfies ApiResponse<"getWorkMedia">,
      });
      return;
    }
    if (url.pathname === "/api/favorite-lists") {
      await route.fulfill({ json: [] satisfies FavoriteList[] });
      return;
    }
    if (url.pathname === "/api/recently-played-works") {
      await route.fulfill({ json: { works: [] } satisfies RecentlyPlayedWorksResponse });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works") {
      onRemoteRequest(url);
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      const sort = (url.searchParams.get("sort") ?? "recent") as ApiResponse<"listRemoteSourceWorks">["sort"];
      const direction = url.searchParams.get("direction") === "asc" ? "asc" : "desc";
      if (options.remoteStatus && options.remoteStatus !== "ok") {
        await route.fulfill({
          json: remoteWorksResponseFixture([], {
            page: pageNumber,
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
            direction,
            sortApplied: false,
          }),
        });
        return;
      }
      await route.fulfill({
        json: remoteWorksResponseFixture(
          [
            remoteWorkFixture({
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
              circle: "Remote circle",
              ageRating: "R15",
              rating: 4.5,
              ratingCount: 240,
              sales: 100,
              tags: ["退廃/背徳/インモラル"],
              importStatus: trackCompleted ? "tracked" : workMaterialized ? "synced" : "remote_only",
              remotePlayable: true,
              workId: pageNumber === 1 && workMaterialized ? 91 : options.persisted && pageNumber === 1 ? 1 : null,
            }),
          ],
          { page: pageNumber, total: 30, sort, direction },
        ),
      });
      return;
    }
    const japaneseDetail = () =>
      exampleRemoteDetail({
        remoteId: "1",
        primaryCode: "RJ00000051",
        remoteCode: "RJ00000051",
        title: "Remote Japanese work",
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
        tracks: [exampleRemoteTrack("track.mp3", "hash")],
      });
    const englishDetail = () =>
      exampleRemoteDetail({
        remoteId: "3",
        primaryCode: "RJ00000053",
        remoteCode: "RJ00000053",
        title: "Remote English work",
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
        tracks: [exampleRemoteTrack("english.mp3", "english", "-en")],
      });
    if (url.pathname === "/api/remote-sources/1/works/RJ00000051/tracks" && route.request().method() === "GET") {
      await route.fulfill({ json: remoteWorkTracksFixture(japaneseDetail()) });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works/RJ00000051" && route.request().method() === "GET") {
      await route.fulfill({ json: japaneseDetail() });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works/RJ00000053/tracks" && route.request().method() === "GET") {
      await route.fulfill({ json: remoteWorkTracksFixture(englishDetail()) });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works/RJ00000053" && route.request().method() === "GET") {
      await route.fulfill({ json: englishDetail() });
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
        } satisfies RemoteWorkTrackResult,
      });
      return;
    }
    if (url.pathname === "/api/remote-track-runs/91") {
      if (!options.trackControl) {
        await route.fulfill({ status: 404, json: { error: "Track run not found" } satisfies ApiErrorBody });
        return;
      }
      options.trackControl.statusRequests += 1;
      const summaryJson =
        options.trackControl.status === "succeeded"
          ? JSON.stringify({ work_id: 91, primary_code: "RJ00000051", source_id: 1, forked: true })
          : "{}";
      await route.fulfill({
        json: { runId: 91, status: options.trackControl.status, summaryJson } satisfies RemoteTrackRunStatus,
      });
      return;
    }
    if (url.pathname === "/api/works/91/tracked-sources/1" && route.request().method() === "DELETE") {
      if (options.trackControl) {
        options.trackControl.untracked = true;
        options.trackControl.untrackRequests.push(url.pathname);
      }
      await route.fulfill({ json: untrackResult(91, 1) });
      return;
    }
    if (url.pathname === "/api/remote-sources/1/works/RJ00000051/fetch-plan") {
      const requestBody = route.request().postDataJSON() as { decisions?: Partial<RemoteFetchFileDecision>[] };
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
                  sourceAvailabilitySourceFixture({
                    sourceId: 1,
                    sourceCode: "example_remote",
                    displayName: "Example Remote",
                    status: "available",
                    remoteId: "2",
                    primaryCode: "RJ00000050",
                    title: "Origin",
                    workId: 10,
                    hasRemote: true,
                  }),
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
                  sourceAvailabilitySourceFixture({
                    sourceId: 1,
                    sourceCode: "example_remote",
                    displayName: "Example Remote",
                    status: "unavailable",
                    remoteId: "1",
                    primaryCode: "RJ00000051",
                    title: "Community",
                    workId: 11,
                    hasRemote: true,
                    hasLocal: true,
                    error: "stale availability",
                  }),
                ],
              },
            ],
          },
        } satisfies RemoteWorkSavePlan,
      });
      return;
    }
    await route.fulfill({ status: 404, json: notMocked });
  });
}

export function mediaFixture(id: number, title: string, path: string, kind: "audio" | "file" | "text"): MediaItem {
  return mediaItemFixture({
    id,
    kind,
    title,
    trackNo: kind === "audio" ? id : null,
    durationSeconds: kind === "audio" ? 10 : null,
    sizeBytes: 12,
    locations: [
      mediaLocationFixture({
        id,
        path,
        streamUrl: kind === "audio" ? `/api/media/${id}/stream` : "",
        downloadUrl: kind === "file" ? `/api/media/${id}/download` : "",
        sizeBytes: 12,
        durationSeconds: kind === "audio" ? 10 : null,
      }),
    ],
  });
}
