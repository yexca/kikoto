import { CopyCheck, Loader2, Lock, LocateFixed, Search, ShieldCheck, Timer, Trash2, Undo2 } from "lucide-react";
import { useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { baseName } from "@/features/work-detail/folder-edit/folderEditLayout";
import { CURRENT_FOLDER_RESOURCE } from "@/features/work-detail/folder-edit/folderEditModel";
import {
  useFolderWorkspaceNavigation,
  type FolderWorkspaceRevealTarget,
} from "@/features/work-detail/folder-edit/folderWorkspace";
import { placeIcon, placeTone } from "@/features/work-detail/folder-edit/FolderWorkspaceTools";
import type {
  IdenticalCopy,
  IdenticalSet,
  IdenticalSetState,
} from "@/features/work-detail/folder-edit/identicalFilesModel";
import type { DuplicateFileCheck } from "@/features/work-detail/folder-edit/useDuplicateFileCheck";
import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";
import { cn } from "@/lib/tailwindClassNames";

/** Where a copy is, in words: This folder and its path there, or the edition and folder that hold it. */
function copyLocation(copy: IdenticalCopy, t: (key: string) => string) {
  return copy.place === "target"
    ? `${t("folderEdit.currentFolder")} · ${copy.path}`
    : `${copy.workCode} · ${baseName(copy.folder)}/${copy.path}`;
}

function revealTarget(copy: IdenticalCopy): FolderWorkspaceRevealTarget | null {
  if (copy.place === "target") return { resourceId: CURRENT_FOLDER_RESOURCE, path: copy.path };
  return copy.resourceId ? { resourceId: copy.resourceId, path: copy.path } : null;
}

/**
 * Starts the identical-file check from This folder's head. The first check
 * first says what it does: it compares by content, takes a while for large
 * files and can be stopped, and only marks files.
 */
export function FindIdenticalButton({
  check,
  disabled,
  onStart,
}: {
  check: DuplicateFileCheck;
  disabled: boolean;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const running = check.status === "running";
  const again = check.status === "done";
  return (
    <>
      <Button
        ref={anchor}
        variant="outline"
        size="sm"
        className="shrink-0 gap-1.5"
        disabled={disabled || running}
        aria-haspopup={again ? undefined : "dialog"}
        aria-expanded={again ? undefined : open}
        onClick={() => (again ? onStart() : setOpen((value) => !value))}
      >
        {running ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <CopyCheck className="h-4 w-4" aria-hidden="true" />
        )}
        {again ? t("fileWorkspace.identical.findAgain") : t("fileWorkspace.identical.find")}
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchor}
        onOpenChange={setOpen}
        ariaLabel={t("fileWorkspace.identical.find")}
        className="w-[min(22rem,calc(100vw-1.5rem))] p-3"
        zIndex={70}
      >
        <h3 className="text-sm font-semibold">{t("fileWorkspace.identical.find")}</h3>
        <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
          {[
            { icon: Search, key: "fileWorkspace.identical.intro.compare" },
            { icon: Timer, key: "fileWorkspace.identical.intro.time" },
            { icon: ShieldCheck, key: "fileWorkspace.identical.intro.marks" },
          ].map(({ icon: Icon, key }) => (
            <li key={key} className="flex gap-2">
              <Icon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            {t("content.cancel")}
          </Button>
          <Button
            size="sm"
            autoFocus
            onClick={() => {
              setOpen(false);
              onStart();
            }}
          >
            {t("fileWorkspace.identical.intro.start")}
          </Button>
        </div>
      </AnchoredPopover>
    </>
  );
}

/**
 * The check's progress, or one line on what it found: how many files of This
 * folder have an identical copy and how much the suggested deletions free,
 * with the way to the review and to showing only those files.
 */
export function IdenticalFilesStatus({
  check,
  count,
  frees,
  queued,
  only,
  disabled,
  onOnly,
  onStop,
  onRetry,
}: {
  check: DuplicateFileCheck;
  count: number;
  frees: number;
  /** How many of the files the edit deletes already. */
  queued: number;
  only: boolean;
  disabled: boolean;
  onOnly: (only: boolean) => void;
  onStop: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const navigation = useFolderWorkspaceNavigation();
  if (check.status === "idle") return null;
  if (check.status === "running") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="tabular-nums text-muted-foreground" role="status">
          {t("fileWorkspace.identical.checking", { checked: check.checkedFiles, pending: check.pendingFiles })}
        </span>
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onStop}>
          {t("fileWorkspace.identical.stop")}
        </Button>
      </div>
    );
  }
  if (check.status === "error") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs" role="alert">
        <span className="text-muted-foreground">{t("fileWorkspace.identical.failed")}</span>
        <Button variant="outline" size="sm" className="h-7 px-2" onClick={onRetry}>
          {t("folderEdit.retry")}
        </Button>
      </div>
    );
  }
  if (count === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <CopyCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t("fileWorkspace.identical.none")}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs">
      <p className="flex min-w-0 flex-1 basis-56 items-start gap-2" role="status">
        <CopyCheck className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-medium">{t("fileWorkspace.identical.found", { count })}</span>
          {frees > 0 && (
            <span className="text-muted-foreground">
              {" · "}
              {t("fileWorkspace.identical.frees", { size: formatBytes(frees) })}
            </span>
          )}
          {queued > 0 && (
            <span className="text-muted-foreground">
              {" · "}
              {t("fileWorkspace.identical.queued", { count: queued })}
            </span>
          )}
        </span>
      </p>
      <span className="flex shrink-0 flex-wrap items-center gap-1.5">
        {navigation.showIdenticalReview && (
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={navigation.showIdenticalReview}>
            {t("fileWorkspace.identical.review")}
          </Button>
        )}
        <Button
          variant="toolbar"
          size="sm"
          className={cn("h-7 px-2", only && "border-primary/40 bg-primary/[0.07] text-foreground")}
          aria-pressed={only}
          disabled={disabled}
          onClick={() => onOnly(!only)}
        >
          {t("fileWorkspace.identical.only")}
        </Button>
      </span>
    </div>
  );
}

/**
 * Marks a file of This folder that has an identical copy, in the color and
 * with the icon of the place the other copy is in, and with how many copies
 * there are. Where the workspace can show the other copy, the mark does.
 */
export function IdenticalBadge({
  set,
  path,
  deleting = false,
}: {
  set: IdenticalSet;
  path: string;
  deleting?: boolean;
}) {
  const { t } = useTranslation();
  const navigation = useFolderWorkspaceNavigation();
  const place = set.kind === "elsewhere" ? "local" : "target";
  const Icon = placeIcon(place);
  const other = set.kind === "elsewhere" ? set.outside[0] : set.inside.find((copy) => copy.path !== path);
  const target = other ? revealTarget(other) : null;
  const where = other ? copyLocation(other, t) : "";
  const word = t(`fileWorkspace.identical.badge.${set.kind}`);
  const copies = `×${set.inside.length + set.outside.length}`;
  const label = `${word} ${copies}`;
  const className = cn(
    "inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-full border px-1.5 text-2xs font-medium tabular-nums",
    placeTone[place].surface,
    placeTone[place].border,
    placeTone[place].text,
  );
  // A phone row keeps its room for the file's name: the icon and the count stay, the words go to the label.
  const content = (
    <>
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="hidden truncate sm:inline">{word}</span>
      <span aria-hidden="true">{copies}</span>
    </>
  );
  const reveal = navigation.reveal;
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {reveal && target ? (
        <button
          type="button"
          className={cn(
            className,
            "touch-target hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
          title={t("fileWorkspace.identical.showOther", { where })}
          aria-label={`${label}. ${t("fileWorkspace.identical.showOther", { where })}`}
          onClick={(event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            reveal(target);
          }}
        >
          {content}
        </button>
      ) : (
        <span className={className} title={`${label}. ${t("fileWorkspace.identical.copyAt", { where })}`}>
          {content}
          <span className="sr-only">{`${label}. ${t("fileWorkspace.identical.copyAt", { where })}`}</span>
        </span>
      )}
      {deleting && (
        <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-error-border bg-error-surface px-1.5 text-2xs font-medium text-error-foreground">
          <Trash2 className="h-3 w-3" aria-hidden="true" />
          <span className="hidden sm:inline">{t("fileWorkspace.identical.deleting")}</span>
          <span className="sr-only sm:hidden">{t("fileWorkspace.identical.deleting")}</span>
        </span>
      )}
    </span>
  );
}

/** Says on a folder's row how many of the files it holds have an identical copy. */
export function IdenticalFolderCount({ count }: { count: number }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border bg-background px-1.5 text-2xs font-medium text-foreground"
      title={t("fileWorkspace.identical.folderCountLabel", { count })}
    >
      <CopyCheck className="h-3 w-3" aria-hidden="true" />
      <span aria-hidden="true">{t("fileWorkspace.identical.folderCount", { count })}</span>
      <span className="sr-only">{t("fileWorkspace.identical.folderCountLabel", { count })}</span>
    </span>
  );
}

export type IdenticalReviewSet = { set: IdenticalSet; state: IdenticalSetState };

/**
 * Every set of identical files with each copy and where it is. A set with a
 * copy in another folder deletes its copies here and leaves the other folder
 * as it is; a set repeated in This folder keeps the copy chosen for it.
 */
export function IdenticalReview({
  sets,
  frees,
  disabled,
  onChoose,
  onApply,
  onKeep,
  onApplyAll,
  onKeepAll,
}: {
  sets: readonly IdenticalReviewSet[];
  frees: number;
  disabled: boolean;
  onChoose: (set: IdenticalSet, path: string) => void;
  onApply: (set: IdenticalSet, keep: string | null) => void;
  onKeep: (set: IdenticalSet) => void;
  onApplyAll: () => void;
  onKeepAll: () => void;
}) {
  const { t } = useTranslation();
  const allApplied = sets.every(({ state }) => state.status === "applied");
  const anyDeleted = sets.some(({ state }) => state.deleting.length > 0);
  const groups = (["elsewhere", "repeated"] as const)
    .map((kind) => ({ kind, items: sets.filter(({ set }) => set.kind === kind) }))
    .filter((group) => group.items.length > 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b px-3 py-2.5 lg:px-4">
        <p className="text-xs">
          <span className="font-medium">{t("fileWorkspace.identical.sets", { count: sets.length })}</span>
          {frees > 0 && (
            <span className="text-muted-foreground">
              {" · "}
              {t("fileWorkspace.identical.frees", { size: formatBytes(frees) })}
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">{t("fileWorkspace.identical.rule")}</p>
        <div className="flex flex-wrap items-center gap-2">
          {allApplied ? (
            <span className="text-xs text-muted-foreground" role="status">
              {t("fileWorkspace.identical.allQueued")}
            </span>
          ) : (
            <Button size="sm" disabled={disabled} onClick={onApplyAll}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t("fileWorkspace.identical.addAll")}
            </Button>
          )}
          {anyDeleted && (
            <Button variant="ghost" size="sm" disabled={disabled} onClick={onKeepAll}>
              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t("fileWorkspace.identical.keepAll")}
            </Button>
          )}
        </div>
      </div>
      <div className="app-scroll min-h-0 flex-1 space-y-5 overflow-auto overscroll-contain px-3 py-3 lg:px-4">
        {groups.map(({ kind, items }) => (
          <section key={kind} aria-label={t(`fileWorkspace.identical.${kind}.title`)} className="space-y-2">
            <div>
              <h3 className="text-sm font-medium">{t(`fileWorkspace.identical.${kind}.title`)}</h3>
              <p className="text-xs text-muted-foreground">{t(`fileWorkspace.identical.${kind}.hint`)}</p>
            </div>
            <ul className="space-y-2">
              {items.map(({ set, state }) => (
                <IdenticalSetCard
                  key={set.key}
                  set={set}
                  state={state}
                  disabled={disabled}
                  onChoose={(path) => onChoose(set, path)}
                  onApply={() => onApply(set, state.keep)}
                  onKeep={() => onKeep(set)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function IdenticalSetCard({
  set,
  state,
  disabled,
  onChoose,
  onApply,
  onKeep,
}: {
  set: IdenticalSet;
  state: IdenticalSetState;
  disabled: boolean;
  onChoose: (path: string) => void;
  onApply: () => void;
  onKeep: () => void;
}) {
  const { t } = useTranslation();
  const name = (set.inside.find((copy) => copy.path === state.keep) ?? set.inside[0]).name;
  const copies = set.inside.length + set.outside.length;
  return (
    <li className="overflow-hidden rounded-lg border bg-background">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2">
        <div className="min-w-0 flex-1 basis-40">
          <div className="truncate text-sm font-medium" title={name}>
            {name}
          </div>
          <div className="text-2xs tabular-nums text-muted-foreground">
            {t("fileWorkspace.identical.setSummary", { count: copies, size: formatBytes(set.sizeBytes) })}
          </div>
        </div>
        {state.status === "applied" ? (
          <span className="flex shrink-0 items-center gap-1">
            <span className="rounded-full bg-error-surface px-1.5 py-px text-2xs font-medium tabular-nums text-error-foreground">
              {t("fileWorkspace.identical.queued", { count: state.deleting.length })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2"
              disabled={disabled}
              aria-label={t("fileWorkspace.identical.keepSet", { name })}
              onClick={onKeep}
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t("fileWorkspace.pending.keep")}
            </Button>
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2"
            disabled={disabled}
            aria-label={`${t("fileWorkspace.identical.add", { count: state.planned.length })}: ${name}`}
            onClick={onApply}
          >
            {t("fileWorkspace.identical.add", { count: state.planned.length })}
          </Button>
        )}
      </div>
      <ul
        className="divide-y"
        role={set.kind === "repeated" ? "radiogroup" : undefined}
        aria-label={set.kind === "repeated" ? t("fileWorkspace.identical.chooseKeep", { name }) : undefined}
      >
        {set.inside.map((copy) => (
          <CopyRow
            key={copy.path}
            copy={copy}
            groupName={set.key}
            choosable={set.kind === "repeated"}
            chosen={copy.path === state.keep}
            suggested={copy.path === set.suggestedKeep}
            deleting={state.deleting.includes(copy.path)}
            disabled={disabled}
            onChoose={() => onChoose(copy.path)}
          />
        ))}
        {set.outside.map((copy) => (
          <CopyRow key={`${copy.folder}/${copy.path}`} copy={copy} groupName={set.key} disabled={disabled} />
        ))}
      </ul>
      {state.lost && (
        <p className="flex gap-2 border-t border-error-border bg-error-surface px-3 py-2 text-xs text-error-foreground">
          <Trash2 className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("fileWorkspace.identical.lost")}
        </p>
      )}
    </li>
  );
}

function CopyRow({
  copy,
  groupName,
  choosable = false,
  chosen = false,
  suggested = false,
  deleting = false,
  disabled,
  onChoose,
}: {
  copy: IdenticalCopy;
  groupName: string;
  choosable?: boolean;
  chosen?: boolean;
  suggested?: boolean;
  deleting?: boolean;
  disabled: boolean;
  onChoose?: () => void;
}) {
  const { t } = useTranslation();
  const navigation = useFolderWorkspaceNavigation();
  const place = copy.place;
  const Icon = placeIcon(place);
  const target = revealTarget(copy);
  const reveal = navigation.reveal;
  const where = place === "target" ? t("folderEdit.currentFolder") : `${copy.workCode} · ${baseName(copy.folder)}`;
  const body = (
    <>
      <Icon className={cn("h-4 w-4 shrink-0", placeTone[place].text)} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-2xs font-medium", placeTone[place].text)}>{where}</span>
        <span
          className={cn("block truncate font-mono text-xs", deleting && "text-muted-foreground line-through")}
          title={copy.path}
        >
          {copy.path}
        </span>
      </span>
      {suggested && (
        <span className="shrink-0 text-2xs text-muted-foreground">{t("fileWorkspace.identical.suggested")}</span>
      )}
      {place === "target" ? (
        deleting ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-error-border bg-error-surface px-1.5 py-px text-2xs font-medium text-error-foreground">
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            {t("fileWorkspace.identical.deleting")}
          </span>
        ) : (
          <span className="shrink-0 rounded-full border px-1.5 py-px text-2xs font-medium text-muted-foreground">
            {t("fileWorkspace.identical.kept")}
          </span>
        )
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
          <Lock className="h-3 w-3" aria-hidden="true" />
          {t("fileWorkspace.identical.reference")}
        </span>
      )}
    </>
  );
  const showButton = reveal && target && (
    <button
      type="button"
      className="touch-target grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t("fileWorkspace.identical.show", { path: copy.path })}
      title={t("fileWorkspace.identical.show", { path: copy.path })}
      onClick={() => reveal(target)}
    >
      <LocateFixed className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
  if (choosable) {
    return (
      <li className="flex items-center gap-1 pr-2">
        <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-1.5 pl-3">
          <input
            type="radio"
            name={groupName}
            className="h-4 w-4 shrink-0 accent-primary"
            checked={chosen}
            disabled={disabled}
            aria-label={t("fileWorkspace.identical.keepThis", { path: copy.path })}
            onChange={() => onChoose?.()}
          />
          {body}
        </label>
        {showButton}
      </li>
    );
  }
  return (
    <li className={cn("flex min-h-11 items-center gap-2.5 py-1.5 pl-3 pr-2", place !== "target" && "bg-muted/30")}>
      {body}
      {showButton}
    </li>
  );
}
