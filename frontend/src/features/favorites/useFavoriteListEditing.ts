import { useRef, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import type { FavoriteListDraft, FavoriteListManager } from "@/features/favorites/FavoriteListManager";
import { api, type FavoriteList } from "@/lib/api";

type FavoriteListManagerState = Omit<ComponentProps<typeof FavoriteListManager>, "markedList" | "lists">;

/**
 * The list manager dialog's state and actions: creating, editing, ordering,
 * and deleting the user's lists. Every change reloads the lists through
 * `reloadLists`; `onShowList` opens a saved list and `onListDeleted` lets the
 * page leave a deleted list's shelf.
 */
export function useFavoriteListEditing({
  userLists,
  setFavoriteLists,
  reloadLists,
  onShowList,
  onListDeleted,
}: {
  userLists: FavoriteList[];
  setFavoriteLists: (update: (lists: FavoriteList[]) => FavoriteList[]) => void;
  reloadLists: () => Promise<FavoriteList[]>;
  onShowList: (list: "all" | number) => void;
  onListDeleted: (listID: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<FavoriteList | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FavoriteList | null>(null);
  const [deleting, setDeleting] = useState(false);
  // An editor opened from Edit lists returns there; one opened from a shelf closes the dialog.
  const [editorReturnsToList, setEditorReturnsToList] = useState(false);
  const listOrderSave = useRef<Promise<void>>(Promise.resolve());

  /** Opens Edit lists, or the editor of one list straight from a shelf. */
  const openManager = (next: FavoriteList | "new" | null = null) => {
    setEditor(next);
    setEditorReturnsToList(false);
    setDeleteTarget(null);
    setOpen(true);
  };

  const editFromManager = (next: FavoriteList | "new") => {
    setEditor(next);
    setEditorReturnsToList(true);
  };

  const close = () => {
    if (deleting) return;
    setOpen(false);
    setEditor(null);
    setDeleteTarget(null);
  };

  /** Leaves the editor: back to Edit lists when it came from there, otherwise closed. */
  const finishEdit = () => {
    if (editorReturnsToList) setEditor(null);
    else close();
  };

  const save = async (payload: FavoriteListDraft) => {
    if (editor === null) return;
    if (editor === "new") {
      const list = await api.createFavoriteList(payload);
      const lists = await reloadLists();
      onShowList(lists.some((item) => item.id === list.id) ? list.id : "all");
    } else {
      const list = await api.updateFavoriteList(editor.id, payload);
      await reloadLists();
      onShowList(list.id);
    }
    finishEdit();
    toast.success(t("favorites.listSaved"));
  };

  /** Deletes a list; failures are reported and rethrown so the caller can stay put. */
  const remove = async (list: FavoriteList) => {
    setDeleting(true);
    try {
      await api.deleteFavoriteList(list.id);
      onListDeleted(list.id);
      await reloadLists();
      toast.success(t("favorites.listDeleted"));
    } catch (error) {
      toast.notify(toastFromError(error, t("favorites.listDeleteFailed")));
      throw error;
    } finally {
      setDeleting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    try {
      await remove(deleteTarget);
      setDeleteTarget(null);
    } catch {
      // Reported by remove; the confirmation stays for a retry.
    }
  };

  const deleteFromEditor = async (list: FavoriteList) => {
    if (deleting) return;
    await remove(list);
    if (editorReturnsToList) setEditor(null);
    else {
      setOpen(false);
      setEditor(null);
    }
  };

  // Moves apply at once and save in order; only lists whose position changed are written.
  const move = (listID: number, direction: -1 | 1) => {
    const targetIndex = userLists.findIndex((list) => list.id === listID);
    const nextIndex = targetIndex + direction;
    if (targetIndex < 0 || nextIndex < 0 || nextIndex >= userLists.length) return;
    const reordered = [...userLists];
    const [moving] = reordered.splice(targetIndex, 1);
    reordered.splice(nextIndex, 0, moving);
    const changed = reordered.flatMap((list, index) => (list.sortOrder === index ? [] : [{ id: list.id, index }]));
    setFavoriteLists((lists) => [
      ...lists.filter((list) => list.kind === "marked"),
      ...reordered.map((list, index) => ({ ...list, sortOrder: index })),
    ]);
    listOrderSave.current = listOrderSave.current
      .then(async () => {
        for (const { id, index } of changed) await api.updateFavoriteList(id, { sortOrder: index });
      })
      .catch(async (error) => {
        toast.notify(toastFromError(error, t("favorites.reorderFailed")));
        await reloadLists().catch(() => undefined);
      });
  };

  const managerProps: FavoriteListManagerState = {
    editor,
    editorReturnsToList,
    deleteTarget,
    deleting,
    onClose: close,
    onNew: () => editFromManager("new"),
    onEdit: editFromManager,
    onCancelEdit: finishEdit,
    onSave: save,
    onDelete: setDeleteTarget,
    onCancelDelete: () => setDeleteTarget(null),
    onConfirmDelete: () => void confirmDelete(),
    onDeleteFromEditor: deleteFromEditor,
    onMove: move,
  };

  return { open, openManager, managerProps };
}
