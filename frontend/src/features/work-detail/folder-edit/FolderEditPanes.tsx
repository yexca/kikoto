import {
  ChevronDown,
  ChevronRight,
  FileAudio,
  FileText,
  FileVideo,
  Folder,
  Image as ImageIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  conflictResolutions,
  folderEditTreeFiles,
  type FolderEditFile,
  type FolderEditResultEntry,
  type FolderEditResultState,
  type FolderEditTreeNode,
} from "@/features/work-detail/folder-edit/folderEditModel";
import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";
import { naturalCompare } from "@/features/work-detail/workflows/RemoteFetchWorkspaceTrees";
import type { RemoteFetchFileDecision, RemoteFetchResolution } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

/**
 * The parts of a three-column file workspace: where files can come from, the
 * files of the chosen place, and the folder as it will be.
 */

/** Switches between the columns where only one fits. */
export function PaneSwitch<Pane extends string>({
  panes,
  value,
  onChange,
}: {
  panes: readonly { value: Pane; label: string; count: number }[];
  value: Pane;
  onChange: (pane: Pane) => void;
}) {
  return (
    <div className="flex shrink-0 gap-1 border-b bg-background px-3 py-2 lg:hidden">
      <div className="flex min-w-0 flex-1 gap-1 rounded-lg bg-muted p-1">
        {panes.map((pane) => (
          <button
            key={pane.value}
            type="button"
            aria-pressed={value === pane.value}
            onClick={() => onChange(pane.value)}
            className={cn(
              "inline-flex min-h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              value === pane.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="truncate">{pane.label}</span>
            <span aria-hidden="true" className="rounded-full bg-background/60 px-1.5 text-3xs tabular-nums">
              {pane.count}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** One place files can come from, with how many of its files the edit adds or removes. */
export function ResourceOption({
  icon: Icon,
  title,
  note,
  code,
  detail,
  changes,
  removes = false,
  selected,
  disabled,
  onSelect,
}: {
  icon: LucideIcon;
  title: string;
  /** A short remark next to the title. */
  note?: string;
  code?: string;
  detail: string;
  changes: number;
  /** The changes are files that leave the folder. */
  removes?: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      title={detail}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70",
        selected ? "border-primary bg-primary/[0.07]" : "bg-background hover:border-foreground/20 hover:bg-muted/50",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{title}</span>
          {note && <span className="shrink-0 text-2xs text-muted-foreground">{note}</span>}
        </span>
        {code && <span className="mt-1 block truncate font-mono text-2xs text-muted-foreground">{code}</span>}
        <span className="mt-0.5 block truncate text-2xs text-muted-foreground">{detail}</span>
      </span>
      {changes > 0 && (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-px text-2xs font-medium tabular-nums",
            removes ? "bg-error-surface text-error-foreground" : "bg-primary/10 text-primary",
          )}
          aria-label={t(removes ? "folderEdit.removeCount" : "folderEdit.addCount", { count: changes })}
        >
          {removes ? "−" : "+"}
          {changes}
        </span>
      )}
    </button>
  );
}

export function ColumnLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("text-2xs font-medium uppercase tracking-wide text-muted-foreground", className)}>
      {children}
    </div>
  );
}

export function PaneNote({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid min-h-32 place-items-center gap-2 rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground"
      role="status"
    >
      {children}
    </div>
  );
}

export function KindIcon({ kind }: { kind: string }) {
  const className = "h-4 w-4 shrink-0 text-muted-foreground";
  if (kind === "audio") return <FileAudio className={className} aria-hidden="true" />;
  if (kind === "video") return <FileVideo className={className} aria-hidden="true" />;
  if (kind === "image") return <ImageIcon className={className} aria-hidden="true" />;
  return <FileText className={className} aria-hidden="true" />;
}

export function sortedFolders<T>(node: FolderEditTreeNode<T>) {
  return Array.from(node.children.values()).sort((left, right) => naturalCompare(left.name, right.name));
}

/**
 * One folder of a selection tree with its files. `meta` adds a note to a file
 * row, before its size, and `below` a line under the file's name. With
 * `onDragFiles`, a file or folder can be dragged: it hands over the files'
 * paths and the folder above them.
 */
export function SelectionNode({
  node,
  depth,
  selected,
  disabled,
  isRoot = false,
  meta,
  below,
  onToggle,
  onDragFiles,
}: {
  node: FolderEditTreeNode<FolderEditFile>;
  depth: number;
  selected: ReadonlySet<string>;
  disabled: boolean;
  isRoot?: boolean;
  meta?: (file: FolderEditFile) => ReactNode;
  below?: (file: FolderEditFile) => ReactNode;
  onToggle: (paths: readonly string[], included: boolean) => void;
  onDragFiles?: (event: DragEvent, paths: readonly string[], base: string) => void;
}) {
  const draggable = Boolean(onDragFiles) && !disabled;
  const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const { t } = useTranslation();
  const [open, setOpen] = useState(depth <= 1);
  const paths = useMemo(() => folderEditTreeFiles(node).map((file) => file.path), [node]);
  const count = paths.filter((path) => selected.has(path)).length;
  const checked = paths.length > 0 && count === paths.length;
  const files = [...node.files].sort((left, right) => naturalCompare(left.name, right.name));
  return (
    <div className="space-y-px">
      {!isRoot && (
        <div
          className={cn(
            "flex min-h-9 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted/70",
            draggable && "cursor-grab",
          )}
          style={{ paddingLeft: (depth - 1) * 14 + 8 }}
          draggable={draggable}
          onDragStart={draggable ? (event) => onDragFiles?.(event, paths, parentOf(node.path)) : undefined}
        >
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-background"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={
              open
                ? t("libraryDetail.collapseFolder", { name: node.name })
                : t("libraryDetail.expandFolder", { name: node.name })
            }
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          <Checkbox
            checked={checked}
            indeterminate={count > 0 && !checked}
            disabled={disabled || paths.length === 0}
            onCheckedChange={() => onToggle(paths, !checked)}
            aria-label={t("libraryDetail.selectFolder", { name: node.name })}
          />
          <Folder className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left font-medium"
            onClick={() => setOpen((value) => !value)}
          >
            {node.name}
          </button>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {count}/{paths.length}
          </span>
        </div>
      )}
      {(isRoot || open) &&
        sortedFolders(node).map((child) => (
          <SelectionNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selected={selected}
            disabled={disabled}
            meta={meta}
            below={below}
            onToggle={onToggle}
            onDragFiles={onDragFiles}
          />
        ))}
      {(isRoot || open) &&
        files.map((file) => {
          const included = selected.has(file.path);
          const line = below?.(file);
          const row = (
            <label
              key={file.path}
              className={cn(
                "flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm",
                included ? "hover:bg-muted/70" : "text-muted-foreground hover:bg-muted/70",
              )}
              style={{ paddingLeft: depth * 14 + 8 }}
              title={file.path}
              draggable={draggable}
              onDragStart={draggable ? (event) => onDragFiles?.(event, [file.path], parentOf(file.path)) : undefined}
            >
              <span className="w-[18px] shrink-0" aria-hidden="true" />
              <Checkbox
                checked={included}
                disabled={disabled}
                onCheckedChange={(next) => onToggle([file.path], next)}
                aria-label={t("libraryDetail.selectFile", { name: file.name })}
              />
              <KindIcon kind={file.kind} />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              {meta?.(file)}
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {file.sizeBytes === null ? "" : formatBytes(file.sizeBytes)}
              </span>
            </label>
          );
          if (!line) return row;
          // The line starts under the file's name: past the spacer, checkbox, and icon.
          return (
            <div key={file.path}>
              {row}
              <div className="-mt-1 pb-1.5 pr-2" style={{ paddingLeft: depth * 14 + 82 }}>
                {line}
              </div>
            </div>
          );
        })}
    </div>
  );
}

const resolutionLabels: Record<RemoteFetchResolution, string> = {
  auto: "remoteFetch.unresolved",
  keep_local: "folderEdit.keepExisting",
  replace: "folderEdit.replaceExisting",
  keep_both: "remoteFetch.keepBoth",
  rename: "remoteFetch.renameIncoming",
  exclude: "remoteFetch.exclude",
};

const resultBadge: Record<
  FolderEditResultState,
  { key: string; variant: "outline" | "success" | "error" | "warning" }
> = {
  keep: { key: "folderEdit.state.keep", variant: "outline" },
  same: { key: "folderEdit.state.same", variant: "outline" },
  remove: { key: "folderEdit.state.remove", variant: "error" },
  replaced: { key: "folderEdit.state.replaced", variant: "warning" },
  add_local: { key: "folderEdit.state.copy", variant: "success" },
  add_remote: { key: "folderEdit.state.download", variant: "success" },
  add_move: { key: "folderEdit.state.move", variant: "success" },
  moved: { key: "folderEdit.state.moved", variant: "outline" },
  conflict: { key: "remoteFetch.actionConflict", variant: "error" },
  excluded: { key: "remoteFetch.actionExcluded", variant: "outline" },
  pending: { key: "folderEdit.state.pending", variant: "outline" },
};

/** One folder of the result tree: the files it keeps, loses, and gains, with the decision each conflict needs. */
export function ResultNode({
  node,
  depth,
  decisions,
  disabled,
  isRoot = false,
  onDecisionChange,
}: {
  node: FolderEditTreeNode<FolderEditResultEntry>;
  depth: number;
  decisions: Readonly<Record<string, RemoteFetchFileDecision>>;
  disabled: boolean;
  isRoot?: boolean;
  onDecisionChange: (decision: RemoteFetchFileDecision) => void;
}) {
  const [open, setOpen] = useState(true);
  const entries = [...node.files].sort((left, right) => naturalCompare(left.name, right.name));
  return (
    <div className="space-y-px">
      {!isRoot && (
        <button
          type="button"
          className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted/70"
          style={{ paddingLeft: (depth - 1) * 14 + 8 }}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <Folder className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="truncate font-medium">{node.name}</span>
        </button>
      )}
      {(isRoot || open) &&
        sortedFolders(node).map((child) => (
          <ResultNode
            key={child.path}
            node={child}
            depth={depth + 1}
            decisions={decisions}
            disabled={disabled}
            onDecisionChange={onDecisionChange}
          />
        ))}
      {(isRoot || open) &&
        entries.map((entry) => (
          <ResultRow
            key={entry.key}
            entry={entry}
            depth={depth}
            decision={entry.item ? decisions[entry.item.itemKey] : undefined}
            disabled={disabled}
            onDecisionChange={onDecisionChange}
          />
        ))}
    </div>
  );
}

/** One file of the result with its state; `actions` sits at the end of the row. */
export function ResultRow({
  entry,
  depth,
  decision,
  disabled,
  actions,
  onDecisionChange,
}: {
  entry: FolderEditResultEntry;
  depth: number;
  decision: RemoteFetchFileDecision | undefined;
  disabled: boolean;
  actions?: ReactNode;
  onDecisionChange: (decision: RemoteFetchFileDecision) => void;
}) {
  const { t } = useTranslation();
  const badge = resultBadge[entry.state];
  const leaving = entry.state === "remove" || entry.state === "replaced" || entry.state === "moved";
  const item = entry.item;
  const current: RemoteFetchFileDecision = decision ?? {
    itemKey: item?.itemKey ?? "",
    sourceId: 0,
    resolution: (item?.resolution || "auto") as RemoteFetchResolution,
    targetPath: entry.path,
  };
  const showEditor = Boolean(item && (item.targetConflict || current.resolution !== "auto"));
  const source = item
    ? item.sourceKind === "remote"
      ? t("folderEdit.fromSource", { source: `${item.remoteSourceName} · ${item.remoteCode ?? ""}` })
      : t("folderEdit.fromSource", { source: item.localSourcePath })
    : "";
  return (
    <div
      className={cn("rounded-md", entry.state === "conflict" ? "bg-error-surface/50" : "hover:bg-muted/60")}
      style={{ marginLeft: depth * 14 }}
      title={source || entry.path}
    >
      <div className="flex min-h-8 items-center gap-2 px-2 text-xs">
        <KindIcon kind={entry.kind} />
        <span className={cn("min-w-0 flex-1 truncate", leaving && "text-muted-foreground line-through")}>
          {entry.name}
        </span>
        {entry.sizeBytes !== null && (
          <span className="hidden shrink-0 tabular-nums text-muted-foreground sm:inline">
            {formatBytes(entry.sizeBytes)}
          </span>
        )}
        <Badge variant={badge.variant} className="shrink-0 px-2 py-0 text-2xs">
          {t(badge.key)}
        </Badge>
        {actions}
      </div>
      {showEditor && item && (
        <div className="grid gap-2 border-t px-2 py-2 text-xs">
          <label className="space-y-1">
            <span className="text-muted-foreground">{t("remoteFetch.conflictAction")}</span>
            <select
              className="h-8 w-full rounded-md border bg-background px-2"
              value={current.resolution}
              disabled={disabled}
              onChange={(event) =>
                onDecisionChange({ ...current, resolution: event.target.value as RemoteFetchResolution })
              }
            >
              {conflictResolutions(item).map((resolution) => (
                <option key={resolution} value={resolution}>
                  {t(resolutionLabels[resolution])}
                </option>
              ))}
            </select>
          </label>
          {current.resolution === "rename" && (
            <label className="space-y-1">
              <span className="text-muted-foreground">{t("folderEdit.targetPath")}</span>
              <input
                className="h-8 w-full rounded-md border bg-background px-2"
                value={current.targetPath}
                disabled={disabled}
                onChange={(event) => onDecisionChange({ ...current, targetPath: event.target.value })}
              />
            </label>
          )}
          {item.targetBlock ? (
            <div className="text-destructive">
              {t(`folderEdit.targetBlock.${item.targetBlock}`, { path: item.targetBlocker ?? "" })}
            </div>
          ) : (
            item.targetConflictReason && <div className="text-destructive">{item.targetConflictReason}</div>
          )}
        </div>
      )}
    </div>
  );
}
