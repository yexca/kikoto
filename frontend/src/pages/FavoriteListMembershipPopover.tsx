import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { api, type FavoriteList } from "@/lib/api";

import {
  membershipChanges,
  membershipStatesFromSummary,
  nextMembershipState,
  type ListMembershipState,
} from "./favoriteListMembershipDraft";

export type FavoriteListMembershipChanges = { addListIds: number[]; removeListIds: number[] };

/**
 * Bulk list editor for selected works. Rows start from the works' real
 * membership, and only rows the user changes are saved, so memberships in
 * other lists are never replaced.
 */
export function FavoriteListMembershipPopover({
  title,
  workIDs,
  favoriteLists,
  disabled,
  align = "left",
  onClose,
  onSave,
}: {
  title: string;
  workIDs: number[];
  favoriteLists: FavoriteList[];
  disabled: boolean;
  align?: "left" | "right";
  onClose: () => void;
  onSave: (changes: FavoriteListMembershipChanges) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [initialStates, setInitialStates] = useState<Map<number, ListMembershipState> | null>(null);
  const [states, setStates] = useState<Map<number, ListMembershipState>>(new Map());
  const [counts, setCounts] = useState<{ total: number; byList: Map<number, number> }>({
    total: 0,
    byList: new Map(),
  });
  const [error, setError] = useState("");
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const workKey = workIDs.join(",");

  useEffect(() => {
    let cancelled = false;
    setInitialStates(null);
    setError("");
    api
      .summarizeFavoriteListMembership(workIDs)
      .then((summary) => {
        if (cancelled) return;
        const loaded = membershipStatesFromSummary(summary);
        setInitialStates(loaded);
        setStates(new Map(loaded));
        setCounts({ total: summary.total, byList: new Map(summary.lists.map((list) => [list.listId, list.count])) });
      })
      .catch(() => {
        if (!cancelled) setError(t("favorites.listLoadFailed"));
      });
    return () => {
      cancelled = true;
    };
    // workKey captures the selection; the array identity changes on every render.
  }, [workKey]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && popoverRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const isLoading = initialStates === null && !error;
  const changes = initialStates ? membershipChanges(initialStates, states) : { addListIds: [], removeListIds: [] };
  const hasChanges = changes.addListIds.length > 0 || changes.removeListIds.length > 0;

  const cycleList = (listID: number) => {
    if (!initialStates) return;
    setStates((items) => {
      const next = new Map(items);
      next.set(listID, nextMembershipState(initialStates.get(listID) ?? "none", items.get(listID) ?? "none"));
      return next;
    });
  };

  const save = async () => {
    setError("");
    try {
      await onSave(changes);
    } catch {
      setError(t("favorites.membershipSaveFailed"));
    }
  };

  return (
    <div
      ref={popoverRef}
      className={`absolute top-full z-50 mt-2 w-72 rounded-lg border bg-card p-3 text-left shadow-xl ${align === "right" ? "right-0" : "left-0"}`}
      onClick={(event) => event.stopPropagation()}
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="app-scroll mt-3 max-h-64 space-y-2 overflow-auto">
        {isLoading ? (
          <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
            {t("favorites.loadingLists")}
          </div>
        ) : initialStates && favoriteLists.length > 0 ? (
          favoriteLists.map((list) => {
            const state = states.get(list.id) ?? "none";
            return (
              <div
                key={list.id}
                className={`flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm hover:bg-muted ${state === "none" ? "bg-background" : "border-primary/30 bg-primary/10"}`}
                onClick={() => cycleList(list.id)}
              >
                <Checkbox
                  checked={state === "all"}
                  indeterminate={state === "some"}
                  onCheckedChange={() => cycleList(list.id)}
                  onClick={(event) => event.stopPropagation()}
                  aria-label={list.name}
                />
                <span className="min-w-0 flex-1 truncate">{list.name}</span>
                {state === "some" && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {counts.byList.get(list.id) ?? 0}/{counts.total}
                  </span>
                )}
              </div>
            );
          })
        ) : initialStates ? (
          <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
            {t("favorites.noFavoriteLists")}
          </div>
        ) : null}
        {error && (
          <div className="rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground">{error}</div>
        )}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          {t("content.cancel")}
        </Button>
        <Button size="sm" disabled={disabled || isLoading || !hasChanges} onClick={() => void save()}>
          {t("content.save")}
        </Button>
      </div>
    </div>
  );
}
