import { FolderMinus, Trash2, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import type { PendingDeletion, PendingDeletions } from "@/features/work-detail/folder-edit/fileWorkspaceModel";
import { KindIcon, PaneNote } from "@/features/work-detail/folder-edit/FolderEditPanes";
import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";
import { cn } from "@/lib/tailwindClassNames";

/**
 * Everything the edit deletes when it is applied, by folder, with a way to
 * keep each item. It is a draft of the edit, not a place deleted files go to:
 * once the edit runs, nothing listed here can be restored.
 */
export function PendingDeletionPanel({
  pending,
  disabled,
  onKeep,
  header,
  footer,
  className,
}: {
  pending: PendingDeletions;
  disabled: boolean;
  onKeep: (item: PendingDeletion) => void;
  /** Replaces the panel's own head, such as a wide pane's; the hint then moves into the list. */
  header?: ReactNode;
  /** Kept below the list, such as an action that deletes more than the edit does. */
  footer?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const empty = pending.groups.length === 0;
  return (
    <section
      aria-label={t("fileWorkspace.pending.title")}
      className={cn("flex min-h-0 flex-1 flex-col bg-card", className)}
    >
      {header ?? (
        <div className="shrink-0 space-y-1 border-b px-3 py-2.5 lg:px-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
              <Trash2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{t("fileWorkspace.pending.title")}</span>
            </div>
            {pending.files > 0 && <PendingTotal pending={pending} />}
          </div>
          <p className="text-xs text-muted-foreground">{t("fileWorkspace.pending.hint")}</p>
        </div>
      )}
      <div className="app-scroll min-h-0 flex-1 overflow-auto overscroll-contain px-2 py-2">
        {empty && header ? (
          <div
            className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center"
            role="status"
          >
            <span className="grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground">
              <Trash2 className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="text-sm font-medium">{t("fileWorkspace.pending.empty")}</p>
            <p className="max-w-64 text-xs text-muted-foreground">{t("fileWorkspace.pending.hint")}</p>
          </div>
        ) : empty ? (
          <PaneNote>{t("fileWorkspace.pending.empty")}</PaneNote>
        ) : (
          <div className="space-y-3">
            {header && (
              <p className="flex gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-2xs text-muted-foreground">
                <Trash2 className="mt-px h-3.5 w-3.5 shrink-0 text-error" aria-hidden="true" />
                {t("fileWorkspace.pending.hint")}
              </p>
            )}
            {pending.groups.map((group) => (
              <div key={group.key} role="group" aria-label={groupLabel(group, t)}>
                <div className="flex items-center gap-1.5 px-2 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  <span className="truncate">{groupLabel(group, t)}</span>
                </div>
                <ul className="space-y-px">
                  {group.items.map((item) => (
                    <PendingRow key={item.key} item={item} disabled={disabled} onKeep={() => onKeep(item)} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
      {footer}
    </section>
  );
}

/** How many files the edit deletes and how much room that frees. */
export function PendingTotal({ pending }: { pending: PendingDeletions }) {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 rounded-full bg-error-surface px-1.5 py-px text-xs font-medium tabular-nums text-error-foreground">
      {t("fileWorkspace.pending.total", { count: pending.files, size: formatBytes(pending.sizeBytes) })}
    </span>
  );
}

function groupLabel(
  group: PendingDeletions["groups"][number],
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (group.merged) return t("fileWorkspace.pending.mergedFolders");
  return group.folder ? t("fileWorkspace.pending.inFolder", { folder: group.folder }) : t("folderEdit.rootFolder");
}

function PendingRow({ item, disabled, onKeep }: { item: PendingDeletion; disabled: boolean; onKeep: () => void }) {
  const { t } = useTranslation();
  const name = item.kind === "merged" ? item.resource.rootPath : item.name;
  const detail =
    item.kind === "merged"
      ? [
          t("fileWorkspace.pending.mergedDetail"),
          item.files === null
            ? t("fileWorkspace.pending.mergedLoading")
            : t("folderEdit.mergeFolderFiles", { count: item.files }),
          item.files ? formatBytes(item.sizeBytes) : "",
        ]
      : [
          item.kind === "replaced" ? t("fileWorkspace.pending.replaced") : "",
          item.sizeBytes === null ? "" : formatBytes(item.sizeBytes),
        ];
  return (
    <li className="flex min-h-11 items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted/60">
      {item.kind === "merged" ? (
        <FolderMinus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <KindIcon kind={item.fileKind} />
      )}
      <div className="min-w-0 flex-1" title={item.kind === "merged" ? item.resource.rootPath : item.path}>
        <div className="truncate">{name}</div>
        <div className="truncate text-2xs tabular-nums text-muted-foreground">{detail.filter(Boolean).join(" · ")}</div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 gap-1 px-2"
        disabled={disabled}
        aria-label={t(item.kind === "merged" ? "fileWorkspace.pending.keepFolder" : "fileWorkspace.pending.keepFile", {
          name,
        })}
        onClick={onKeep}
      >
        <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
        {t("fileWorkspace.pending.keep")}
      </Button>
    </li>
  );
}
