import {
  BookmarkPlus,
  Check,
  ChevronDown,
  Clock3,
  Edit3,
  ExternalLink,
  GitFork,
  HardDrive,
  HardDriveDownload,
  MoreHorizontal,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";

import { WorkCardListButton, WorkCardQuickMarkButton } from "@/components/work-card/WorkCardShell";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import type { RemoteSourceAvailability } from "@/features/work-detail/source/sourceContextModel";
import type { ListeningStatus } from "@/lib/api";

export type DetailActionMode = "local" | "tracked_unforked" | "tracked_forked" | "remote_source";

export function WorkIdentityActionBar({
  busy,
  canPlay = false,
  listeningStatus,
  favorite,
  listWorkId,
  onEnsureListWork,
  onListSaved,
  onPlay,
  onResume,
  onMark,
  onSync,
  onEditMetadata,
  dlsiteUrl,
  metadataSyncBusy = false,
  syncLabel = "Refresh metadata",
}: {
  busy: boolean;
  canPlay?: boolean;
  listeningStatus: ListeningStatus;
  favorite: boolean;
  listWorkId: number | null;
  onEnsureListWork?: () => Promise<number | null>;
  onListSaved?: (favorite: boolean, workID: number) => void;
  onPlay?: () => void;
  onResume?: () => void;
  onMark: (status: ListeningStatus) => void;
  onSync?: () => void;
  onEditMetadata?: () => void;
  dlsiteUrl: string;
  metadataSyncBusy?: boolean;
  syncLabel?: string;
}) {
  const [manageMenuOpen, setManageMenuOpen] = useState(false);
  const manageMenuRef = useRef<HTMLDivElement | null>(null);

  return (
    <>
      {onPlay && (
        <Button size="sm" className="h-8" disabled={!canPlay || busy} onClick={onPlay}>
          <Play className="h-4 w-4" />
          Play
        </Button>
      )}
      {onResume && (
        <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={onResume}>
          <Clock3 className="h-4 w-4" />
          Resume
        </Button>
      )}
      <WorkCardQuickMarkButton value={listeningStatus} disabled={busy} showLabel onChange={onMark} />
      <WorkCardListButton
        workId={listWorkId}
        active={favorite}
        disabled={busy}
        showLabel
        ensureWorkId={onEnsureListWork}
        onSaved={onListSaved}
      />
      {dlsiteUrl && (
        <Button variant="outline" size="sm" className="h-8" asChild>
          <a href={dlsiteUrl} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" />
            DLsite
          </a>
        </Button>
      )}
      {(onSync || onEditMetadata) && (
        <div className="relative" ref={manageMenuRef}>
          <Button variant="outline" size="sm" className="relative h-8 pr-7" disabled={busy} onClick={() => setManageMenuOpen((open) => !open)}>
            <MoreHorizontal className="h-4 w-4" />
            Manage
            <ChevronDown className="absolute right-2 h-3 w-3" />
          </Button>
          <AnchoredPopover open={manageMenuOpen} anchorRef={manageMenuRef} onOpenChange={setManageMenuOpen} className="w-52 p-1 text-sm" zIndex={70}>
            {onSync && (
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                disabled={metadataSyncBusy}
                onClick={() => {
                  setManageMenuOpen(false);
                  onSync();
                }}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${metadataSyncBusy ? "animate-spin" : ""}`} />
                <span>{metadataSyncBusy ? "Metadata refresh running" : syncLabel}</span>
              </button>
            )}
            {onEditMetadata && (
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  setManageMenuOpen(false);
                  onEditMetadata();
                }}
              >
                <Edit3 className="h-3.5 w-3.5" />
                <span>Edit metadata</span>
              </button>
            )}
          </AnchoredPopover>
        </div>
      )}
    </>
  );
}

export function MediaContextActionBar({
  busy,
  mode,
  onTrack,
  trackDisabled,
  forkSources = [],
  currentForkSource,
  onFork,
  onFetch,
  remoteSourceWorkUrl,
  remoteSourceName,
  onManageCache,
  manageCacheDisabled = false,
  onManageFiles,
  onRefreshLocalFiles,
}: {
  busy: boolean;
  mode: DetailActionMode;
  onTrack?: () => void;
  trackDisabled?: boolean;
  forkSources?: RemoteSourceAvailability[];
  currentForkSource?: RemoteSourceAvailability | null;
  onFork?: (remote: RemoteSourceAvailability) => void;
  onFetch?: () => void;
  remoteSourceWorkUrl?: string;
  remoteSourceName?: string;
  onManageCache?: () => void;
  manageCacheDisabled?: boolean;
  onManageFiles?: () => void;
  onRefreshLocalFiles?: () => void;
}) {
  const [forkMenuOpen, setForkMenuOpen] = useState(false);
  const [filesMenuOpen, setFilesMenuOpen] = useState(false);
  const forkMenuRef = useRef<HTMLDivElement | null>(null);
  const filesMenuRef = useRef<HTMLDivElement | null>(null);

  return (
    <>
      {mode === "remote_source" && onTrack && (
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={busy || trackDisabled}
          onClick={onTrack}
          title={trackDisabled ? "Already tracked" : "Track remote work"}
        >
          <BookmarkPlus className="h-4 w-4" />
          Track
        </Button>
      )}
      {(mode === "tracked_unforked" || mode === "tracked_forked") && onFork && (
        <div className="relative" ref={forkMenuRef}>
          <Button
            variant="outline"
            size="sm"
            className="relative h-8 pr-7"
            disabled={busy || forkSources.length === 0}
            onClick={() => setForkMenuOpen((open) => !open)}
            title={mode === "tracked_forked" ? "Switch fork source" : "Fork tracked source"}
          >
            <GitFork className="h-4 w-4" />
            {mode === "tracked_forked" ? "Switch fork" : "Fork"}
            {forkSources.length > 0 && <ChevronDown className="absolute right-2 h-3 w-3" />}
          </Button>
          <AnchoredPopover open={forkMenuOpen} anchorRef={forkMenuRef} onOpenChange={setForkMenuOpen} className="w-60 p-1 text-sm">
            {forkSources.map((remote) => {
              const active = currentForkSource?.source.id === remote.source.id;
              return (
                <button
                  key={remote.source.id}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => {
                    setForkMenuOpen(false);
                    onFork(remote);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{remote.source.displayName}</span>
                  {active && <Check className="h-3.5 w-3.5 text-primary" />}
                </button>
              );
            })}
          </AnchoredPopover>
        </div>
      )}
      {onFetch && (
        <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={onFetch}>
          <HardDriveDownload className="h-4 w-4" />
          Fetch
        </Button>
      )}
      {remoteSourceWorkUrl && (
        <Button variant="outline" size="sm" className="h-8" asChild>
          <a href={remoteSourceWorkUrl} target="_blank" rel="noopener noreferrer" title={`Open on ${remoteSourceName || "source"}`}>
            <ExternalLink className="h-4 w-4" />
            Origin
          </a>
        </Button>
      )}
      {onManageCache && (
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={busy || manageCacheDisabled}
          title={manageCacheDisabled ? "No cached files" : "Manage cached files"}
          onClick={onManageCache}
        >
          <HardDrive className="h-4 w-4" />
          Manage cache
        </Button>
      )}
      {(onManageFiles || onRefreshLocalFiles) && (
        <div className="relative" ref={filesMenuRef}>
          <Button variant="outline" size="sm" className="relative h-8 pr-7" disabled={busy} onClick={() => setFilesMenuOpen((open) => !open)}>
            <MoreHorizontal className="h-4 w-4" />
            Files
            <ChevronDown className="absolute right-2 h-3 w-3" />
          </Button>
          <AnchoredPopover open={filesMenuOpen} anchorRef={filesMenuRef} onOpenChange={setFilesMenuOpen} className="w-48 p-1 text-sm" bottomCollisionPadding={96} zIndex={70}>
            {onManageFiles && (
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  setFilesMenuOpen(false);
                  onManageFiles();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Manage files</span>
              </button>
            )}
            {onRefreshLocalFiles && (
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  setFilesMenuOpen(false);
                  onRefreshLocalFiles();
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Refresh local files</span>
              </button>
            )}
          </AnchoredPopover>
        </div>
      )}
    </>
  );
}
