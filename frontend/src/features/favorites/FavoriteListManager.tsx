import { ArrowDown, ArrowUp, BookmarkCheck, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { favoriteListIcon } from "@/components/favorite-list/favoriteListIcons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { FavoriteList } from "@/lib/api";
import { FavoriteListDeleteConfirm } from "./FavoriteListDeleteConfirm";
import { FavoriteListEditor, type FavoriteListDraft, type FavoriteListEditorGuard } from "./FavoriteListEditor";

export type { FavoriteListDraft } from "./FavoriteListEditor";

/**
 * One dialog for the user's lists. It opens on the organizer, where lists are
 * ordered and removed, or directly on the editor of one list; the editor
 * returns to the organizer only when it was opened from there.
 */
export function FavoriteListManager({
  markedList,
  lists,
  editor,
  editorReturnsToList,
  deleteTarget,
  deleting,
  onClose,
  onNew,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onCancelDelete,
  onConfirmDelete,
  onDeleteFromEditor,
  onMove,
}: {
  markedList: FavoriteList | null;
  lists: FavoriteList[];
  editor: FavoriteList | "new" | null;
  /** Whether cancelling the editor goes back to the organizer rather than closing. */
  editorReturnsToList: boolean;
  deleteTarget: FavoriteList | null;
  deleting: boolean;
  onClose: () => void;
  onNew: () => void;
  onEdit: (list: FavoriteList) => void;
  onCancelEdit: () => void;
  onSave: (payload: FavoriteListDraft) => Promise<void>;
  onDelete: (list: FavoriteList) => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onDeleteFromEditor: (list: FavoriteList) => Promise<void>;
  onMove: (listID: number, direction: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  const [guard, setGuard] = useState<FavoriteListEditorGuard>({ dirty: false, layerOpen: false });
  const updateGuard = useCallback((next: FavoriteListEditorGuard) => setGuard(next), []);
  const editing = editor !== null;
  const editorGuard = editing ? guard : { dirty: false, layerOpen: false };
  const actionsDisabled = deleteTarget !== null || deleting;

  return (
    <Dialog
      onClose={editing ? onCancelEdit : onClose}
      size="lg"
      // Unsaved edits survive a stray backdrop press; Escape and Cancel still discard them.
      dismissible={!deleting && !editorGuard.dirty}
      // Nested pickers and delete confirmations own Escape while they are open.
      closeOnEscape={deleteTarget === null && !editorGuard.layerOpen}
    >
      {editing ? (
        <FavoriteListEditor
          key={editor === "new" ? "new" : editor.id}
          list={editor === "new" ? null : editor}
          lists={lists}
          cancelLabel={editorReturnsToList ? t("favorites.backToLists") : t("content.cancel")}
          deleting={deleting}
          onCancel={onCancelEdit}
          onClose={() => {
            if (!deleting) onClose();
          }}
          onSave={onSave}
          onDelete={onDeleteFromEditor}
          onGuardChange={updateGuard}
        />
      ) : (
        <>
          <DialogHeader
            title={t("favorites.editLists")}
            description={t("favorites.editListsDescription")}
            onClose={() => {
              if (!deleting) onClose();
            }}
            closeLabel={t("favorites.closeListEditor")}
          />
          <DialogBody className="space-y-3">
            {markedList && (
              <div className="flex items-center gap-3 rounded-md border border-dashed bg-muted/30 px-3 py-2">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                  <BookmarkCheck className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t("favorites.marked")}</div>
                  <div className="truncate text-xs text-muted-foreground">{t("favorites.markedDescription")}</div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{t("favorites.fixed")}</span>
              </div>
            )}
            {lists.length === 0 ? (
              <div className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
                {t("favorites.noCustomLists")}
              </div>
            ) : (
              <div role="list" aria-label={t("favorites.lists")} className="divide-y rounded-md border">
                {lists.map((list, index) => (
                  <FavoriteListManagerRow
                    key={list.id}
                    list={list}
                    first={index === 0}
                    last={index === lists.length - 1}
                    actionsDisabled={actionsDisabled}
                    confirmingDelete={deleteTarget?.id === list.id}
                    deleting={deleting && deleteTarget?.id === list.id}
                    onMove={onMove}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onCancelDelete={onCancelDelete}
                    onConfirmDelete={onConfirmDelete}
                  />
                ))}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mr-auto"
              onClick={onNew}
              disabled={actionsDisabled}
            >
              <Plus className="h-4 w-4" />
              {t("favorites.addList")}
            </Button>
            <Button type="button" size="sm" onClick={onClose} disabled={deleting}>
              {t("favorites.done")}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}

function FavoriteListManagerRow({
  list,
  first,
  last,
  actionsDisabled,
  confirmingDelete,
  deleting,
  onMove,
  onEdit,
  onDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  list: FavoriteList;
  first: boolean;
  last: boolean;
  actionsDisabled: boolean;
  confirmingDelete: boolean;
  deleting: boolean;
  onMove: (listID: number, direction: -1 | 1) => void;
  onEdit: (list: FavoriteList) => void;
  onDelete: (list: FavoriteList) => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const { t } = useTranslation();
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const ListIcon = favoriteListIcon(list);
  const iconButton = "h-11 w-11 text-muted-foreground sm:h-8 sm:w-8";

  return (
    <div role="listitem" className="flex items-center gap-1 px-2 py-1.5 sm:gap-2 sm:px-3">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
        disabled={actionsDisabled}
        onClick={() => onEdit(list)}
        aria-label={`${t("favorites.editList")}: ${list.name}`}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <ListIcon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{list.name}</span>
          {(list.kind === "smart" || list.description) && (
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              {list.kind === "smart" && (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <Zap className="h-3 w-3 text-primary" aria-hidden="true" />
                  {t("favorites.smart.kind")}
                  {list.description && <span aria-hidden="true">·</span>}
                </span>
              )}
              {list.description && <span className="truncate">{list.description}</span>}
            </span>
          )}
        </span>
        <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon"
          className={iconButton}
          disabled={actionsDisabled || first}
          onClick={() => onMove(list.id, -1)}
          aria-label={`${t("favorites.moveUp")}: ${list.name}`}
          title={t("favorites.moveUp")}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={iconButton}
          disabled={actionsDisabled || last}
          onClick={() => onMove(list.id, 1)}
          aria-label={`${t("favorites.moveDown")}: ${list.name}`}
          title={t("favorites.moveDown")}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
        <Button
          ref={deleteButtonRef}
          variant="ghost"
          size="icon"
          className={iconButton}
          disabled={deleting || (actionsDisabled && !confirmingDelete)}
          onClick={() => onDelete(list)}
          aria-label={`${t("favorites.delete")}: ${list.name}`}
          aria-haspopup="dialog"
          aria-expanded={confirmingDelete}
          title={t("favorites.delete")}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <FavoriteListDeleteConfirm
        name={list.name}
        listId={list.id}
        open={confirmingDelete}
        anchorRef={deleteButtonRef}
        deleting={deleting}
        onCancel={() => {
          onCancelDelete();
          window.requestAnimationFrame(() => deleteButtonRef.current?.focus());
        }}
        onConfirm={onConfirmDelete}
      />
    </div>
  );
}
