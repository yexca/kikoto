import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { useStableCallback } from "@/hooks/useStableCallback";
import type { RecordAsset, RecordFolder, RecordProgress, RecordRoot } from "@/lib/api";
import { useLibraryPlayer } from "@/player/PlayerProvider";
import { RECORD_PROGRESS_SAVED_EVENT, type RecordProgressSavedDetail } from "@/player/recordTrackProgress";

import { RecordDeleteDialog, type RecordDeleteTarget } from "./RecordDeleteDialog";
import {
  RecordFileList,
  RecordFolderTile,
  RecordPhotoTile,
  RecordSection,
  RecordSectionMore,
  RecordVideoTile,
} from "./RecordGrid";
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
import { crumbFromFolder, siblingIds } from "./recordsModel";
import { useRecordRoot, useRecordSiblings, useRecordTree } from "./useRecordLibrary";
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
  // A root that lost its marker keeps its catalog and is browsed as usual.
  const online = root?.state === "online" || root?.state === "marker_missing";
  const {
    tree,
    trail,
    pending,
    version,
    loadMore,
    readWhole,
    reload: reloadTree,
  } = useRecordTree(location.folderId, historyState, enabled && online);
  const scan = useRecordScan({ reloadRoot, onFinished: reloadTree });
  const [autoResumeId, setAutoResumeId] = useState<number | null>(null);
  // An audio file the Continue list asked for, played once its folder's listing arrives.
  const [pendingAudio, setPendingAudio] = useState<RecordAsset | null>(null);
  const player = useLibraryPlayer();
  // The track playing now, read when a section's later pages arrive for the queue.
  const currentTrackRef = useRef(player.currentTrack);
  useLayoutEffect(() => {
    currentTrackRef.current = player.currentTrack;
  });

  const listing = tree.status === "ready" && tree.folderId === location.folderId ? tree : null;
  const sections = listing?.sections ?? null;

  const playableItems = useMemo(
    () =>
      sections
        ? [
            ...sections.videos.items,
            ...sections.audio.items,
            ...sections.files.items.filter((item) => item.kind === "audio"),
          ]
        : noMedia,
    [sections],
  );
  const { progress, remember } = useRecordProgress(location.folderId, playableItems);
  const [savedToken, setSavedToken] = useState(0);
  const continueAssets = useRecordContinue(enabled && online && location.overlay === null, savedToken);
  const placement = useRecordSiblings(location.overlay?.assetId ?? null, version);

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
  const tracksOf = (items: readonly RecordAsset[]) =>
    items.map((item) => recordPlayerTrack(item, folderName, progress.get(item.id) ?? item.progress));
  // Plays `items` in the global player from `id`, at `position` or where it was left.
  const playTracks = useStableCallback((items: readonly RecordAsset[], id: number, position?: number) => {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    player.playQueue(
      tracksOf(items),
      recordTrackLocationId(id),
      position ?? resumePosition(progress.get(id) ?? item.progress) ?? 0,
    );
  });
  // Counts the plays this page starts; a section read finishing after a later one does nothing.
  const playRequestRef = useRef(0);
  /**
   * Plays a section's files from `id`. A file already listed plays at once,
   * and the section's later pages join the queue as they arrive, unless
   * something else plays by then; a file not listed yet plays once the
   * section is read.
   */
  const playSection = useStableCallback((name: "audio" | "videos", id: number, position?: number) => {
    const section = sections?.[name];
    if (!section) return;
    const request = ++playRequestRef.current;
    if (!section.items.some((item) => item.id === id)) {
      void readWhole(name)
        .then((whole) => {
          if (whole && request === playRequestRef.current) playTracks(whole, id, position);
        })
        .catch(() => undefined);
      return;
    }
    playTracks(section.items, id, position);
    if (!section.next) return;
    const queued = new Set(section.items.map((item) => item.id));
    void readWhole(name)
      .then((whole) => {
        if (!whole || request !== playRequestRef.current) return;
        const rest = whole.filter((item) => !queued.has(item.id));
        const playing = currentTrackRef.current?.locationId;
        if (rest.length > 0 && whole.some((item) => recordTrackLocationId(item.id) === playing)) {
          player.appendQueue(tracksOf(rest));
        }
      })
      .catch(() => undefined);
  });
  const playAudio = useStableCallback((id: number) => playSection("audio", id));
  // A video tile plays its sound from where the video was left.
  const listenToVideoTile = useStableCallback((id: number) => playSection("videos", id));
  const listenToVideo = (id: number, position: number) => {
    closeOverlay();
    playSection("videos", id, position);
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
    if (!pendingAudio) return;
    // Leaving the folder, or a folder listing that fails, drops the request.
    if (
      location.folderId !== pendingAudio.folderId ||
      (tree.status === "error" && tree.folderId === pendingAudio.folderId)
    ) {
      setPendingAudio(null);
      return;
    }
    if (!sections || listing?.folderId !== pendingAudio.folderId) return;
    const asset = pendingAudio;
    setPendingAudio(null);
    const request = ++playRequestRef.current;
    void readWhole("audio")
      .then((whole) => {
        if (!whole || request !== playRequestRef.current) return;
        if (whole.some((item) => item.id === asset.id)) playTracks(whole, asset.id);
        else
          player.playQueue(
            [recordPlayerTrack(asset, folderName, asset.progress)],
            recordTrackLocationId(asset.id),
            resumePosition(asset.progress) ?? 0,
          );
      })
      .catch(() => undefined);
  }, [folderName, listing?.folderId, location.folderId, pendingAudio, playTracks, player, readWhole, sections, tree]);

  const overlay = location.overlay;
  const overlaySection = overlay && sections ? (overlay.kind === "video" ? sections.videos : sections.photos) : null;
  const placed = overlay && placement?.siblings?.asset.id === overlay.assetId ? placement.siblings : null;
  const overlayAsset = placed?.asset ?? overlaySection?.items.find((item) => item.id === overlay?.assetId) ?? null;
  // The server places the open file in its whole section; until it answers, the listed files stand in.
  const overlaySiblings =
    overlay && overlaySection && overlayAsset
      ? placed
        ? {
            index: placed.index,
            total: placed.total,
            previous: placed.previous ?? null,
            next: placed.next ?? null,
            previousId: placed.previous?.id ?? null,
            nextId: placed.next?.id ?? null,
          }
        : {
            index: Math.max(0, overlaySection.items.indexOf(overlayAsset)),
            total: overlaySection.total,
            previous: neighbour(overlaySection.items, overlayAsset.id, "previous"),
            next: neighbour(overlaySection.items, overlayAsset.id, "next"),
            previousId: siblingIds(overlaySection.items, overlayAsset.id).previous,
            nextId: siblingIds(overlaySection.items, overlayAsset.id).next,
          }
      : null;

  // The file or folder whose deletion is under review.
  const [deleting, setDeleting] = useState<RecordDeleteTarget | null>(null);
  const reviewDelete = useStableCallback((asset: RecordAsset) => setDeleting({ kind: "file", asset }));
  const reviewFolderDelete = useStableCallback((folder: RecordFolder) => setDeleting({ kind: "folder", folder }));
  // A deleted file open in the viewer gives way to its next sibling, or the previous one.
  const finishDelete = (target: RecordDeleteTarget) => {
    setDeleting(null);
    const open = location.overlay;
    const asset = target.kind === "file" ? target.asset : null;
    if (asset && open && open.assetId === asset.id) {
      const target = overlaySiblings?.nextId ?? overlaySiblings?.previousId ?? null;
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
  if (root.state !== "online" && root.state !== "marker_missing") {
    const offline = root.state === "offline";
    return (
      <RecordRetryNotice
        title={offline ? t("records.offlineTitle") : t("records.unreadableTitle")}
        message={offline ? t("records.offlineMessage") : t("records.unreadableMessage")}
        onRetry={() => void reloadRoot()}
      />
    );
  }

  const overlayVideo = overlay?.kind === "video" ? overlayAsset : null;
  const overlayPhoto = overlay?.kind === "photo" ? overlayAsset : null;
  const shown = sections ? [sections.folders, sections.videos, sections.photos, sections.files] : [];
  const isEmpty = sections !== null && shown.every((section) => section.total === 0);
  const scanBusy =
    scan.state.status === "queueing" || scan.state.status === "queued" || scan.state.status === "running";
  const showSectionHeadings = shown.filter((section) => section.total > 0).length > 1;
  // The end of a section with more to read reads the next page as it nears the viewport.
  const more = (name: "folders" | "videos" | "photos" | "files") => {
    const section = sections?.[name];
    return section?.next ? (
      <RecordSectionMore loading={section.loading} failed={section.failed} onMore={() => loadMore(name)} />
    ) : null;
  };

  const foldersGrid = sections && sections.folders.total > 0 && (
    <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 2xl:grid-cols-8">
      {sections.folders.items.map((folder) => (
        <RecordFolderTile
          key={folder.id}
          folder={folder}
          onOpen={openFolder}
          onDelete={canDelete ? reviewFolderDelete : undefined}
        />
      ))}
    </div>
  );

  const videosGrid = sections && sections.videos.total > 0 && (
    <div className="grid grid-cols-2 gap-x-3 gap-y-4 md:grid-cols-3 xl:grid-cols-4">
      {sections.videos.items.map((video) => (
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

  const photosGrid = sections && sections.photos.total > 0 && (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {sections.photos.items.map((photo) => (
        <RecordPhotoTile key={photo.id} photo={photo} onOpen={openPhoto} />
      ))}
    </div>
  );

  const filesList = sections && sections.files.total > 0 && (
    <RecordFileList
      files={sections.files.items}
      progress={progress}
      onPlay={playAudio}
      onDelete={canDelete ? reviewDelete : undefined}
    />
  );

  return (
    <div className="space-y-4">
      {root.state === "marker_missing" && (
        <p
          role="status"
          className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground"
        >
          {t("records.markerMissingNotice")}
        </p>
      )}
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
      ) : !sections ? (
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
              <RecordSection title={t("records.sections.folders")} count={sections.folders.total}>
                {foldersGrid}
                {more("folders")}
              </RecordSection>
            ) : (
              <>
                {foldersGrid}
                {more("folders")}
              </>
            ))}
          {videosGrid &&
            (showSectionHeadings ? (
              <RecordSection title={t("records.sections.videos")} count={sections.videos.total}>
                {videosGrid}
                {more("videos")}
              </RecordSection>
            ) : (
              <>
                {videosGrid}
                {more("videos")}
              </>
            ))}
          {photosGrid &&
            (showSectionHeadings ? (
              <RecordSection title={t("records.sections.photos")} count={sections.photos.total}>
                {photosGrid}
                {more("photos")}
              </RecordSection>
            ) : (
              <>
                {photosGrid}
                {more("photos")}
              </>
            ))}
          {filesList &&
            (showSectionHeadings ? (
              <RecordSection title={t("records.sections.files")} count={sections.files.total}>
                {filesList}
                {more("files")}
              </RecordSection>
            ) : (
              <>
                {filesList}
                {more("files")}
              </>
            ))}
        </div>
      )}

      {overlayVideo && overlaySiblings && (
        <RecordMediaPlayer
          key={overlayVideo.id}
          asset={overlayVideo}
          subtitle={overlayVideo.subtitle}
          index={overlaySiblings.index}
          total={overlaySiblings.total}
          previousId={overlaySiblings.previousId}
          nextId={overlaySiblings.nextId}
          knownProgress={progress.get(overlayVideo.id) ?? overlayVideo.progress}
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
      {overlayPhoto && overlaySiblings && (
        <RecordPhotoViewer
          photo={overlayPhoto}
          index={overlaySiblings.index}
          total={overlaySiblings.total}
          previous={overlaySiblings.previous}
          next={overlaySiblings.next}
          onStep={(id) => navigate((at, state) => stepOverlayNavigation(at, state, id))}
          onDelete={canDelete ? () => reviewDelete(overlayPhoto) : undefined}
          onClose={closeOverlay}
        />
      )}
      {deleting && <RecordDeleteDialog target={deleting} onCancel={() => setDeleting(null)} onDeleted={finishDelete} />}
    </div>
  );
}

function neighbour<T extends { id: number }>(items: readonly T[], id: number, side: "previous" | "next") {
  const target = siblingIds(items, id)[side];
  return target === null ? null : (items.find((item) => item.id === target) ?? null);
}
