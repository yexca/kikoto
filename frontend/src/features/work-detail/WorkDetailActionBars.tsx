import {
  BookmarkPlus,
  Captions,
  Check,
  CircleSlash,
  Cloud,
  Database,
  ExternalLink,
  FolderCog,
  FolderX,
  GitFork,
  HardDrive,
  HardDriveDownload,
  Languages,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  Unlink,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { WorkCardListButton, WorkCardQuickMarkButton } from "@/components/work-card/WorkCardShell";
import { WorkRatingControl } from "@/components/work-card/WorkRatingControl";
import { Button } from "@/components/ui/button";
import type { HeroPlayback, HeroPlaybackUnavailableReason } from "@/features/work-detail/heroPlaybackModel";
import type { RemoteSourceAvailability } from "@/features/work-detail/source/sourceContextModel";
import type { FavoriteList, ListeningStatus } from "@/lib/api";
import { useTranslation } from "react-i18next";

export type DetailActionMode = "local" | "tracked_unforked" | "tracked_forked" | "remote_source";

const unavailableIcons: Record<HeroPlaybackUnavailableReason, typeof CircleSlash> = {
  no_source: FolderX,
  offline: HardDrive,
  unavailable: Cloud,
  no_media: CircleSlash,
};

const unavailableLabels: Record<HeroPlaybackUnavailableReason, string> = {
  no_source: "detailActions.noPlayableNoSource",
  offline: "detailActions.noPlayableOffline",
  unavailable: "detailActions.noPlayableUnavailable",
  no_media: "detailActions.noPlayableMedia",
};

/**
 * The Hero's one primary action: Resume when the work has saved playback,
 * otherwise Play for the folder the Directory opens on. When nothing can
 * play, its place says why instead of showing a disabled button.
 */
export function HeroPrimaryAction({
  playback,
  busy,
  onResume,
  onPlay,
}: {
  playback: HeroPlayback;
  busy: boolean;
  /** Absent where a work has no saved playback, such as a work outside the Library. */
  onResume?: () => void;
  onPlay: (playback: Extract<HeroPlayback, { kind: "play" }>) => void;
}) {
  const { t } = useTranslation();
  if (playback.kind === "unavailable") {
    const Icon = unavailableIcons[playback.reason];
    return (
      <p
        className="inline-flex min-h-[var(--control-height)] items-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t(unavailableLabels[playback.reason])}
      </p>
    );
  }
  const resume = playback.kind === "resume";
  const label = resume ? t("detailActions.resume") : t("detailActions.play");
  const pending = busy || playback.kind === "loading";
  // The name tells this Play from the player's own while keeping the visible word.
  const name = resume ? t("detailActions.resumeSavedPlayback") : t("detailActions.playWork");
  return (
    <Button
      className="min-w-[6.5rem] gap-2 px-4"
      disabled={pending}
      aria-busy={pending || undefined}
      aria-label={name}
      title={name}
      onClick={() => {
        if (playback.kind === "resume") onResume?.();
        else if (playback.kind === "play") onPlay(playback);
      }}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : resume ? (
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Play className="h-4 w-4 fill-current" aria-hidden="true" />
      )}
      {label}
    </Button>
  );
}

/** Mark, your rating, and List: quiet controls beside the primary action. */
export function WorkIdentityActionBar({
  busy,
  listeningStatus,
  favorite,
  memberLists,
  listWorkId,
  onEnsureListWork,
  onListSaved,
  onMark,
  canMark,
  userRating,
  onRate,
}: {
  busy: boolean;
  listeningStatus: ListeningStatus;
  favorite: boolean;
  /** The lists holding the work, the most recent addition first, once loaded. */
  memberLists?: readonly FavoriteList[];
  listWorkId: number | null;
  onEnsureListWork?: () => Promise<number | null>;
  onListSaved?: (favorite: boolean, workID: number) => void;
  onMark: (status: ListeningStatus) => void;
  /** Checked before the mark menu opens. */
  canMark?: () => boolean;
  /** The viewer's rating; the rating control shows only with onRate. */
  userRating?: number | null;
  onRate?: (rating: number | null) => void;
}) {
  return (
    <>
      <WorkCardQuickMarkButton value={listeningStatus} disabled={busy} canOpen={canMark} onChange={onMark} />
      {onRate && (
        <WorkRatingControl value={userRating ?? null} disabled={busy} variant="card" showLabel onChange={onRate} />
      )}
      {/* A work in a list names the newest one beside the icon, with a count of
          the others, so where it is saved shows at a glance. The button stays
          as quiet as Mark and the rating either way. */}
      <WorkCardListButton
        workId={listWorkId}
        active={favorite}
        memberLists={memberLists}
        disabled={busy}
        showLabel
        ensureWorkId={onEnsureListWork}
        onSaved={onListSaved}
      />
    </>
  );
}

/** Opens the metadata editor from the Hero actions, quiet like the personal actions beside it. */
export function EditMetadataButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="outline"
      size="sm"
      // The label shows from tablet width.
      className="h-8 w-8 border-transparent bg-transparent px-0 text-muted-foreground hover:text-foreground sm:w-auto sm:gap-1.5 sm:px-2 sm:text-xs"
      title={t("detailActions.editMetadata")}
      aria-label={t("detailActions.editMetadata")}
      disabled={disabled}
      onClick={onClick}
    >
      <Database className="h-4 w-4" aria-hidden="true" />
      <span className="hidden sm:inline">{t("detailActions.metadata")}</span>
    </Button>
  );
}

/**
 * The selected source's actions, listed in Source info, then the work's local
 * files entries while a local source is selected. Each action is present only
 * for a viewer allowed to use it; with none, the list renders nothing.
 */
export function MediaContextActionBar({
  busy,
  mode,
  contextKey,
  onTrack,
  trackDisabled,
  trackDisabledReason,
  onUntrack,
  canUntrack,
  untrackDisabled = false,
  forkSources = [],
  currentForkSource,
  onFork,
  onFetch,
  remoteSourceWorkUrl,
  remoteSourceName,
  sourceLabel,
  sourceDetailsLoading = false,
  onManageCache,
  manageCacheDisabled = false,
  onManageFiles,
  onManageLyrics,
  onEditFileNames,
  onTranslateWithAI,
}: {
  busy: boolean;
  mode: DetailActionMode;
  contextKey: string;
  onTrack?: () => void;
  trackDisabled?: boolean;
  trackDisabledReason?: string;
  onUntrack?: () => void;
  /** Checked at the first untrack click, before asking for confirmation. */
  canUntrack?: () => boolean;
  untrackDisabled?: boolean;
  forkSources?: RemoteSourceAvailability[];
  currentForkSource?: RemoteSourceAvailability | null;
  onFork?: (remote: RemoteSourceAvailability) => void;
  onFetch?: () => void;
  remoteSourceWorkUrl?: string;
  remoteSourceName?: string;
  sourceLabel?: string;
  sourceDetailsLoading?: boolean;
  onManageCache?: () => void;
  manageCacheDisabled?: boolean;
  onManageFiles?: () => void;
  onManageLyrics?: () => void;
  /** Opens the editor of the names the directory shows for local files. */
  onEditFileNames?: () => void;
  /** Opens Translate with AI for the work's text, display names and lyrics. */
  onTranslateWithAI?: () => void;
}) {
  const { t } = useTranslation();
  const [untrackConfirming, setUntrackConfirming] = useState(false);
  const hasForkOptions = (mode === "tracked_unforked" || mode === "tracked_forked") && Boolean(onFork);
  const workEntries: [string, ReactNode, (() => void) | undefined][] = [
    [t("detailActions.manageFiles"), <FolderCog className="h-4 w-4" />, onManageFiles],
    [t("detailActions.manageLyrics"), <Captions className="h-4 w-4" />, onManageLyrics],
    [t("detailActions.editFileNames"), <Languages className="h-4 w-4" />, onEditFileNames],
    [t("detailActions.translateWithAI"), <Sparkles className="h-4 w-4" />, onTranslateWithAI],
  ];
  const hasWorkEntries = workEntries.some(([, , onClick]) => onClick);
  const hasOptions = Boolean(
    onTrack ||
    onUntrack ||
    hasForkOptions ||
    onFetch ||
    remoteSourceWorkUrl ||
    onManageCache ||
    hasWorkEntries ||
    sourceDetailsLoading,
  );
  const displaySourceLabel = sourceLabel || remoteSourceName || t("detailActions.source");

  useEffect(() => setUntrackConfirming(false), [contextKey]);
  useEffect(() => {
    if (busy) setUntrackConfirming(false);
  }, [busy]);

  if (!hasOptions) return null;
  return (
    <div
      role="group"
      aria-label={t("detailActions.sourceActionsFor", { source: displaySourceLabel })}
      className="space-y-0.5 text-sm"
    >
      {sourceDetailsLoading && (
        <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("detailActions.loadingSourceDetails")}
        </div>
      )}
      {mode === "remote_source" && onTrack && (
        <SourceOptionButton
          icon={<BookmarkPlus className="h-4 w-4" />}
          label={t("detailActions.track")}
          detail={trackDisabled ? trackDisabledReason || t("detailActions.alreadyTracked") : undefined}
          disabled={busy || trackDisabled}
          onClick={onTrack}
        />
      )}
      {hasForkOptions && (
        <div className="border-t px-1 pt-1 first:border-t-0">
          <div className="px-1 py-1 text-2xs font-medium uppercase text-muted-foreground">
            {mode === "tracked_forked" ? t("detailActions.switchFork") : t("detailActions.forkFrom")}
          </div>
          {forkSources.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">{t("detailActions.noForkSourceAvailable")}</div>
          ) : (
            forkSources.map((remote) => {
              const active = currentForkSource?.source.id === remote.source.id;
              return (
                <SourceOptionButton
                  key={remote.source.id}
                  icon={<GitFork className="h-4 w-4" />}
                  label={remote.source.displayName}
                  trailing={active ? <Check className="h-3.5 w-3.5 text-primary" /> : undefined}
                  disabled={busy || active}
                  onClick={() => onFork!(remote)}
                />
              );
            })
          )}
        </div>
      )}
      {onUntrack && (
        <>
          <div className="my-1 border-t first:hidden" />
          <SourceOptionButton
            icon={<Unlink className="h-4 w-4" />}
            label={untrackConfirming ? t("detailActions.confirmUntrack") : t("detailActions.untrack")}
            detail={untrackConfirming ? t("detailActions.clickAgainToConfirm") : t("detailActions.stopTrackingSource")}
            tone="danger"
            disabled={busy || untrackDisabled}
            onClick={() => {
              if (!untrackConfirming) {
                if (canUntrack && !canUntrack()) return;
                setUntrackConfirming(true);
                return;
              }
              setUntrackConfirming(false);
              onUntrack();
            }}
          />
        </>
      )}
      {onFetch && (
        <SourceOptionButton
          icon={<HardDriveDownload className="h-4 w-4" />}
          label={t("detailActions.fetch")}
          disabled={busy}
          onClick={onFetch}
        />
      )}
      {remoteSourceWorkUrl && (
        <a
          className={sourceOptionClassName("default")}
          href={remoteSourceWorkUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={t("detailActions.openOriginOn", { source: remoteSourceName || t("detailActions.source") })}
        >
          <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{t("detailActions.openOrigin")}</span>
        </a>
      )}
      {onManageCache && (
        <>
          <div className="my-1 border-t first:hidden" />
          <SourceOptionButton
            icon={<HardDrive className="h-4 w-4" />}
            label={t("detailActions.manageCache")}
            detail={manageCacheDisabled ? t("detailActions.noCachedFiles") : undefined}
            disabled={busy || manageCacheDisabled}
            onClick={onManageCache}
          />
        </>
      )}
      {hasWorkEntries && <div className="my-1 border-t first:hidden" />}
      {workEntries.map(([label, icon, onClick]) =>
        onClick ? <SourceOptionButton key={label} icon={icon} label={label} disabled={busy} onClick={onClick} /> : null,
      )}
    </div>
  );
}

function sourceOptionClassName(tone: "default" | "danger") {
  const toneClassName =
    tone === "danger" ? "text-destructive hover:bg-destructive/10 focus:bg-destructive/10" : "hover:bg-muted";
  return `flex min-h-11 w-full items-center sm:min-h-9 gap-2.5 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 ${toneClassName}`;
}

function SourceOptionButton({
  icon,
  label,
  detail,
  trailing,
  disabled = false,
  tone = "default",
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  trailing?: ReactNode;
  disabled?: boolean;
  tone?: "default" | "danger";
  onClick: () => void;
}) {
  return (
    <button type="button" className={sourceOptionClassName(tone)} disabled={disabled} onClick={onClick}>
      <span className={`shrink-0 ${tone === "danger" ? "" : "text-muted-foreground"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {detail && <span className="block truncate text-2xs text-muted-foreground">{detail}</span>}
      </span>
      {trailing}
    </button>
  );
}
