import {
  Check,
  ChevronDown,
  Clock3,
  Edit3,
  ExternalLink,
  GitBranchPlus,
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
  listeningStatus,
  favorite,
  listWorkId,
  onEnsureListWork,
  onListSaved,
  onMark,
  onSync,
  onEditMetadata,
  dlsiteUrl,
  syncLabel,
}: {
  busy: boolean;
  listeningStatus: ListeningStatus;
  favorite: boolean;
  listWorkId: number | null;
  onEnsureListWork?: () => Promise<number | null>;
  onListSaved?: (favorite: boolean, workID: number) => void;
  onMark: (status: ListeningStatus) => void;
  onSync?: () => void;
  onEditMetadata?: () => void;
  dlsiteUrl: string;
  syncLabel: string;
}) {
  return (
    <>
      <WorkCardQuickMarkButton value={listeningStatus} disabled={busy} showLabel onChange={onMark} />
      <WorkCardListButton
        workId={listWorkId}
        active={favorite}
        disabled={busy}
        showLabel
        ensureWorkId={onEnsureListWork}
        onSaved={onListSaved}
      />
      {onSync && (
        <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={onSync}>
          <RefreshCw className="h-4 w-4" />
          {syncLabel}
        </Button>
      )}
      {onEditMetadata && (
        <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={onEditMetadata}>
          <Edit3 className="h-4 w-4" />
          Edit metadata
        </Button>
      )}
      {dlsiteUrl && (
        <Button variant="outline" size="sm" className="h-8" asChild>
          <a href={dlsiteUrl} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" />
            DLsite
          </a>
        </Button>
      )}
    </>
  );
}

export function MediaContextActionBar({
  canPlay,
  busy,
  mode,
  onPlay,
  onResume,
  onTrack,
  trackDisabled,
  forkSources = [],
  currentForkSource,
  onFork,
  onFetch,
  onManage,
  onRefreshLocalFiles,
}: {
  canPlay: boolean;
  busy: boolean;
  mode: DetailActionMode;
  onPlay: () => void;
  onResume?: () => void;
  onTrack?: () => void;
  trackDisabled?: boolean;
  forkSources?: RemoteSourceAvailability[];
  currentForkSource?: RemoteSourceAvailability | null;
  onFork?: (remote: RemoteSourceAvailability) => void;
  onFetch?: () => void;
  onManage?: () => void;
  onRefreshLocalFiles?: () => void;
}) {
  const [forkMenuOpen, setForkMenuOpen] = useState(false);
  const [manageMenuOpen, setManageMenuOpen] = useState(false);
  const forkMenuRef = useRef<HTMLDivElement | null>(null);
  const manageMenuRef = useRef<HTMLDivElement | null>(null);

  return (
    <>
      {mode !== "tracked_unforked" && (
        <>
          <Button size="sm" className="h-8" disabled={!canPlay || busy} onClick={onPlay}>
            <Play className="h-4 w-4" />
            Play
          </Button>
          {onResume && (
            <Button variant="outline" size="sm" className="h-8" disabled={busy} onClick={onResume}>
              <Clock3 className="h-4 w-4" />
              Resume
            </Button>
          )}
        </>
      )}
      {mode === "remote_source" && onTrack && (
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={busy || trackDisabled}
          onClick={onTrack}
          title={trackDisabled ? "Already tracked" : "Track remote work"}
        >
          <GitBranchPlus className="h-4 w-4" />
          Track
        </Button>
      )}
      {(mode === "tracked_forked" || mode === "remote_source") && onFork && (
        <div className="relative" ref={forkMenuRef}>
          <Button
            variant="outline"
            size="sm"
            className="relative h-8 pr-7"
            disabled={busy || forkSources.length === 0}
            onClick={() => setForkMenuOpen((open) => !open)}
            title={mode === "tracked_forked" ? "Switch fork source" : "Fork remote source"}
          >
            <GitBranchPlus className="h-4 w-4" />
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
      {(onManage || onRefreshLocalFiles) && (
        <div className="relative" ref={manageMenuRef}>
          <Button variant="outline" size="sm" className="relative h-8 pr-7" disabled={busy} onClick={() => setManageMenuOpen((open) => !open)}>
            <MoreHorizontal className="h-4 w-4" />
            Manage
            <ChevronDown className="absolute right-2 h-3 w-3" />
          </Button>
          <AnchoredPopover open={manageMenuOpen} anchorRef={manageMenuRef} onOpenChange={setManageMenuOpen} className="w-48 p-1 text-sm" bottomCollisionPadding={96} zIndex={70}>
            {onManage && (
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  setManageMenuOpen(false);
                  onManage();
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
                  setManageMenuOpen(false);
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
