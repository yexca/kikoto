import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api, type RecordAsset, type RecordFolder, type RecordProgress, type RecordRoot } from "@/lib/api";

import { RecordFolderTile, RecordPhotoTile, RecordSection, RecordVideoTile } from "./RecordGrid";
import { RecordPhotoViewer } from "./RecordPhotoViewer";
import {
  RecordDemoNotice,
  RecordEmptyNotice,
  RecordLoading,
  RecordRetryNotice,
  RecordSetupNotice,
} from "./RecordStates";
import { RecordsToolbar } from "./RecordsToolbar";
import { RecordVideoPlayer } from "./RecordVideoPlayer";
import {
  closeOverlayNavigation,
  openCrumbNavigation,
  openFolderNavigation,
  openFolderVideoNavigation,
  openOverlayNavigation,
  stepOverlayNavigation,
} from "./recordsLocation";
import { crumbFromFolder, recordFolderView, siblingIds } from "./recordsModel";
import { useRecordRoot, useRecordTree } from "./useRecordLibrary";
import { useRecordContinue, useRecordProgress } from "./useRecordProgress";
import { useRecordScan } from "./useRecordScan";
import { useRecordsLocation } from "./useRecordsLocation";

const noVideos: readonly RecordAsset[] = [];

function isEditableElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The Record surface: a folder browser over the independent record root with
 * its own full-screen video player and photo viewer. The folder and any open
 * overlay live in the URL, so Back, Forward, and reload keep the place.
 */
export function RecordsBrowser() {
  const auth = useAuth();
  const { t } = useTranslation();
  const phone = useMobileNavigationLayout();
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
  const scan = useRecordScan({ reloadRoot, onFinished: reloadTree });
  const [initializing, setInitializing] = useState<"idle" | "busy" | "failed">("idle");
  const [autoResumeId, setAutoResumeId] = useState<number | null>(null);

  const listing = tree.status === "ready" && tree.folderId === location.folderId ? tree : null;
  const view = useMemo(() => (listing ? recordFolderView(listing.folders, listing.assets) : null), [listing]);

  const { progress, remember } = useRecordProgress(location.folderId, view?.videos ?? noVideos);
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
  const openContinue = (video: RecordAsset) => {
    setAutoResumeId(video.id);
    navigate((at) => openFolderVideoNavigation(at, video.folderId, video.id));
  };

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
  const scanBusy =
    scan.state.status === "queueing" || scan.state.status === "queued" || scan.state.status === "running";
  const sectionCount = view
    ? (view.folders.length > 0 ? 1 : 0) + (view.videos.length > 0 ? 1 : 0) + (view.photos.length > 0 ? 1 : 0)
    : 0;
  const showSectionHeadings = sectionCount > 1;

  const foldersGrid = view && view.folders.length > 0 && (
    <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 2xl:grid-cols-8">
      {view.folders.map((folder) => (
        <RecordFolderTile key={folder.id} folder={folder} onOpen={openFolder} />
      ))}
    </div>
  );

  const videosGrid = view && view.videos.length > 0 && (
    <div className="grid grid-cols-2 gap-x-3 gap-y-4 md:grid-cols-3 xl:grid-cols-4">
      {view.videos.map((video) => (
        <RecordVideoTile key={video.id} video={video} progress={progress.get(video.id)} onOpen={openVideo} />
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
