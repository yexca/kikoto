import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type FavoriteList } from "@/lib/api";

function editableLists(lists: FavoriteList[]) {
  return lists.filter((list) => list.kind !== "marked");
}

function selectedIds(lists: FavoriteList[]) {
  return new Set(lists.filter((list) => list.selected).map((list) => list.id));
}

/**
 * The lists one work belongs to, edited a toggle at a time. Each toggle saves
 * at once; saves run one at a time and coalesce to the latest selection, so
 * fast toggles cannot land out of order, and a failed save falls back to the
 * last saved state. The caller hears about a change once, after the picker
 * closes and every save has settled.
 */
export function useWorkFavoriteLists({
  workId,
  open,
  onSaved,
}: {
  workId: number | null;
  open: boolean;
  onSaved?: (favorite: boolean, workId: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [lists, setLists] = useState<FavoriteList[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [optimistic, setOptimistic] = useState<Set<number> | null>(null);
  const [saving, setSaving] = useState(false);
  const listsRef = useRef<FavoriteList[] | null>(null);
  const optimisticRef = useRef<Set<number> | null>(null);
  const pendingRef = useRef<Set<number> | null>(null);
  const savingRef = useRef(false);
  const savedRef = useRef<{ workId: number; favorite: boolean } | null>(null);
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  const replaceLists = useCallback((next: FavoriteList[] | null) => {
    listsRef.current = next;
    setLists(next);
  }, []);

  useEffect(() => {
    if (!open || !workId) return;
    let cancelled = false;
    setLoadError("");
    api
      .getWorkFavoriteLists(workId)
      .then((result) => {
        if (!cancelled) replaceLists(editableLists(result));
      })
      .catch((error) => {
        if (cancelled) return;
        const feedback = toastFromError(error, t("workCard.favoriteListsLoadFailed"));
        toast.notify(feedback);
        setLoadError(feedback.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, replaceLists, t, toast, workId]);

  // Another work starts from its own lists rather than the previous one's.
  useEffect(() => {
    replaceLists(null);
    optimisticRef.current = null;
    setOptimistic(null);
  }, [replaceLists, workId]);

  // Report once the picker is closed and the last save has settled.
  useEffect(() => {
    if (open || saving || !savedRef.current) return;
    const saved = savedRef.current;
    savedRef.current = null;
    onSavedRef.current?.(saved.favorite, saved.workId);
  }, [open, saving]);

  const flush = useCallback(
    async (targetWorkId: number) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      try {
        while (pendingRef.current) {
          const next = pendingRef.current;
          pendingRef.current = null;
          try {
            const result = await api.setWorkFavoriteLists(targetWorkId, Array.from(next));
            replaceLists(editableLists(result.lists));
            savedRef.current = { workId: targetWorkId, favorite: result.favorite };
          } catch (error) {
            toast.notify(toastFromError(error, t("workCard.favoriteListsSaveFailed")));
          }
        }
      } finally {
        savingRef.current = false;
        optimisticRef.current = null;
        setOptimistic(null);
        setSaving(false);
      }
    },
    [replaceLists, t, toast],
  );

  const apply = (next: Set<number>) => {
    if (!workId) return;
    optimisticRef.current = next;
    setOptimistic(next);
    pendingRef.current = next;
    void flush(workId);
  };

  const current = () => optimisticRef.current ?? selectedIds(listsRef.current ?? []);

  const toggle = (listId: number) => {
    const next = new Set(current());
    if (next.has(listId)) next.delete(listId);
    else next.add(listId);
    apply(next);
  };

  /** Creates a list and puts the work in it; a failed creation throws for the picker to show. */
  const create = async (name: string) => {
    const list = await api.createFavoriteList({ name });
    replaceLists([...(listsRef.current ?? []), { ...list, selected: false }]);
    apply(new Set(current()).add(list.id));
  };

  const saved = lists ? selectedIds(lists) : null;
  const selected = optimistic ?? saved;
  /** Lists whose toggle has not been saved yet. */
  const isPending = (listId: number) => Boolean(optimistic && saved && optimistic.has(listId) !== saved.has(listId));
  return { lists, selected, loadError, isPending, toggle, create };
}
