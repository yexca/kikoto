import { ArrowDown, ArrowUp, BookmarkCheck, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { favoriteListIcon } from "@/components/favorite-list/favoriteListIcons";
import { Input } from "@/components/ui/input";
import type { FavoriteList } from "@/lib/api";
import { FavoriteListIconPicker } from "./FavoriteListIconPicker";

export type FavoriteListDraft = { name: string; description: string; icon: string };

function FavoriteListEditor({
  list,
  onClose,
  onSave,
}: {
  list: FavoriteList | null;
  onClose: () => void;
  onSave: (payload: FavoriteListDraft) => Promise<void>;
}) {
  const { t } = useTranslation();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [icon, setIcon] = useState(list?.icon ?? "");
  const PreviewIcon = favoriteListIcon({ icon });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: "nearest" }));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const save = async () => {
    setIsSaving(true);
    setError("");
    try {
      await onSave({ name, description, icon });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t("favorites.listSaveFailed"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div ref={editorRef} role="listitem">
      <form
        aria-label={list ? `${t("favorites.renameList")}: ${list.name}` : t("favorites.addList")}
        className="rounded-md border bg-background p-3"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!isSaving && name.trim()) void save();
        }}
      >
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"
          >
            <PreviewIcon className="h-[18px] w-[18px]" />
          </span>
          <h3 className="min-w-0 truncate text-sm font-semibold">
            {list ? t("favorites.renameList") : t("favorites.addList")}
          </h3>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{t("favorites.name")}</span>
            <Input fieldSize="sm" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{t("favorites.description")}</span>
            <Input fieldSize="sm" value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
        </div>
        <div className="mt-3">
          <FavoriteListIconPicker value={icon} onChange={setIcon} />
        </div>
        {error && (
          <div className="mt-3 rounded-md border bg-card px-3 py-2 text-xs text-muted-foreground" role="alert">
            {error}
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t("content.cancel")}
          </Button>
          <Button size="sm" type="submit" disabled={isSaving || !name.trim()}>
            {isSaving ? t("favorites.saving") : list ? t("content.save") : t("favorites.addList")}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function FavoriteListManager({
  markedList,
  lists,
  editor,
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
  onMove,
}: {
  markedList: FavoriteList | null;
  lists: FavoriteList[];
  editor: FavoriteList | "new" | null;
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
  onMove: (listID: number, direction: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  const actionsDisabled = editor !== null || deleteTarget !== null || deleting;

  return (
    <Dialog
      onClose={onClose}
      size="lg"
      dismissible={!deleting}
      // Nested rename/delete surfaces own Escape while they are open.
      closeOnEscape={editor === null && deleteTarget === null}
    >
      <DialogHeader
        title={t("favorites.editLists")}
        description={t("favorites.editListsDescription")}
        onClose={() => {
          if (!deleting) onClose();
        }}
        closeLabel={t("favorites.closeListEditor")}
      />
      <DialogBody className="space-y-2 overscroll-contain" role="list" aria-label={t("favorites.lists")}>
        {markedList && (
          <div
            role="listitem"
            className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2"
          >
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
        {lists.length === 0 && editor !== "new" ? (
          <div className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
            {t("favorites.noCustomLists")}
          </div>
        ) : (
          lists.map((list, index) =>
            editor !== "new" && editor?.id === list.id ? (
              <FavoriteListEditor key={`editor-${list.id}`} list={list} onClose={onCancelEdit} onSave={onSave} />
            ) : (
              <FavoriteListManagerRow
                key={list.id}
                list={list}
                index={index}
                total={lists.length}
                actionsDisabled={actionsDisabled}
                confirmingDelete={deleteTarget?.id === list.id}
                deleting={deleting && deleteTarget?.id === list.id}
                onMove={onMove}
                onEdit={onEdit}
                onDelete={onDelete}
                onCancelDelete={onCancelDelete}
                onConfirmDelete={onConfirmDelete}
              />
            ),
          )
        )}
        {editor === "new" && (
          <FavoriteListEditor key="new-list-editor" list={null} onClose={onCancelEdit} onSave={onSave} />
        )}
      </DialogBody>
      <DialogFooter className="justify-start">
        {editor === null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onNew}
            disabled={deleteTarget !== null || deleting}
          >
            <Plus className="h-4 w-4" />
            {t("favorites.addList")}
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={onClose} disabled={deleting}>
          {t("favorites.done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function FavoriteListManagerRow({
  list,
  index,
  total,
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
  index: number;
  total: number;
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
  const deleteTitleID = `favorite-list-delete-${list.id}-title`;
  const deleteDescriptionID = `favorite-list-delete-${list.id}-description`;

  const closeDeleteConfirmation = () => {
    onCancelDelete();
    window.requestAnimationFrame(() => deleteButtonRef.current?.focus());
  };

  return (
    <div role="listitem" className="flex items-center gap-1 rounded-md border bg-background px-2 py-2 sm:gap-2 sm:px-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <ListIcon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{list.name}</div>
        {list.description && <div className="truncate text-xs text-muted-foreground">{list.description}</div>}
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 sm:h-8 sm:w-8"
          disabled={actionsDisabled || index === 0}
          onClick={() => onMove(list.id, -1)}
          aria-label={`${t("favorites.moveUp")}: ${list.name}`}
          title={t("favorites.moveUp")}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 sm:h-8 sm:w-8"
          disabled={actionsDisabled || index === total - 1}
          onClick={() => onMove(list.id, 1)}
          aria-label={`${t("favorites.moveDown")}: ${list.name}`}
          title={t("favorites.moveDown")}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 sm:h-8 sm:w-8"
          disabled={actionsDisabled}
          onClick={() => onEdit(list)}
          aria-label={`${t("favorites.rename")}: ${list.name}`}
          title={t("favorites.rename")}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          ref={deleteButtonRef}
          variant="ghost"
          size="icon"
          className="h-11 w-11 sm:h-8 sm:w-8"
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
      <AnchoredPopover
        open={confirmingDelete}
        anchorRef={deleteButtonRef}
        onOpenChange={(open) => {
          if (!open && !deleting) closeDeleteConfirmation();
        }}
        className="w-[min(18rem,calc(100vw-1.5rem))] p-3"
        zIndex={60}
      >
        <div role="alertdialog" aria-labelledby={deleteTitleID} aria-describedby={deleteDescriptionID}>
          <h3 id={deleteTitleID} className="text-sm font-semibold">
            {t("favorites.deleteListConfirm")}
          </h3>
          <p id={deleteDescriptionID} className="mt-2 text-sm text-muted-foreground">
            {t("favorites.deleteListDescription", { name: list.name })}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={closeDeleteConfirmation}
              disabled={deleting}
              autoFocus
            >
              {t("content.cancel")}
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={onConfirmDelete} disabled={deleting}>
              {deleting ? t("favorites.deleting") : t("favorites.delete")}
            </Button>
          </div>
        </div>
      </AnchoredPopover>
    </div>
  );
}
