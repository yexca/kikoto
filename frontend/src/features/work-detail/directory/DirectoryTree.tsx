import {
  directoryLyricsAttachments,
  folderPlaybackTracks,
  formatBytes,
  formatTrackDuration,
  playableFiles,
  type TreeNode,
  treeStats,
  type TreeTrack,
} from "@/features/work-detail/media/mediaTreeModel";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Captions,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  Headphones,
  MoreHorizontal,
  Pause,
} from "lucide-react";
import i18n from "@/i18n";
import { type DirectoryRoutingRule, mediaDownloadURL } from "@/lib/api";
import type { FilePreviewState } from "@/features/work-detail/dialogs/FilePreviewDialog";
import {
  fileKindLabel,
  flattenVisibleTreeRows,
  folderSummary,
  initialExpandedTreePaths,
  nodeAtPath,
  previewForFile,
  recommendedDirectoryPath,
  sortedFiles,
  sortedFolders,
} from "@/features/work-detail/directory/directoryModel";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { fileIcon, formatFolderStats } from "@/features/work-detail/dialogs/mediaFilePresentation";
import { type LyricsChoice, lyricsChoiceDisplayLabel } from "@/player/lyricsMatching";
import { preferredLyricsMediaItemID, useLibraryPlayer } from "@/player/PlayerProvider";
import { useDismissiblePopover } from "@/hooks/useDismissiblePopover";

function useDirectoryLyricsAttachmentVisibility(root: TreeNode) {
  const attachments = useMemo(() => directoryLyricsAttachments(root), [root]);
  const [showingAll, setShowingAll] = useState(false);
  const [revealedLocationIDs, setRevealedLocationIDs] = useState<Set<number>>(new Set());
  useEffect(() => {
    setShowingAll(false);
    setRevealedLocationIDs(new Set());
  }, [root]);
  const contains = useCallback((locationID: number) => attachments.hiddenLocationIds.has(locationID), [attachments]);
  const isHidden = useCallback(
    (locationID: number) => contains(locationID) && !showingAll && !revealedLocationIDs.has(locationID),
    [contains, revealedLocationIDs, showingAll],
  );
  const reveal = useCallback(
    (locationID: number) => {
      if (!attachments.hiddenLocationIds.has(locationID)) return;
      setRevealedLocationIDs((current) => new Set(current).add(locationID));
    },
    [attachments],
  );
  const toggleAll = useCallback(() => {
    if (showingAll) setRevealedLocationIDs(new Set());
    setShowingAll(!showingAll);
  }, [showingAll]);
  return {
    contains,
    isHidden,
    reveal,
    showingAll,
    toggleAll,
    total: attachments.hiddenLocationIds.size,
  };
}

function LyricsAttachmentsToggle({
  count,
  showingAll,
  onToggle,
}: {
  count: number;
  showingAll: boolean;
  onToggle: () => void;
}) {
  if (count === 0) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-11 w-full justify-center text-xs sm:h-8 sm:w-auto"
      onClick={onToggle}
      aria-pressed={showingAll}
    >
      <Captions className="h-4 w-4" />
      {showingAll ? i18n.t("libraryDetail.hideAttachedLyrics") : i18n.t("libraryDetail.showAttachedLyrics", { count })}
    </Button>
  );
}

export function DirectoryTree({
  root,
  directoryRoutingRules,
  focusPath,
  focusRequestKey,
  currentLocationId,
  currentPlaybackKey,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
  emptyLabel = i18n.t("libraryDetail.noLocalFiles"),
}: {
  root: TreeNode;
  directoryRoutingRules: DirectoryRoutingRule[];
  focusPath?: string[];
  focusRequestKey?: string;
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
  emptyLabel?: string;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() =>
    initialExpandedTreePaths(root, directoryRoutingRules),
  );
  const [visibleLimit, setVisibleLimit] = useState(160);
  const appliedFocusRequestKeyRef = useRef<string | null>(null);
  const lyricsAttachments = useDirectoryLyricsAttachmentVisibility(root);
  useEffect(() => {
    setExpandedPaths(initialExpandedTreePaths(root, directoryRoutingRules));
    setVisibleLimit(160);
  }, [root, directoryRoutingRules]);
  useEffect(() => {
    if (!focusPath || !nodeAtPath(root, focusPath)) return;
    const requestKey = focusRequestKey ?? focusPath.join("\u0000");
    if (appliedFocusRequestKeyRef.current === requestKey) return;
    appliedFocusRequestKeyRef.current = requestKey;
    setExpandedPaths((current) => {
      const next = new Set(current);
      let cursor: TreeNode | null = root;
      for (const part of focusPath) {
        cursor = cursor?.children.get(part) ?? null;
        if (!cursor) break;
        next.add(cursor.path);
      }
      return next;
    });
  }, [focusPath, focusRequestKey, root]);
  const rows = useMemo(
    () =>
      flattenVisibleTreeRows(root, expandedPaths).filter(
        (row) => row.type === "folder" || !lyricsAttachments.isHidden(row.file.locationId),
      ),
    [root, expandedPaths, lyricsAttachments.isHidden],
  );
  const visibleRows = rows.slice(0, visibleLimit);
  const toggleFolder = (path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  if (rows.length === 0) {
    return <div className="text-sm text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-2">
      <LyricsAttachmentsToggle
        count={lyricsAttachments.total}
        showingAll={lyricsAttachments.showingAll}
        onToggle={lyricsAttachments.toggleAll}
      />
      <div className="space-y-1">
        {visibleRows.map((row) =>
          row.type === "folder" ? (
            <TreeFolderRow
              key={`folder:${row.node.path}`}
              node={row.node}
              depth={row.depth}
              expanded={expandedPaths.has(row.node.path)}
              onToggle={() => toggleFolder(row.node.path)}
            />
          ) : (
            <TreeFile
              key={`file:${row.file.playbackKey ?? row.file.locationId}`}
              file={row.file}
              files={folderPlaybackTracks(row.parent)}
              depth={row.depth}
              isActive={
                row.file.playbackKey === currentPlaybackKey ||
                (!row.file.playbackKey && row.file.locationId === currentLocationId)
              }
              onPlayFolder={onPlayFolder}
              onPlayNext={onPlayNext}
              onAppendQueue={onAppendQueue}
              onPreview={onPreview}
              isLyricsAttachmentHidden={lyricsAttachments.isHidden}
              onRevealLyricsAttachment={lyricsAttachments.reveal}
            />
          ),
        )}
      </div>
      {visibleRows.length < rows.length && (
        <Button variant="outline" size="sm" className="w-full" onClick={() => setVisibleLimit((value) => value + 160)}>
          Show more files ({rows.length - visibleRows.length} remaining)
        </Button>
      )}
    </div>
  );
}

export function DirectoryBrowser({
  root,
  directoryRoutingRules,
  routePath,
  routeRequestKey,
  currentLocationId,
  currentPlaybackKey,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
  emptyLabel = i18n.t("libraryDetail.localFilesUnavailable"),
}: {
  root: TreeNode;
  directoryRoutingRules: DirectoryRoutingRule[];
  routePath?: string[];
  routeRequestKey?: string;
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
  emptyLabel?: string;
}) {
  const [path, setPath] = useState<string[]>(() => recommendedDirectoryPath(root, directoryRoutingRules));
  const appliedRouteRequestKeyRef = useRef<string | null>(null);
  const lyricsAttachments = useDirectoryLyricsAttachmentVisibility(root);
  const current = useMemo(() => nodeAtPath(root, path) ?? root, [root, path]);
  const folders = sortedFolders(current);
  const allFiles = sortedFiles(current);
  const files = allFiles.filter((file) => !lyricsAttachments.isHidden(file.locationId));
  const currentLyricsAttachmentCount = allFiles.filter((file) => lyricsAttachments.contains(file.locationId)).length;
  useEffect(() => {
    if (!nodeAtPath(root, path)) {
      setPath(recommendedDirectoryPath(root, directoryRoutingRules));
    }
  }, [root, path, directoryRoutingRules]);

  useEffect(() => {
    setPath(recommendedDirectoryPath(root, directoryRoutingRules));
  }, [root, directoryRoutingRules]);
  useEffect(() => {
    if (!routePath || !nodeAtPath(root, routePath)) return;
    const requestKey = routeRequestKey ?? routePath.join("\u0000");
    if (appliedRouteRequestKeyRef.current === requestKey) return;
    appliedRouteRequestKeyRef.current = requestKey;
    setPath(routePath);
  }, [routePath, routeRequestKey, root]);

  if (folders.length === 0 && files.length === 0) {
    return <div className="text-sm text-muted-foreground">{emptyLabel}</div>;
  }

  return (
    <div className="space-y-3">
      <DirectoryBreadcrumb path={path} onChange={setPath} />
      <LyricsAttachmentsToggle
        count={currentLyricsAttachmentCount}
        showingAll={lyricsAttachments.showingAll}
        onToggle={lyricsAttachments.toggleAll}
      />
      <div className="space-y-1">
        {path.length > 0 && (
          <button
            className="flex min-h-11 w-full items-start gap-2 rounded-md border bg-background px-3 py-2 text-left text-sm hover:bg-muted"
            onClick={() => setPath(path.slice(0, -1))}
          >
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
            <span>{i18n.t("libraryDetail.parentFolder")}</span>
          </button>
        )}
        {folders.map((folder) => (
          <button
            key={folder.path || folder.name}
            className="flex min-h-11 w-full items-start gap-2 rounded-md border bg-background px-3 py-2 text-left text-sm hover:bg-muted"
            onClick={() => setPath([...path, folder.name])}
          >
            <Folder className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]">{folder.name}</span>
            <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{folderSummary(folder)}</span>
          </button>
        ))}
        {files.map((file) => (
          <TreeFile
            key={file.playbackKey ?? file.locationId}
            file={file}
            files={folderPlaybackTracks(current)}
            depth={0}
            isActive={
              file.playbackKey === currentPlaybackKey || (!file.playbackKey && file.locationId === currentLocationId)
            }
            onPlayFolder={onPlayFolder}
            onPlayNext={onPlayNext}
            onAppendQueue={onAppendQueue}
            onPreview={onPreview}
            isLyricsAttachmentHidden={lyricsAttachments.isHidden}
            onRevealLyricsAttachment={lyricsAttachments.reveal}
          />
        ))}
      </div>
    </div>
  );
}

function DirectoryBreadcrumb({ path, onChange }: { path: string[]; onChange: (path: string[]) => void }) {
  const [ancestorMenuOpen, setAncestorMenuOpen] = useState(false);
  const ancestorMenuRef = useRef<HTMLButtonElement | null>(null);
  const current = path[path.length - 1] ?? "";
  const ancestors = path.slice(0, -1);

  useEffect(() => setAncestorMenuOpen(false), [path]);

  return (
    <nav
      data-testid="directory-breadcrumb"
      className="min-h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
      aria-label={i18n.t("libraryDetail.parentFolder")}
    >
      <div className="flex min-h-9 min-w-0 items-center gap-1 overflow-hidden lg:hidden">
        <button className="shrink-0 rounded px-2 py-1 font-medium hover:bg-muted" onClick={() => onChange([])}>
          {i18n.t("libraryDetail.root")}
        </button>
        {path.length > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        {ancestors.length > 0 && (
          <>
            <button
              ref={ancestorMenuRef}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setAncestorMenuOpen((open) => !open)}
              aria-label={i18n.t("libraryDetail.showParentFolders", { count: ancestors.length })}
              aria-haspopup="menu"
              aria-expanded={ancestorMenuOpen}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <AnchoredPopover
              open={ancestorMenuOpen}
              anchorRef={ancestorMenuRef}
              onOpenChange={setAncestorMenuOpen}
              className="w-[min(20rem,calc(100vw-1.5rem))] p-1"
              bottomCollisionPadding={96}
            >
              <div role="menu" aria-label={i18n.t("libraryDetail.parentFolder")}>
                {ancestors.map((part, index) => (
                  <button
                    key={`${part}:${index}`}
                    role="menuitem"
                    className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                    title={part}
                    onClick={() => onChange(path.slice(0, index + 1))}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{part}</span>
                  </button>
                ))}
              </div>
            </AnchoredPopover>
          </>
        )}
        {current && (
          <span
            data-testid="directory-breadcrumb-current"
            className="min-w-0 max-w-[55vw] truncate rounded px-2 py-1 font-medium sm:max-w-[20rem]"
            title={current}
            aria-current="page"
          >
            {current}
          </span>
        )}
      </div>

      <div className="app-scrollbar hidden min-h-9 min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap lg:flex">
        <button className="shrink-0 rounded px-2 py-1 font-medium hover:bg-muted" onClick={() => onChange([])}>
          {i18n.t("libraryDetail.root")}
        </button>
        {path.map((part, index) => {
          const isCurrent = index === path.length - 1;
          return (
            <span key={`${part}:${index}`} className="inline-flex min-w-0 shrink-0 items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {isCurrent ? (
                <span
                  className="block max-w-[20rem] truncate rounded px-2 py-1 font-medium"
                  title={part}
                  aria-current="page"
                >
                  {part}
                </span>
              ) : (
                <button
                  className="block max-w-[18rem] truncate rounded px-2 py-1 text-left font-medium hover:bg-muted"
                  title={part}
                  onClick={() => onChange(path.slice(0, index + 1))}
                >
                  {part}
                </button>
              )}
            </span>
          );
        })}
      </div>
    </nav>
  );
}

function TreeFolderRow({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const playable = playableFiles(node.files);
  const stats = treeStats(node);
  const filesLabel = formatFolderStats(stats, playable.length);
  return (
    <button
      className="flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm font-medium hover:bg-muted"
      style={{ paddingLeft: Math.min(depth, 8) * 14 + 8 }}
      onClick={onToggle}
    >
      {expanded ? (
        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <Folder className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]">{node.name}</span>
      {filesLabel && <span className="ml-auto shrink-0 pt-0.5 text-xs text-muted-foreground">{filesLabel}</span>}
    </button>
  );
}

type TreeFileActionState = {
  preview: FilePreviewState | null;
  canPlay: boolean;
  canPreview: boolean;
  canDownload: boolean;
  canOpen: boolean;
  lyricsChoices: LyricsChoice[];
  hasQueueActions: boolean;
  hasMoreActions: boolean;
  preferredLyricsMediaItemId: number | null;
  automaticLyrics: boolean;
  selectedLyricsChoice: LyricsChoice | null;
  fileMeta: string;
};

function treeFileDownloadable(file: TreeTrack) {
  return (
    file.locationId > 0 &&
    file.availability === "available" &&
    (file.locationType === "local" || file.locationType === "cache")
  );
}

function treeFileLyricsState(file: TreeTrack, lyricsPreferenceOverrides: Record<string, number | null>) {
  const lyricsChoices = file.kind === "audio" ? (file.lyricsChoices ?? []) : [];
  const preferredLyricsMediaItemId = preferredLyricsMediaItemID(file, lyricsPreferenceOverrides);
  const selectedLyricsChoice =
    lyricsChoices.find((choice) => choice.mediaItemId === preferredLyricsMediaItemId) ??
    lyricsChoices.find((choice) => choice.locationId === file.autoLyricsLocationId) ??
    lyricsChoices[0] ??
    null;
  return {
    lyricsChoices,
    preferredLyricsMediaItemId,
    automaticLyrics: preferredLyricsMediaItemId === null,
    selectedLyricsChoice,
  };
}

function treeFileMeta(file: TreeTrack) {
  return [
    fileKindLabel(file.kind),
    file.kind === "audio" || file.kind === "video" ? formatTrackDuration(file.durationSeconds) : "",
    file.sizeBytes === null ? i18n.t("libraryDetail.unknownSize") : formatBytes(file.sizeBytes),
  ]
    .filter(Boolean)
    .join(" · ");
}

function treeFileActionState({
  file,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
  lyricsPreferenceOverrides,
}: {
  file: TreeTrack;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
  lyricsPreferenceOverrides: Record<string, number | null>;
}): TreeFileActionState {
  const preview = previewForFile(file);
  const canPlay = Boolean(onPlayFolder && playableFiles([file]).length > 0);
  const canPreview = Boolean(preview && onPreview);
  const canDownload = treeFileDownloadable(file);
  const lyrics = treeFileLyricsState(file, lyricsPreferenceOverrides);
  const hasQueueActions = canPlay && (file.kind === "video" || Boolean(onPlayNext) || Boolean(onAppendQueue));
  return {
    preview,
    canPlay,
    canPreview,
    canDownload,
    canOpen: canPlay || canPreview || canDownload,
    lyricsChoices: lyrics.lyricsChoices,
    hasQueueActions,
    hasMoreActions: lyrics.lyricsChoices.length > 0 || hasQueueActions,
    preferredLyricsMediaItemId: lyrics.preferredLyricsMediaItemId,
    automaticLyrics: lyrics.automaticLyrics,
    selectedLyricsChoice: lyrics.selectedLyricsChoice,
    fileMeta: treeFileMeta(file),
  };
}

function openTreeFile({
  file,
  files,
  preview,
  canPlay,
  canDownload,
  onPlayFolder,
  onPreview,
}: {
  file: TreeTrack;
  files: TreeTrack[];
  preview: FilePreviewState | null;
  canPlay: boolean;
  canDownload: boolean;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPreview?: (preview: FilePreviewState) => void;
}) {
  if (preview && file.kind === "video") {
    onPreview?.(preview);
    return;
  }
  if (canPlay) {
    onPlayFolder?.(files, file.locationId);
    return;
  }
  if (preview) {
    onPreview?.(preview);
    return;
  }
  if (canDownload) window.open(mediaDownloadURL(file.locationId), "_blank", "noopener,noreferrer");
}

function TreeFileLyricsActions({
  file,
  choices,
  preferredLyricsMediaItemId,
  automaticLyrics,
  selectedLyricsChoice,
  open,
  anchorRef,
  onOpenChange,
  onCloseMore,
  onPreview,
  isLyricsAttachmentHidden,
  onRevealLyricsAttachment,
}: {
  file: TreeTrack;
  choices: LyricsChoice[];
  preferredLyricsMediaItemId: number | null;
  automaticLyrics: boolean;
  selectedLyricsChoice: LyricsChoice | null;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  onCloseMore: () => void;
  onPreview?: (preview: FilePreviewState) => void;
  isLyricsAttachmentHidden?: (locationId: number) => boolean;
  onRevealLyricsAttachment?: (locationId: number) => void;
}) {
  const player = useLibraryPlayer();
  return (
    <div className="hidden lg:block" onClick={(event) => event.stopPropagation()}>
      <button
        className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        onClick={() => {
          onCloseMore();
          onOpenChange(!open);
        }}
        aria-label={i18n.t("libraryDetail.lyricsFor", { title: file.title })}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={i18n.t("libraryDetail.lyrics")}
      >
        <Captions className="h-4 w-4" />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={onOpenChange}
        className="w-[min(22rem,calc(100vw-1.5rem))] rounded-lg border bg-card p-2 text-card-foreground shadow-xl"
        bottomCollisionPadding={96}
      >
        <div role="dialog" aria-label={i18n.t("libraryDetail.lyricsFor", { title: file.title })} className="space-y-2">
          <div className="px-1 py-0.5">
            <div className="text-sm font-semibold">{i18n.t("libraryDetail.lyrics")}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground" title={file.title}>
              {file.title}
            </div>
          </div>
          <div role="radiogroup" aria-label={i18n.t("libraryDetail.lyricsSource")} className="space-y-1">
            <button
              role="radio"
              aria-checked={automaticLyrics}
              className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${automaticLyrics ? "bg-secondary text-secondary-foreground" : "hover:bg-muted"}`}
              onClick={() => void player.changeLyricsChoice(file, null)}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{i18n.t("libraryDetail.auto")}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {selectedLyricsChoice
                    ? i18n.t("libraryDetail.matchesLyrics", {
                        label: lyricsChoiceDisplayLabel(selectedLyricsChoice, choices),
                      })
                    : i18n.t("libraryDetail.noAvailableMatch")}
                </span>
              </span>
              {automaticLyrics && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </button>
            {choices.map((choice) => {
              const selected = !automaticLyrics && choice.mediaItemId === preferredLyricsMediaItemId;
              return (
                <button
                  key={choice.locationId}
                  role="radio"
                  aria-checked={selected}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${selected ? "bg-secondary text-secondary-foreground" : "hover:bg-muted"}`}
                  onClick={() => void player.changeLyricsChoice(file, choice)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium" title={choice.displayPath || choice.title}>
                      {lyricsChoiceDisplayLabel(choice, choices)}
                    </span>
                    <span className="block text-xs text-muted-foreground">{lyricsMatchReasonLabel(choice.reason)}</span>
                  </span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-1 border-t pt-2">
            <button
              className="flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-sm hover:bg-muted sm:min-h-9"
              disabled={!selectedLyricsChoice || !onPreview}
              onClick={() => {
                if (!selectedLyricsChoice) return;
                onPreview?.(lyricsChoicePreview(selectedLyricsChoice));
                onOpenChange(false);
              }}
            >
              <FileText className="h-4 w-4" />
              {i18n.t("remoteFetch.actionPreview")}
            </button>
            {selectedLyricsChoice && isLyricsAttachmentHidden?.(selectedLyricsChoice.locationId) && (
              <button
                className="flex min-h-11 items-center justify-center gap-2 rounded-md px-2 text-sm hover:bg-muted sm:min-h-9"
                onClick={() => {
                  onRevealLyricsAttachment?.(selectedLyricsChoice.locationId);
                  onOpenChange(false);
                }}
              >
                <Folder className="h-4 w-4" />
                {i18n.t("libraryDetail.showInDirectory")}
              </button>
            )}
          </div>
          {file.lyricsPreferencePersistable === false && (
            <div className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
              {i18n.t("libraryDetail.temporaryPreview")}
            </div>
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function TreeFileMoreActions({
  file,
  files,
  choices,
  canPlay,
  hasQueueActions,
  open,
  anchorRef,
  onOpenChange,
  onOpenLyrics,
  onCloseLyrics,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
}: {
  file: TreeTrack;
  files: TreeTrack[];
  choices: LyricsChoice[];
  canPlay: boolean;
  hasQueueActions: boolean;
  open: boolean;
  anchorRef: RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
  onOpenLyrics: () => void;
  onCloseLyrics: () => void;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
}) {
  return (
    <div ref={anchorRef} className={hasQueueActions ? "" : "lg:hidden"} onClick={(event) => event.stopPropagation()}>
      <button
        className={`grid h-11 w-11 place-items-center rounded-md hover:bg-secondary hover:text-foreground sm:h-9 sm:w-9 ${hasQueueActions ? "" : "lg:hidden"}`}
        onClick={() => {
          onCloseLyrics();
          onOpenChange(!open);
        }}
        aria-label={i18n.t("libraryDetail.moreActionsFor", { title: file.title })}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        className={`w-52 rounded-lg border bg-card p-1 text-sm text-card-foreground shadow-xl ${hasQueueActions ? "" : "lg:hidden"}`}
      >
        <div role="menu" aria-label={i18n.t("libraryDetail.moreActionsFor", { title: file.title })}>
          {choices.length > 0 && (
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted lg:hidden"
              onClick={() => {
                onOpenChange(false);
                onOpenLyrics();
              }}
              aria-haspopup="dialog"
            >
              <Captions className="h-4 w-4" />
              {i18n.t("libraryDetail.lyrics")}
            </button>
          )}
          {canPlay && file.kind === "video" && (
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted sm:h-9 sm:min-h-0"
              onClick={() => {
                onPlayFolder?.(files, file.locationId);
                onOpenChange(false);
              }}
            >
              <Headphones className="h-4 w-4" />
              {i18n.t("libraryDetail.playAsAudio")}
            </button>
          )}
          {canPlay && onPlayNext && (
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center rounded-md px-2 text-left hover:bg-muted sm:h-9 sm:min-h-0"
              onClick={() => {
                onPlayNext(file);
                onOpenChange(false);
              }}
            >
              {i18n.t("libraryDetail.playNext")}
            </button>
          )}
          {canPlay && onAppendQueue && (
            <button
              role="menuitem"
              className="flex min-h-11 w-full items-center rounded-md px-2 text-left hover:bg-muted sm:h-9 sm:min-h-0"
              onClick={() => {
                onAppendQueue(file);
                onOpenChange(false);
              }}
            >
              {i18n.t("libraryDetail.addToQueue")}
            </button>
          )}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function TreeFile({
  file,
  files,
  depth,
  isActive,
  onPlayFolder,
  onPlayNext,
  onAppendQueue,
  onPreview,
  isLyricsAttachmentHidden,
  onRevealLyricsAttachment,
}: {
  file: TreeTrack;
  files: TreeTrack[];
  depth: number;
  isActive: boolean;
  onPlayFolder?: (tracks: TreeTrack[], locationId: number) => void;
  onPlayNext?: (track: TreeTrack) => void;
  onAppendQueue?: (track: TreeTrack) => void;
  onPreview?: (preview: FilePreviewState) => void;
  isLyricsAttachmentHidden?: (locationId: number) => boolean;
  onRevealLyricsAttachment?: (locationId: number) => void;
}) {
  const player = useLibraryPlayer();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [lyricsMenuOpen, setLyricsMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const actionAreaRef = useRef<HTMLSpanElement | null>(null);
  useDismissiblePopover(moreMenuOpen, moreMenuRef, () => setMoreMenuOpen(false));
  useDismissiblePopover(lyricsMenuOpen, actionAreaRef, () => setLyricsMenuOpen(false));
  const actionState = treeFileActionState({
    file,
    onPlayFolder,
    onPlayNext,
    onAppendQueue,
    onPreview,
    lyricsPreferenceOverrides: player.lyricsPreferenceOverrides,
  });
  const openFile = () =>
    openTreeFile({
      file,
      files,
      preview: actionState.preview,
      canPlay: actionState.canPlay,
      canDownload: actionState.canDownload,
      onPlayFolder,
      onPreview,
    });
  return (
    <div
      data-testid="directory-file-row"
      data-file-kind={file.kind}
      role={actionState.canOpen ? "button" : undefined}
      tabIndex={actionState.canOpen ? 0 : undefined}
      className={`flex min-h-14 items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm ${
        isActive ? "border-primary bg-secondary" : "bg-background hover:bg-muted"
      } ${actionState.canOpen ? "cursor-pointer" : "cursor-default"}`}
      style={{ marginLeft: Math.min(depth, 8) * 14, width: `calc(100% - ${Math.min(depth, 8) * 14}px)` }}
      onClick={() => {
        if (actionState.canOpen) openFile();
      }}
      onKeyDown={(event) => {
        if (!actionState.canOpen || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        openFile();
      }}
    >
      <span className="flex min-w-0 flex-1 items-start gap-2">
        <span className="mt-0.5 shrink-0">
          {isActive ? <Pause className="h-4 w-4 text-primary" /> : fileIcon(file)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block whitespace-normal break-words [overflow-wrap:anywhere]">{file.title}</span>
          <span className="mt-0.5 block break-words text-xs text-muted-foreground">{actionState.fileMeta}</span>
        </span>
      </span>
      <span ref={actionAreaRef} className="flex shrink-0 items-start gap-2 pt-0.5 text-xs text-muted-foreground">
        {file.kind === "file" && actionState.canDownload && (
          <ExternalLink className="h-3.5 w-3.5 text-primary" aria-label={i18n.t("libraryDetail.downloadsNewTab")} />
        )}
        {actionState.lyricsChoices.length > 0 && (
          <TreeFileLyricsActions
            file={file}
            choices={actionState.lyricsChoices}
            preferredLyricsMediaItemId={actionState.preferredLyricsMediaItemId}
            automaticLyrics={actionState.automaticLyrics}
            selectedLyricsChoice={actionState.selectedLyricsChoice}
            open={lyricsMenuOpen}
            anchorRef={actionAreaRef}
            onOpenChange={setLyricsMenuOpen}
            onCloseMore={() => setMoreMenuOpen(false)}
            onPreview={onPreview}
            isLyricsAttachmentHidden={isLyricsAttachmentHidden}
            onRevealLyricsAttachment={onRevealLyricsAttachment}
          />
        )}
        {actionState.hasMoreActions && (
          <TreeFileMoreActions
            file={file}
            files={files}
            choices={actionState.lyricsChoices}
            canPlay={actionState.canPlay}
            hasQueueActions={actionState.hasQueueActions}
            open={moreMenuOpen}
            anchorRef={moreMenuRef}
            onOpenChange={setMoreMenuOpen}
            onOpenLyrics={() => setLyricsMenuOpen(true)}
            onCloseLyrics={() => setLyricsMenuOpen(false)}
            onPlayFolder={onPlayFolder}
            onPlayNext={onPlayNext}
            onAppendQueue={onAppendQueue}
          />
        )}
      </span>
    </div>
  );
}

function lyricsMatchReasonLabel(reason: LyricsChoice["reason"]) {
  if (reason === "exact_sidecar") return i18n.t("libraryDetail.exactSidecar");
  if (reason === "same_stem") return i18n.t("libraryDetail.matchingFileName");
  if (reason === "normalized_name") return i18n.t("libraryDetail.normalizedFileName");
  return i18n.t("libraryDetail.sharedInFolder");
}

function lyricsChoicePreview(choice: LyricsChoice): FilePreviewState {
  return {
    kind: "text",
    title: choice.title,
    locationId: choice.locationId,
    url: choice.url,
  };
}
