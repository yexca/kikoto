import { useEffect, useMemo, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { FavoriteListPicker, type FavoriteListPickerOption } from "@/components/favorite-list/FavoriteListPicker";
import { FavoriteListPickerSurface } from "@/components/favorite-list/FavoriteListPickerSurface";
import { Button } from "@/components/ui/button";
import { api, type FavoriteList } from "@/lib/api";

import {
  membershipChanges,
  membershipStatesFromSummary,
  nextMembershipState,
  type ListMembershipState,
} from "./favoriteListMembershipDraft";

export type FavoriteListMembershipChanges = { addListIds: number[]; removeListIds: number[] };

const pickerStates = { all: "checked", some: "mixed", none: "unchecked" } as const;

/**
 * Bulk list editor for selected works. Rows start from the works' real
 * membership and show the change each one will make; only rows the user
 * changes are applied, so memberships in other lists are never replaced.
 * Pending changes keep the popover open on an outside click.
 */
export function FavoriteListMembershipPicker({
  open,
  onOpenChange,
  anchorRef,
  mobile,
  workIDs,
  favoriteLists,
  disabled,
  onListCreated,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLElement | null>;
  mobile: boolean;
  workIDs: number[];
  favoriteLists: FavoriteList[];
  disabled: boolean;
  onListCreated: () => void;
  onSave: (changes: FavoriteListMembershipChanges) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [initialStates, setInitialStates] = useState<Map<number, ListMembershipState> | null>(null);
  const [states, setStates] = useState<Map<number, ListMembershipState>>(new Map());
  const [counts, setCounts] = useState<{ total: number; byList: Map<number, number> }>({
    total: 0,
    byList: new Map(),
  });
  const [created, setCreated] = useState<FavoriteList[]>([]);
  // A key rather than text, so loading never depends on the current translation.
  const [errorKey, setErrorKey] = useState<"" | "favorites.listLoadFailed" | "favorites.membershipSaveFailed">("");
  const workKey = workIDs.join(",");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setInitialStates(null);
    setCreated([]);
    setErrorKey("");
    // workKey captures the selection; the array identity changes on every render.
    const selectedWorkIDs = workKey ? workKey.split(",").map(Number) : [];
    api
      .summarizeFavoriteListMembership(selectedWorkIDs)
      .then((summary) => {
        if (cancelled) return;
        const loaded = membershipStatesFromSummary(summary);
        setInitialStates(loaded);
        setStates(new Map(loaded));
        setCounts({ total: summary.total, byList: new Map(summary.lists.map((list) => [list.listId, list.count])) });
      })
      .catch(() => {
        if (!cancelled) setErrorKey("favorites.listLoadFailed");
      });
    return () => {
      cancelled = true;
    };
  }, [open, workKey]);

  const lists = useMemo(() => {
    const known = new Set(favoriteLists.map((list) => list.id));
    return [...favoriteLists, ...created.filter((list) => !known.has(list.id))];
  }, [created, favoriteLists]);
  const changes = initialStates ? membershipChanges(initialStates, states) : { addListIds: [], removeListIds: [] };
  const hasChanges = changes.addListIds.length > 0 || changes.removeListIds.length > 0;

  const options = useMemo<FavoriteListPickerOption[] | null>(() => {
    if (!initialStates) return null;
    return lists.map((list) => {
      const initial = initialStates.get(list.id) ?? "none";
      const state = states.get(list.id) ?? "none";
      const count = counts.byList.get(list.id) ?? 0;
      const option: FavoriteListPickerOption = { list, state: pickerStates[state] };
      if (state !== initial && state === "all") {
        const added = counts.total - count;
        option.hint = `+${added}`;
        option.hintLabel = t("favorites.listChangeAdd", { count: added });
        option.hintTone = "add";
      } else if (state !== initial && state === "none") {
        option.hint = `−${count}`;
        option.hintLabel = t("favorites.listChangeRemove", { count });
        option.hintTone = "remove";
      } else if (state === "some") {
        option.hint = `${count}/${counts.total}`;
        option.hintLabel = t("favorites.listChangePartial", { count, total: counts.total });
      }
      return option;
    });
  }, [counts, initialStates, lists, states, t]);

  const cycleList = (listID: number) => {
    if (!initialStates) return;
    setStates((items) => {
      const next = new Map(items);
      next.set(listID, nextMembershipState(initialStates.get(listID) ?? "none", items.get(listID) ?? "none"));
      return next;
    });
  };

  const create = async (name: string) => {
    const list = await api.createFavoriteList({ name });
    setCreated((current) => [...current, list]);
    setStates((items) => new Map(items).set(list.id, "all"));
    onListCreated();
  };

  const save = async () => {
    setErrorKey("");
    try {
      await onSave(changes);
    } catch {
      setErrorKey("favorites.membershipSaveFailed");
    }
  };

  const title = t("favorites.selectedWorks", { count: workIDs.length });
  return (
    <FavoriteListPickerSurface
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      title={title}
      mobile={mobile}
      dismissOnOutsidePointer={!hasChanges}
    >
      <FavoriteListPicker
        label={title}
        options={options}
        loadError={errorKey === "favorites.listLoadFailed" ? t(errorKey) : undefined}
        canCreate
        autoFocusSearch={!mobile}
        disabled={disabled}
        onToggle={cycleList}
        onCreate={create}
        footer={
          <div className="border-t p-2">
            {errorKey === "favorites.membershipSaveFailed" && (
              <p role="alert" className="px-1 pb-2 text-xs text-destructive">
                {t(errorKey)}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {t("content.cancel")}
              </Button>
              <Button size="sm" disabled={disabled || !initialStates || !hasChanges} onClick={() => void save()}>
                {t("favorites.applyListChanges", { count: workIDs.length })}
              </Button>
            </div>
          </div>
        }
      />
    </FavoriteListPickerSurface>
  );
}
