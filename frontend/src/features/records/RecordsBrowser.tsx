import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { useStableCallback } from "@/hooks/useStableCallback";
import type { RecordAsset, RecordFolder, RecordProgress, RecordRoot } from "@/lib/api";
import { useLibraryPlayer } from "@/player/PlayerProvider";
import { RECORD_PROGRESS_SAVED_EVENT, type RecordProgressSavedDetail } from "@/player/recordTrackProgress";

import { RecordDeleteDialog, type RecordDeleteTarget } from "./RecordDeleteDialog";
import { RecordFileList, RecordFolderTile, RecordPhotoTile, RecordSection, RecordVideoTile } from "./RecordGrid";
import { RecordMediaPlayer } from "./RecordMediaPlayer";
import { RecordPhotoViewer } from "./RecordPhotoViewer";
import {
  RecordDemoNotice,
  RecordEmptyNotice,
  RecordLoading,
  RecordRetryNotice,
  RecordSetupNotice,
} from "./RecordStates";
import { RecordsToolbar } from "./RecordsToolbar";
import {
  closeOverlayNavigation,
  openContinueFolderNavigation,
  openCrumbNavigation,
  openFolderNavigation,
  openFolderVideoNavigation,
  openOverlayNavigation,
  stepOverlayNavigation,
} from "./recordsLocation";
import { recordPlayerTrack, recordTrackLocationId } from "./recordPlayerTrack";
import { resumePosition } from "./recordProgress";
import { crumbFromFolder, recordFolderView, siblingIds } from "./recordsModel";
import { useRecordRoot, useRecordTree } from "./useRecordLibrary";
import { useRecordContinue, useRecordProgress } from "./useRecordProgress";
import { useRecordScan } from "./useRecordScan";
import { useRecordsLocation } from "./useRecordsLocation";

const noMedia: readonly RecordAsset[] = [];

function isEditableElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The Record surface: a folder browser over the independent record root with
 * its own full-screen video player and photo viewer. Audio files, and a
 * video's sound on request, play in the global player with the folder's other
 * files of the same kind as the queue. An account that may delete files moves
 * a file or a folder to the record trash after a review. The folder and any open overlay live in
 * the URL, so Back, Forward, and reload keep the place.
 */
export function RecordsBrowser({ librarySettingsPath }: { librarySettingsPath: string }) {
  const auth = useAuth();
  const { t } = useTranslation();
  const phone = useMobileNavigationLayout();
  const enabled = !auth.demoMode;
  const canScan = auth.hasPermission("library:write");
  const canDelete = auth.hasPermission("downloads:manage");
  const canSaveProgress = auth.hasPermission("playback:use");
  const { location, historyState, navigate } = useRecordsLocation();
  const { state: rootState, reload: reloadRoot } = useRecordRoot(enabled);
  const root: RecordRoot | null = rootState.status === "ready" ? rootState.root : null;
  const online = root?.state === "online";
  const {
    tree,
    trail,
    pending,
    reload: reloadTree,
  } = useRecordTree(location.folderId, historyState, enabled && online);
  const scan = useRecordScan({ reloadRoot, onFinished: reloadTree });
  const [autoResumeId, setAutoResumeId] = useState<number | null>(null);
  // An audio file the Continue list asked for, played once its folder's listing arrives.
  const [pendingAudio, setPendingAudio] = useState<RecordAsset | null>(null);
  const player = useLibraryPlayer();

  const listing = tree.status === "ready" && tree.folderId === location.folderId ? tree : null;
  const view = useMemo(() => (listing ? recordFolderView(listing.folders, listing.assets) : null), [listing]);

  const playableItems = useMemo(() => (view ? [...view.videos, ...view.audio] : noMedia), [view]);
  const { progress, remember } = useRecordProgress(location.folderId, playableItems);
  const [savedToken, setSavedToken] = useState(0);
  const continueAssets = useRecordContinue(enabled && online && location.overlay === null, savedToken);

  const openFolder = useStableCallback((folder: RecordFolder) => {
    navigate((at) => openFolderNavigation(at, trail, crumbFromFolder(folder)));
    window.scrollTo({ top: 0 });
  });
  const openCrumb = useStableCallback((index: number) => {
    navigate((at) => openCrumbNavigation(at, trail, index));
    window.scrollTo({ top: 0 });
  });
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
  const rememberProgress = useStableCallback((id: number, value: RecordProgress) => {
    remember(id, value);
    setSavedToken((token) => token + 1);
  });
  // The global player saves the position of the Record file it plays.
  useEffect(() => {
    const saved = (event: Event) => {
      const detail = (event as CustomEvent<RecordProgressSavedDetail>).detail;
      if (detail) rememberProgress(detail.assetId, detail.progress);
    };
    window.addEventListener(RECORD_PROGRESS_SAVED_EVENT, saved);
    return () => window.removeEventListener(RECORD_PROGRESS_SAVED_EVENT, saved);
  }, [rememberProgress]);

  const openFolderCrumb = trail.length > 0 ? trail[trail.length - 1] : undefined;
  const folderName = openFolderCrumb?.name ?? t("nav.record");
  // Plays `items` in the global player from `id`, at `position` or where it was left.
  const playInPlayer = useStableCallback((items: readonly RecordAsset[], id: number, position?: number) => {
    if (!items.some((item) => item.id === id)) return;
    const tracks = items.map((item) => recordPlayerTrack(item, folderName, progress.get(item.id)));
    player.playQueue(tracks, recordTrackLocationId(id), position ?? resumePosition(progress.get(id)) ?? 0);
  });
  const playAudio = useStableCallback((id: number) => playInPlayer(view?.audio ?? noMedia, id));
  // A video tile plays its sound from where the video was left.
  const listenToVideoTile = useStableCallback((id: number) => playInPlayer(view?.videos ?? noMedia, id));
  const listenToVideo = (id: number, position: number) => {
    closeOverlay();
    playInPlayer(view?.videos ?? noMedia, id, position);
  };

  const openContinue = (asset: RecordAsset) => {
    if (asset.kind === "audio") {
      setPendingAudio(asset);
      if (asset.folderId !== location.folderId) navigate((at) => openContinueFolderNavigation(at, asset.folderId));
      return;
    }
    setAutoResumeId(asset.id);
    navigate((at) => openFolderVideoNavigation(at, asset.folderId, asset.id));
  };
  useEffect(() => {
    if (!pendingAudio || !view || listing?.folderId !== pendingAudio.folderId) return;
    setPendingAudio(null);
    if (view.audio.some((item) => item.id === pendingAudio.id)) playAudio(pendingAudio.id);
    else
      player.playQueue(
        [recordPlayerTrack(pendingAudio, folderName, pendingAudio.progress)],
        recordTrackLocationId(pendingAudio.id),
        resumePosition(pendingAudio.progress) ?? 0,
      );
  }, [folderName, listing?.folderId, pendingAudio, playAudio, player, view]);

  // The file or folder whose deletion is under review.
  const [deleting, setDeleting] = useState<RecordDeleteTarget | null>(null);
  const reviewDelete = useStableCallback((asset: RecordAsset) => setDeleting({ kind: "file", asset }));
  const reviewFolderDelete = useStableCallback((folder: RecordFolder) => setDeleting({ kind: "folder", folder }));
  // A deleted file open in the viewer gives way to its next sibling, or the previous one.
  const finishDelete = (target: RecordDeleteTarget) => {
    setDeleting(null);
    const open = location.overlay;
    const asset = target.kind === "file" ? target.asset : null;
    if (asset && open && open.assetId === asset.id && view) {
      const siblings = open.kind === "video" ? view.videos : view.photos;
      const { previous, next } = siblingIds(siblings, asset.id);
      const target = next ?? previous;
      if (target === null) closeOverlay();
      else navigate((at, state) => stepOverlayNavigation(at, state, target));
    }
    reloadTree();
    setSavedToken((token) => token + 1);
  };

  const startScan = () => {
    if (root) void scan.start(root);
  };
  const refresh = () => {
    void reloadRoot();
    reloadTree();
  };

  useEffect(() => {
    if (!online || trail.length === 0 || location.overlay !== null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Backspace" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isEditableElement(event.target)) return;
      if (document.querySelector("[role='dialog'], [aria-modal='true']")) return;
      event.preventDefault();
      openCrumb(trail.length - 2);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [location.overlay, online, openCrumb, trail.length]);

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
    const administrator = auth.user?.role === "admin" || auth.user?.role === "super_admin";
    return <RecordSetupNotice settingsPath={administrator ? librarySettingsPath : null} />;
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
  const isEmpty =
    view !== null && view.folders.length + view.videos.length + view.photos.length + view.files.length === 0;
  const scanBusy =
    scan.state.status === "queueing" || scan.state.status === "queued" || scan.state.status === "running";
  const sectionCount = view
    ? (view.folders.length > 0 ? 1 : 0) +
      (view.videos.length > 0 ? 1 : 0) +
      (view.photos.length > 0 ? 1 : 0) +
      (view.files.length > 0 ? 1 : 0)
    : 0;
  const showSectionHeadings = sectionCount > 1;

  const foldersGrid = view && view.folders.length > 0 && (
    <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 2xl:grid-cols-8">
      {view.folders.map((folder) => (
        <RecordFolderTile
          key={folder.id}
          folder={folder}
          onOpen={openFolder}
          onDelete={canDelete ? reviewFolderDelete : undefined}
        />
      ))}
    </div>
  );

  const videosGrid = view && view.videos.length > 0 && (
    <div className="grid grid-cols-2 gap-x-3 gap-y-4 md:grid-cols-3 xl:grid-cols-4">
      {view.videos.map((video) => (
        <RecordVideoTile
          key={video.id}
          video={video}
          progress={progress.get(video.id)}
          onOpen={openVideo}
          onListen={listenToVideoTile}
          onDelete={canDelete ? reviewDelete : undefined}
        />
      ))}
    </div>
  );

  const photosGrid = view && view.photos.length > 0 && (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {view.photos.map((photo) => (
        <RecordPhotoTile key={photo.id} photo={photo} onOpen={openPhoto} />
      ))}
    </div>
  );

  const filesList = view && view.files.length > 0 && (
    <RecordFileList
      files={view.files}
      progress={progress}
      onPlay={playAudio}
      onDelete={canDelete ? reviewDelete : undefined}
    />
  );

  return (
    <div className="space-y-4">
      <RecordsToolbar
        trail={trail}
        root={root}
        continueAssets={continueAssets}
        phone={phone}
        refreshing={pending}
        canScan={canScan}
        scan={scan.state}
        onOpenCrumb={openCrumb}
        onOpenContinue={openContinue}
        onRefresh={refresh}
        onScan={startScan}
      />

      {tree.status === "error" ? (
        <RecordRetryNotice
          title={t("records.folderErrorTitle")}
          message={t("records.folderErrorMessage")}
          onRetry={reloadTree}
        />
      ) : !view ? (
        <RecordLoading label={t("records.loadingFolder")} />
      ) : isEmpty ? (
        <RecordEmptyNotice
          neverScanned={location.folderId === 0 && !root.lastScannedAt}
          canScan={canScan}
          scanning={scanBusy}
          onScan={startScan}
        />
      ) : (
        <div className="space-y-8">
          {foldersGrid &&
            (showSectionHeadings ? (
              <RecordSection title={t("records.sections.folders")} count={view.folders.length}>
                {foldersGrid}
              </RecordSection>
            ) : (
              foldersGrid
            ))}
          {videosGrid &&
            (showSectionHeadings ? (
              <RecordSection title={t("records.sections.videos")} count={view.videos.length}>
                {videosGrid}
              </RecordSection>
            ) : (
              videosGrid
            ))}
          {photosGrid &&
            (showSectionHeadings ? (
              <RecordSection title={t("records.sections.photos")} count={view.photos.length}>
                {photosGrid}
              </RecordSection>
            ) : (
              photosGrid
            ))}
          {filesList &&
            (showSectionHeadings ? (
              <RecordSection title={t("records.sections.files")} count={view.files.length}>
                {filesList}
              </RecordSection>
            ) : (
              filesList
            ))}
        </div>
      )}

      {overlayVideo && view && (
        <RecordMediaPlayer
          key={overlayVideo.id}
          asset={overlayVideo}
          subtitle={view.subtitles.get(overlayVideo.id)}
          index={view.videos.indexOf(overlayVideo)}
          total={view.videos.length}
          {...siblingProps(view.videos, overlayVideo.id)}
          knownProgress={progress.get(overlayVideo.id)}
          autoResume={autoResumeId === overlayVideo.id}
          canSaveProgress={canSaveProgress}
          phone={phone}
          onStep={stepOverlay}
          onListen={(position) => listenToVideo(overlayVideo.id, position)}
          onDelete={canDelete ? () => reviewDelete(overlayVideo) : undefined}
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
          onDelete={canDelete ? () => reviewDelete(overlayPhoto) : undefined}
          onClose={closeOverlay}
        />
      )}
      {deleting && <RecordDeleteDialog target={deleting} onCancel={() => setDeleting(null)} onDeleted={finishDelete} />}
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
