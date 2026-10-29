import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  Lock,
  Pencil,
  Trash2,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  baseName,
  folderContains,
  folderHasContent,
  holdsLyricsFolder,
  inLyricsFolder,
  parentFolder,
  type FolderEditNameError,
} from "@/features/work-detail/folder-edit/folderEditLayout";
import {
  buildFolderEditTree,
  currentFileKey,
  folderEditEntryMovable,
  folderEditTreeFiles,
  type FolderEditResource,
  type FolderEditResultEntry,
  type FolderEditTreeNode,
} from "@/features/work-detail/folder-edit/folderEditModel";
import {
  ResultRow,
  revealedRowClass,
  sortedFolders,
  useFolderOpen,
  useRevealedRow,
  type FolderEditExpand,
} from "@/features/work-detail/folder-edit/FolderEditPanes";
import type { FolderWorkspaceArrange } from "@/features/work-detail/folder-edit/folderWorkspace";
import type { RemoteFetchFileDecision } from "@/lib/api";
import { naturalNameCompare } from "@/lib/naturalNameOrder";
import { cn } from "@/lib/tailwindClassNames";

/** What is being dragged into or within the final folder. */
export type FolderEditDrag =
  | { kind: "entry"; key: string }
  | { kind: "folder"; path: string }
  | { kind: "source"; resource: FolderEditResource; paths: readonly string[]; base: string };

const dragType = "application/x-kikoto-folder-edit";
// A drag stays inside one page, so the dragged item is kept here rather than
// serialized: drop targets need it during dragover, when browsers hide data.
// The element a drag starts from always receives its dragend, wherever the
// drag ends or is cancelled, so it clears the item.
let activeDrag: FolderEditDrag | null = null;

export function startFolderEditDrag(event: DragEvent, drag: FolderEditDrag, label: string) {
  activeDrag = drag;
  event.currentTarget.addEventListener(
    "dragend",
    () => {
      if (activeDrag === drag) activeDrag = null;
    },
    { once: true },
  );
  event.dataTransfer.effectAllowed = drag.kind === "source" ? "copy" : "move";
  event.dataTransfer.setData(dragType, "1");
  event.dataTransfer.setData("text/plain", label);
}

function endFolderEditDrag() {
  activeDrag = null;
}

/** The Kikoto drag in progress over this event, never an outside file or text. */
function eventDrag(event: DragEvent) {
  return event.dataTransfer.types.includes(dragType) ? activeDrag : null;
}

function canDropInto(drag: FolderEditDrag | null, folder: string) {
  if (!drag || inLyricsFolder(folder)) return false;
  // Managed lyrics arrive through lyrics roles, never by dropping their folder.
  if (drag.kind === "source") return !holdsLyricsFolder(drag.paths);
  return drag.kind !== "folder" || !folderContains(drag.path, folder);
}

/** What a drop does: files of another place are copied or downloaded, and the folder's own move. */
export type FolderEditDropAction = "copy" | "download" | "move";

/** A finished drop: what it did, with how many files, into which folder. */
export type FolderEditDrop = { action: FolderEditDropAction; count: number; folder: string };

function dropAction(drag: FolderEditDrag): FolderEditDropAction {
  if (drag.kind !== "source") return "move";
  return drag.resource.kind === "remote" ? "download" : "copy";
}

function dropInto(
  arrange: FolderWorkspaceArrange,
  folder: string,
  drag: FolderEditDrag | null,
  onDropped?: (drop: FolderEditDrop) => void,
) {
  activeDrag = null;
  if (!canDropInto(drag, folder) || !drag) return;
  if (drag.kind === "entry") arrange.moveEntries([drag.key], folder);
  else if (drag.kind === "folder") arrange.moveFolder(drag.path, folder);
  else arrange.placeFromResource(drag.resource, drag.paths, drag.base, folder);
  onDropped?.({ action: dropAction(drag), count: drag.kind === "source" ? drag.paths.length : 1, folder });
}

/**
 * Handlers that make an element the drop target for a folder. The innermost
 * folder under the pointer takes the drag, and the tree highlights it.
 */
function dropTarget(
  context: Pick<TreeContext, "arrange" | "over" | "setOver" | "onDropped">,
  folder: string,
  disabled: boolean,
) {
  const { arrange, over, setOver, onDropped } = context;
  if (disabled) return { over: false, action: null, handlers: {} };
  return {
    over: over?.folder === folder,
    action: over?.folder === folder ? over.action : null,
    handlers: {
      onDragOver: (event: DragEvent) => {
        const drag = eventDrag(event);
        if (!drag || !canDropInto(drag, folder)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = drag.kind === "source" ? "copy" : "move";
        if (over?.folder !== folder) setOver({ folder, action: dropAction(drag) });
      },
      onDrop: (event: DragEvent) => {
        const drag = eventDrag(event);
        if (!drag) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(null);
        dropInto(arrange, folder, drag, onDropped);
      },
    },
  };
}

/** Names what releasing the drag here does, beside the folder it is over. */
function DropActionLabel({ action }: { action: FolderEditDropAction | null }) {
  const { t } = useTranslation();
  if (!action) return null;
  return (
    <span className="shrink-0 rounded-full bg-primary px-2 py-px text-2xs font-medium text-primary-foreground">
      {t(`fileWorkspace.dropAction.${action}`)}
    </span>
  );
}

function nameErrorKey(error: FolderEditNameError) {
  return `folderEdit.nameError.${error}`;
}

/** A name field for a new or renamed folder that confirms on Enter and cancels on Escape. */
function FolderNameField({
  initial,
  depth,
  label,
  check,
  onSubmit,
  onCancel,
}: {
  initial: string;
  depth: number;
  label: string;
  check: (name: string) => FolderEditNameError | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial);
  const [touched, setTouched] = useState(false);
  const error = check(name);
  const submit = () => {
    setTouched(true);
    if (!error) onSubmit(name.trim());
  };
  return (
    <div className="space-y-1 py-1 pr-2" style={{ paddingLeft: depth * 14 + 8 }}>
      <div className="flex items-center gap-2">
        <Folder className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <Input
          autoFocus
          fieldSize="sm"
          className="h-8 min-w-0 flex-1"
          aria-label={label}
          aria-invalid={touched && Boolean(error)}
          value={name}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
          onBlur={() => (error ? onCancel() : submit())}
        />
      </div>
      {touched && error && <div className="pl-6 text-2xs text-error-foreground">{t(nameErrorKey(error))}</div>}
    </div>
  );
}

/** A name for a new folder that nothing in parent uses yet. */
function freeFolderName(arrange: FolderWorkspaceArrange, parent: string, base: string) {
  if (!arrange.folderNameError(parent, base)) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base} (${index})`;
    if (!arrange.folderNameError(parent, candidate)) return candidate;
  }
}

export type RowMenuAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  destructive?: boolean;
  /** Chooses a folder of the final folder, which `onMove` receives, instead of running. */
  choosesFolder?: boolean;
  run: () => void;
};

/**
 * A row's actions: a list of commands, or the folders of the final folder an
 * item can go to. `note` explains, at the end of the list, what the row
 * cannot do.
 */
export function RowMenu({
  label,
  actions,
  moveTargets,
  chooserLabel,
  note,
  disabled,
  onMove,
  confirm,
}: {
  label: string;
  actions: RowMenuAction[];
  /** The folders the item can go to; the root is the empty path. */
  moveTargets: readonly string[];
  /** The heading of the folder list; Move to unless given. */
  chooserLabel?: string;
  note?: string;
  disabled: boolean;
  onMove: (folder: string) => void;
  /** Content that replaces the menu, such as a confirmation, while it is set. */
  confirm?: { content: (close: () => void) => ReactNode; active: boolean; onDismiss: () => void };
}) {
  const { t } = useTranslation();
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const close = () => {
    setOpen(false);
    setChoosing(false);
    confirm?.onDismiss();
  };
  const showing = open || Boolean(confirm?.active);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="touch-target grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={showing}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          if (showing) close();
          else setOpen(true);
        }}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <AnchoredPopover
        open={showing}
        anchorRef={anchor}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        className="app-scroll max-h-[min(22rem,70vh)] w-[min(16rem,calc(100vw-1.5rem))] overflow-y-auto p-1"
        zIndex={70}
      >
        {confirm?.active ? (
          confirm.content(close)
        ) : choosing ? (
          <div role="menu" aria-label={chooserLabel ?? t("folderEdit.moveTo")}>
            <div className="px-2 py-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {chooserLabel ?? t("folderEdit.moveTo")}
            </div>
            {moveTargets.map((folder) => (
              <button
                key={folder || "/"}
                type="button"
                role="menuitem"
                className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted md:min-h-8"
                style={{ paddingLeft: (folder ? folder.split("/").length : 0) * 12 + 8 }}
                onClick={() => {
                  close();
                  onMove(folder);
                }}
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{folder ? baseName(folder) : t("folderEdit.rootFolder")}</span>
              </button>
            ))}
          </div>
        ) : (
          <div role="menu" aria-label={label}>
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                className={cn(
                  "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted md:min-h-8",
                  action.destructive && "text-error-foreground",
                )}
                onClick={() => {
                  if (action.choosesFolder) {
                    setChoosing(true);
                    return;
                  }
                  setOpen(false);
                  action.run();
                }}
              >
                <action.icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {action.label}
              </button>
            ))}
            {note && (
              <p className="flex gap-2 border-t px-2 pb-1 pt-2 text-2xs text-muted-foreground">
                <Lock className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                {note}
              </p>
            )}
          </div>
        )}
      </AnchoredPopover>
    </>
  );
}

/**
 * The final folder as a tree that can be arranged like a file manager: files
 * and folders are dragged onto folders, files can be dragged in from the
 * middle column, and each row's menu moves it, or creates, renames, and
 * deletes folders, for touch and keyboard use. With `onDiscard`, a file's menu
 * also deletes a file of the folder or drops a file the edit would add.
 */
export function FolderEditArrangeTree({
  entries,
  arrange,
  decisions,
  disabled,
  onDecisionChange,
  creatingAtRoot,
  onCreatedAtRoot,
  onDiscard,
  onRestore,
  folderNote,
  entryMark,
  expand,
  reveal,
  onDropped,
  hint,
  changesOnly = false,
}: {
  entries: readonly FolderEditResultEntry[];
  arrange: FolderWorkspaceArrange;
  decisions: Readonly<Record<string, RemoteFetchFileDecision>>;
  disabled: boolean;
  onDecisionChange: (decision: RemoteFetchFileDecision) => void;
  /** Whether a new folder is being named at the top of the folder. */
  creatingAtRoot: boolean;
  onCreatedAtRoot: () => void;
  onDiscard?: (entry: FolderEditResultEntry) => void;
  /** Takes a file the edit deletes back out of the edit. */
  onRestore?: (entry: FolderEditResultEntry) => void;
  /**
   * Shown after a folder's name, such as for Kikoto's lyrics folder, with the
   * paths in the edited folder of the files it holds.
   */
  folderNote?: (path: string, files: readonly string[]) => ReactNode;
  /** Shown after a file's name, such as where it has an identical copy. */
  entryMark?: (entry: FolderEditResultEntry) => ReactNode;
  /** Opens the folders of marked entries, by entry key. */
  expand?: FolderEditExpand;
  /** An entry to bring into view, by its key. */
  reveal?: { key: string; seq: number } | null;
  onDropped?: (drop: FolderEditDrop) => void;
  /** Replaces the arrange hint below the tree. */
  hint?: string;
  /** Marks only the files the edit changes, where the files it deletes are listed apart. */
  changesOnly?: boolean;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildFolderEditTree(entries, arrange.folders), [arrange.folders, entries]);
  const placed = useMemo(
    () => entries.filter((entry) => entry.state !== "remove" && entry.state !== "excluded" && entry.state !== "moved"),
    [entries],
  );
  const allFolders = useMemo(() => {
    const folders: string[] = [];
    const visit = (node: FolderEditTreeNode<FolderEditResultEntry>) => {
      for (const child of sortedFolders(node)) {
        if (inLyricsFolder(child.path)) continue;
        folders.push(child.path);
        visit(child);
      }
    };
    visit(tree);
    return folders;
  }, [tree]);
  const [over, setOver] = useState<DropOver | null>(null);
  const context: TreeContext = {
    arrange,
    decisions,
    disabled,
    onDecisionChange,
    placed,
    allFolders,
    over,
    setOver,
    onDiscard,
    onRestore,
    folderNote,
    entryMark,
    expand,
    reveal,
    onDropped,
    changesOnly,
  };
  const root = dropTarget(context, "", disabled);
  return (
    <div
      {...root.handlers}
      className={cn(
        "relative min-h-full space-y-px rounded-md pb-6",
        root.over && "bg-primary/[0.06] ring-1 ring-primary/40",
      )}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
      }}
      onDragEnd={() => {
        endFolderEditDrag();
        setOver(null);
      }}
    >
      {creatingAtRoot && (
        <FolderNameField
          initial={freeFolderName(arrange, "", t("folderEdit.defaultFolderName"))}
          depth={0}
          label={t("folderEdit.newFolderName")}
          check={(name) => arrange.folderNameError("", name)}
          onSubmit={(name) => {
            arrange.addFolder("", name);
            onCreatedAtRoot();
          }}
          onCancel={onCreatedAtRoot}
        />
      )}
      {root.action && (
        <div className="sticky top-0 z-10 flex justify-end px-2 pb-1">
          <DropActionLabel action={root.action} />
        </div>
      )}
      <ArrangeNode node={tree} depth={0} context={context} isRoot />
      {entries.length === 0 && arrange.folders.length === 0 && !creatingAtRoot ? null : (
        <p className="px-2 pt-2 text-2xs text-muted-foreground">
          {hint ?? t("folderEdit.arrangeHint")}
          {!arrange.createsEmptyFolders && ` ${t("folderEdit.emptyFoldersNotCreated")}`}
        </p>
      )}
    </div>
  );
}

/** The folder a drag is over, the empty path for the top of the folder, and what a drop there does. */
type DropOver = { folder: string; action: FolderEditDropAction };

type TreeContext = {
  arrange: FolderWorkspaceArrange;
  decisions: Readonly<Record<string, RemoteFetchFileDecision>>;
  disabled: boolean;
  onDecisionChange: (decision: RemoteFetchFileDecision) => void;
  placed: readonly FolderEditResultEntry[];
  allFolders: readonly string[];
  over: DropOver | null;
  setOver: (over: DropOver | null) => void;
  onDiscard?: (entry: FolderEditResultEntry) => void;
  onRestore?: (entry: FolderEditResultEntry) => void;
  folderNote?: (path: string, files: readonly string[]) => ReactNode;
  entryMark?: (entry: FolderEditResultEntry) => ReactNode;
  expand?: FolderEditExpand;
  reveal?: { key: string; seq: number } | null;
  onDropped?: (drop: FolderEditDrop) => void;
  changesOnly: boolean;
};

function ArrangeNode({
  node,
  depth,
  context,
  isRoot = false,
}: {
  node: FolderEditTreeNode<FolderEditResultEntry>;
  depth: number;
  context: TreeContext;
  isRoot?: boolean;
}) {
  const { t } = useTranslation();
  const { arrange, disabled, expand, reveal } = context;
  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const locked = inLyricsFolder(node.path);
  const drop = dropTarget(context, node.path, disabled || locked || isRoot);
  const entries = [...node.files].sort((left, right) => naturalNameCompare(left.name, right.name));
  const inside = useMemo(() => folderEditTreeFiles(node), [node]);
  const count = inside.filter((entry) => entry.state !== "remove" && entry.state !== "excluded").length;
  const ownPaths = useMemo(() => {
    const prefix = currentFileKey("");
    return inside.filter((entry) => entry.key.startsWith(prefix)).map((entry) => entry.key.slice(prefix.length));
  }, [inside]);
  const [open, setOpen] = useFolderOpen(
    true,
    !isRoot && expand && inside.some((entry) => expand.has(entry.key)) ? expand.revision : null,
    !isRoot && reveal && inside.some((entry) => entry.key === reveal.key) ? reveal.seq : null,
  );
  const hasContent = !isRoot && folderHasContent(context.placed, arrange.folders, node.path);
  const deleteNow = () => {
    setConfirmingDelete(false);
    arrange.deleteFolder(node.path);
  };
  const children = (isRoot || open) && (
    <>
      {creating && (
        <FolderNameField
          initial={freeFolderName(arrange, node.path, t("folderEdit.defaultFolderName"))}
          depth={depth}
          label={t("folderEdit.newFolderName")}
          check={(name) => arrange.folderNameError(node.path, name)}
          onSubmit={(name) => {
            arrange.addFolder(node.path, name);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {sortedFolders(node).map((child) => (
        <ArrangeNode key={child.path} node={child} depth={depth + 1} context={context} />
      ))}
      {entries.map((entry) => (
        <ArrangeFile key={entry.key} entry={entry} depth={depth} context={context} />
      ))}
    </>
  );
  if (isRoot) return <div className="space-y-px">{children}</div>;
  if (renaming) {
    return (
      <div className="space-y-px">
        <FolderNameField
          initial={node.name}
          depth={depth - 1}
          label={t("folderEdit.renameFolder", { name: node.name })}
          check={(name) => arrange.folderNameError(parentFolder(node.path), name, node.path)}
          onSubmit={(name) => {
            setRenaming(false);
            arrange.renameFolder(node.path, name);
          }}
          onCancel={() => setRenaming(false)}
        />
        {children}
      </div>
    );
  }
  const draggable = !disabled && !locked;
  const actions: RowMenuAction[] = [
    {
      key: "new",
      label: t("folderEdit.newFolder"),
      icon: FolderPlus,
      run: () => {
        setOpen(true);
        setCreating(true);
      },
    },
    { key: "rename", label: t("folderEdit.rename"), icon: Pencil, run: () => setRenaming(true) },
    { key: "move", label: t("folderEdit.moveTo"), icon: FolderInput, choosesFolder: true, run: () => undefined },
    {
      key: "delete",
      label: t("folderEdit.deleteFolder"),
      icon: Trash2,
      destructive: true,
      run: () => (hasContent ? setConfirmingDelete(true) : deleteNow()),
    },
  ];
  return (
    <div className="space-y-px" {...drop.handlers}>
      <div
        className={cn(
          "group flex min-h-8 items-center gap-1.5 rounded-md pr-1 text-sm hover:bg-muted/70",
          drop.over && "bg-primary/10 ring-1 ring-primary/50",
          draggable && "cursor-grab",
        )}
        style={{ paddingLeft: (depth - 1) * 14 + 8 }}
        draggable={draggable}
        onDragStart={
          draggable
            ? (event) => {
                event.stopPropagation();
                startFolderEditDrag(event, { kind: "folder", path: node.path }, node.name);
              }
            : undefined
        }
      >
        <button
          type="button"
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <Folder
            className={cn("h-4 w-4 shrink-0", locked ? "text-muted-foreground" : "text-primary")}
            aria-hidden="true"
          />
          <span className="truncate font-medium">{node.name}</span>
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{count}</span>
        </button>
        <DropActionLabel action={drop.action} />
        {context.folderNote?.(node.path, ownPaths)}
        {!locked && (
          <RowMenu
            label={t("folderEdit.folderActions", { name: node.name })}
            actions={actions}
            moveTargets={["", ...context.allFolders].filter(
              (folder) => !folderContains(node.path, folder) && folder !== parentFolder(node.path),
            )}
            disabled={disabled}
            onMove={(folder) => arrange.moveFolder(node.path, folder)}
            confirm={{
              active: confirmingDelete,
              onDismiss: () => setConfirmingDelete(false),
              content: (close) => (
                <div
                  role="alertdialog"
                  aria-label={t("folderEdit.deleteFolderConfirm", { name: node.name })}
                  className="p-2"
                >
                  <h3 className="text-sm font-semibold">{t("folderEdit.deleteFolderConfirm", { name: node.name })}</h3>
                  <p className="mt-1.5 text-xs text-muted-foreground">{t("folderEdit.deleteFolderDescription")}</p>
                  <div className="mt-3 flex justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={close} autoFocus>
                      {t("content.cancel")}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        close();
                        deleteNow();
                      }}
                    >
                      {t("folderEdit.deleteFolderAction")}
                    </Button>
                  </div>
                </div>
              ),
            }}
          />
        )}
      </div>
      {children}
    </div>
  );
}

function ArrangeFile({ entry, depth, context }: { entry: FolderEditResultEntry; depth: number; context: TreeContext }) {
  const { t } = useTranslation();
  const { arrange, disabled } = context;
  const movable = !disabled && folderEditEntryMovable(entry);
  const here = parentFolder(entry.path);
  const own = entry.key.startsWith(currentFileKey(""));
  const revealed = useRevealedRow<HTMLDivElement>(context.reveal?.key === entry.key ? context.reveal.seq : null);
  const discard =
    context.onDiscard && entry.state !== "remove" && entry.state !== "moved" && entry.state !== "replaced"
      ? context.onDiscard
      : undefined;
  const restore = context.onRestore && entry.state === "remove" ? context.onRestore : undefined;
  const actions: RowMenuAction[] = [
    ...(restore
      ? [{ key: "keep", label: t("fileWorkspace.pending.keep"), icon: Undo2, run: () => restore(entry) }]
      : []),
    ...(movable
      ? [{ key: "move", label: t("folderEdit.moveTo"), icon: FolderInput, choosesFolder: true, run: () => undefined }]
      : []),
    ...(discard
      ? [
          own
            ? {
                key: "delete",
                label: t("fileWorkspace.deleteFile"),
                icon: Trash2,
                destructive: true,
                run: () => discard(entry),
              }
            : { key: "drop", label: t("fileWorkspace.dropAddition"), icon: X, run: () => discard(entry) },
        ]
      : []),
  ];
  return (
    <div
      ref={revealed.ref}
      draggable={movable}
      className={cn("rounded-md", movable && "cursor-grab", revealed.flashing && revealedRowClass)}
      onDragStart={
        movable
          ? (event) => {
              event.stopPropagation();
              startFolderEditDrag(event, { kind: "entry", key: entry.key }, entry.name);
            }
          : undefined
      }
    >
      <ResultRow
        entry={entry}
        depth={depth}
        decision={entry.item ? context.decisions[entry.item.itemKey] : undefined}
        disabled={disabled}
        onDecisionChange={context.onDecisionChange}
        mark={context.entryMark?.(entry)}
        changesOnly={context.changesOnly}
        actions={
          actions.length > 0 && !disabled ? (
            <RowMenu
              label={t("folderEdit.fileActions", { name: entry.name })}
              actions={actions}
              moveTargets={["", ...context.allFolders].filter((folder) => folder !== here)}
              disabled={disabled}
              onMove={(folder) => arrange.moveEntries([entry.key], folder)}
            />
          ) : (
            <span className="w-7 shrink-0" aria-hidden="true" />
          )
        }
      />
    </div>
  );
}
