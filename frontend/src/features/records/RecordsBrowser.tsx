import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api, type RecordFolder, type RecordProgress, type RecordRoot } from "@/lib/api";

import { RecordFolderHeader, type RecordPrimaryAction } from "./RecordFolderHeader";
import { RecordFolderTile, RecordPhotoTile, RecordSection, RecordVideoTile } from "./RecordGrid";
import { RecordPhotoViewer } from "./RecordPhotoViewer";
import {
  RecordDemoNotice,
  RecordEmptyNotice,
  RecordLoading,
  RecordRetryNotice,
  RecordSetupNotice,
} from "./RecordStates";
import { RecordBreadcrumb, RecordsToolbar } from "./RecordsToolbar";
import { RecordVideoPlayer } from "./RecordVideoPlayer";
import { continueCandidate } from "./recordProgress";
import {
  closeOverlayNavigation,
  openCrumbNavigation,
  openFolderNavigation,
  openOverlayNavigation,
  stepOverlayNavigation,
  updateViewNavigation,
  type RecordKindFilter,
  type RecordSortOrder,
} from "./recordsLocation";
import { crumbFromFolder, filteredRecordView, recordFolderView, siblingIds } from "./recordsModel";
import { useRecordRoot, useRecordTree } from "./useRecordLibrary";
import { useRecordProgress } from "./useRecordProgress";
import { useRecordScan } from "./useRecordScan";
import { useRecordsLocation } from "./useRecordsLocation";

/** How many of a folder's first videos the header reads progress for to offer Continue. */
const continueProgressReads = 8;

/**
 * The Record surface: a folder browser over the independent record root with
 * its own full-screen video player and photo viewer. The folder and any open
 * overlay live in the URL, so Back, Forward, and reload keep the place.
 */
export function RecordsBrowser() {
  const auth = useAuth();
  const { t } = useTranslation();
  const enabled = !auth.demoMode;
  const canScan = auth.hasPermission("library:write");
  const { location, historyState, navigate } = useRecordsLocation();
  const { state: rootState, reload: reloadRoot, setRoot } = useRecordRoot(enabled);
  const root: RecordRoot | null = rootState.status === "ready" ? rootState.root : null;
  const online = root?.state === "online";
  const {
    tree,
    trail,
    pending,
    reload: reloadTree,
  } = useRecordTree(location.folderId, historyState, enabled && online);
  const { progress, observe, request, remember } = useRecordProgress(location.folderId, enabled && online);
  const scan = useRecordScan({ reloadRoot, onFinished: reloadTree });
  const [initializing, setInitializing] = useState<"idle" | "busy" | "failed">("idle");
  const [autoResumeId, setAutoResumeId] = useState<number | null>(null);

  const listing = tree.status === "ready" && tree.folderId === location.folderId ? tree : null;
  const view = useMemo(
    () => (listing ? recordFolderView(listing.folders, listing.assets, location.sort) : null),
    [listing, location.sort],
  );
  const shown = view ? filteredRecordView(view, location.filter) : null;
  const current = trail.length > 0 ? trail[trail.length - 1] : null;

  // The header offers Continue from the most recent unfinished video among the first few.
  const firstVideoIds = useMemo(
    () => (view ? view.videos.slice(0, continueProgressReads).map((v) => v.id) : []),
    [view],
  );
  useEffect(() => {
    for (const id of firstVideoIds) request(id);
  }, [firstVideoIds, request]);
  const candidate = continueCandidate(firstVideoIds, progress);
  const primaryAction: RecordPrimaryAction | null = candidate
    ? { kind: "continue", videoId: candidate.id, position: candidate.position }
    : view && view.videos.length > 0
      ? { kind: "play", videoId: view.videos[0].id }
      : null;

  const openFolder = useStableCallback((folder: RecordFolder) => {
    navigate((at) => openFolderNavigation(at, trail, crumbFromFolder(folder)));
    window.scrollTo({ top: 0 });
  });
  const openCrumb = (index: number) => {
    navigate((at) => openCrumbNavigation(at, trail, index));
    window.scrollTo({ top: 0 });
  };
  const openVideo = useStableCallback((id: number) => {
    setAutoResumeId(null);
    navigate((at, state) => openOverlayNavigation(at, state, { kind: "video", assetId: id }));
  });
  const openPhoto = useStableCallback((id: number) =>
    navigate((at, state) => openOverlayNavigation(at, state, { kind: "photo", assetId: id })),
  );
  const stepOverlay = (id: number) => {
    setAutoResumeId(null);
    navigate((at, state) => stepOverlayNavigation(at, state, id));
  };
  const closeOverlay = () => navigate((at, state) => closeOverlayNavigation(at, state));
  const setFilter = (filter: RecordKindFilter) => navigate((at, state) => updateViewNavigation(at, state, { filter }));
  const setSort = (sort: RecordSortOrder) => navigate((at, state) => updateViewNavigation(at, state, { sort }));
  const rememberProgress = useStableCallback((id: number, value: RecordProgress) => remember(id, value));

  const startScan = () => {
    if (root) void scan.start(root);
  };
  const refresh = () => {
    void reloadRoot();
    reloadTree();
  };
  const initialize = async () => {
    setInitializing("busy");
    try {
      const result = await api.initializeRecordRoot();
      setRoot(result.root);
      setInitializing("idle");
    } catch {
      setInitializing("failed");
    }
  };

  if (!enabled) return <RecordDemoNotice />;
  if (rootState.status === "loading") return <RecordLoading label={t("records.loading")} />;
  if (rootState.status === "error" || !root) {
    return (
      <RecordRetryNotice
        title={t("records.rootErrorTitle")}
        message={t("records.rootErrorMessage")}
        onRetry={() => void reloadRoot()}
      />
    );
  }
  if (root.state === "unconfigured") {
    return (
      <RecordSetupNotice
        canInitialize={auth.hasPermission("sources:write")}
        busy={initializing === "busy"}
        failed={initializing === "failed"}
        onInitialize={() => void initialize()}
      />
    );
  }
  if (root.state !== "online") {
    const offline = root.state === "offline";
    return (
      <RecordRetryNotice
        title={offline ? t("records.offlineTitle") : t("records.unreadableTitle")}
        message={offline ? t("records.offlineMessage") : t("records.unreadableMessage")}
        onRetry={() => void reloadRoot()}
      />
    );
  }

  const overlay = location.overlay;
  const overlayVideo =
    overlay?.kind === "video" && view ? (view.videos.find((video) => video.id === overlay.assetId) ?? null) : null;
  const overlayPhoto =
    overlay?.kind === "photo" && view ? (view.photos.find((photo) => photo.id === overlay.assetId) ?? null) : null;
  const isEmpty = view !== null && view.folders.length + view.videos.length + view.photos.length === 0;

  return (
    <div className="space-y-5">
      <RecordBreadcrumb trail={trail} onOpenCrumb={openCrumb} />
      {view && (
        <RecordFolderHeader
          name={current ? current.name || t("records.unknownFolder") : t("nav.record")}
          posterUrl={current?.posterUrl}
          backdropUrl={current?.backdropUrl}
          videoCount={view.videos.length}
          photoCount={view.photos.length}
          action={primaryAction}
          onPlay={(action) => {
            navigate((at, state) => openOverlayNavigation(at, state, { kind: "video", assetId: action.videoId }));
            setAutoResumeId(action.kind === "continue" ? action.videoId : null);
          }}
        />
      )}
      <RecordsToolbar
        root={root}
        filter={location.filter}
        sort={location.sort}
        refreshing={pending}
        canScan={canScan}
        scan={scan.state}
        onFilter={setFilter}
        onSort={setSort}
        onRefresh={refresh}
        onScan={startScan}
      />

      {tree.status === "error" ? (
        <RecordRetryNotice
          title={t("records.folderErrorTitle")}
          message={t("records.folderErrorMessage")}
          onRetry={reloadTree}
        />
      ) : !shown || !view ? (
        <RecordLoading label={t("records.loadingFolder")} />
      ) : isEmpty ? (
        <RecordEmptyNotice
          neverScanned={location.folderId === 0 && !root.lastScannedAt}
          canScan={canScan}
          onScan={startScan}
        />
      ) : (
        <div className="space-y-8">
          {shown.folders.length > 0 && (
            <RecordSection title={t("records.sections.folders")} count={shown.folders.length}>
              <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6">
                {shown.folders.map((folder) => (
                  <RecordFolderTile key={folder.id} folder={folder} onOpen={openFolder} />
                ))}
              </div>
            </RecordSection>
          )}
          {location.filter !== "photos" &&
            (shown.videos.length > 0 ? (
              <RecordSection title={t("records.sections.videos")} count={shown.videos.length}>
                <div className="grid grid-cols-2 gap-x-3 gap-y-4 md:grid-cols-3 xl:grid-cols-4">
                  {shown.videos.map((video) => (
                    <RecordVideoTile
                      key={video.id}
                      video={video}
                      progress={progress.get(video.id)}
                      onOpen={openVideo}
                      observe={observe}
                    />
                  ))}
                </div>
              </RecordSection>
            ) : (
              location.filter === "videos" && <p className="text-sm text-muted-foreground">{t("records.noVideos")}</p>
            ))}
          {location.filter !== "videos" &&
            (shown.photos.length > 0 ? (
              <RecordSection title={t("records.sections.photos")} count={shown.photos.length}>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                  {shown.photos.map((photo) => (
                    <RecordPhotoTile key={photo.id} photo={photo} onOpen={openPhoto} />
                  ))}
                </div>
              </RecordSection>
            ) : (
              location.filter === "photos" && <p className="text-sm text-muted-foreground">{t("records.noPhotos")}</p>
            ))}
        </div>
      )}

      {overlayVideo && view && (
        <RecordVideoPlayer
          key={overlayVideo.id}
          video={overlayVideo}
          subtitle={view.subtitles.get(overlayVideo.id)}
          index={view.videos.indexOf(overlayVideo)}
          total={view.videos.length}
          {...siblingProps(view.videos, overlayVideo.id)}
          knownProgress={progress.get(overlayVideo.id)}
          autoResume={autoResumeId === overlayVideo.id}
          canSaveProgress={canScan}
          onStep={stepOverlay}
          onClose={closeOverlay}
          onProgressSaved={rememberProgress}
        />
      )}
      {overlayPhoto && view && (
        <RecordPhotoViewer
          photo={overlayPhoto}
          index={view.photos.indexOf(overlayPhoto)}
          total={view.photos.length}
          previous={neighbour(view.photos, overlayPhoto.id, "previous")}
          next={neighbour(view.photos, overlayPhoto.id, "next")}
          onStep={(id) => navigate((at, state) => stepOverlayNavigation(at, state, id))}
          onClose={closeOverlay}
        />
      )}
    </div>
  );
}

function siblingProps(items: readonly { id: number }[], id: number) {
  const { previous, next } = siblingIds(items, id);
  return { previousId: previous, nextId: next };
}

function neighbour<T extends { id: number }>(items: readonly T[], id: number, side: "previous" | "next") {
  const target = siblingIds(items, id)[side];
  return target === null ? null : (items.find((item) => item.id === target) ?? null);
}
