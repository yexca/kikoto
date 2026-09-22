import { GitMerge, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { api, type VoiceAlias, type VoiceAliasCandidate, type VoiceMergeReview } from "@/lib/api";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";

const aliasSuggestMinChars = 2;
const aliasSuggestMaxResults = 12;

export type VoiceAliasMessageTone = "success" | "error";

/**
 * Alias review for one voice actor: the confirmed alias chips, an add field
 * that also searches duplicate people to merge, and the undoable merge
 * history. The host decides where feedback goes and how the surrounding
 * record is refreshed.
 */
export function VoiceAliasPanel({
  personId,
  aliases,
  canManage,
  onAliasesChange,
  onMerged,
  onMessage,
}: {
  personId: number;
  aliases: VoiceAlias[];
  canManage: boolean;
  onAliasesChange: (aliases: VoiceAlias[]) => void;
  onMerged: () => void;
  onMessage: (message: string, tone: VoiceAliasMessageTone) => void;
}) {
  const { t } = useTranslation();
  const [aliasDraft, setAliasDraft] = useState("");
  const [candidates, setCandidates] = useState<VoiceAliasCandidate[]>([]);
  const [mergeReviews, setMergeReviews] = useState<VoiceMergeReview[]>([]);
  const [mergeTarget, setMergeTarget] = useState<VoiceAliasCandidate | null>(null);
  const [isSuggestOpen, setIsSuggestOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suggestRef = useRef<HTMLDivElement | null>(null);
  const shouldShowSuggestions = isSuggestOpen && candidates.length > 0 && candidates.length <= aliasSuggestMaxResults;

  const loadMergeReviews = async () => {
    if (!canManage) {
      setMergeReviews([]);
      return;
    }
    try {
      setMergeReviews(await api.listVoiceMergeReviews(personId));
    } catch {
      onMessage(t("creatorBrowse.mergeHistoryFailed"), "error");
    }
  };

  useEffect(() => {
    void loadMergeReviews();
  }, [canManage, personId]);

  useEffect(() => {
    if (!canManage) return;
    if (aliasDraft.trim().length < aliasSuggestMinChars) {
      setCandidates([]);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await api.listVoiceAliasCandidates(personId, aliasDraft);
          if (!controller.signal.aborted) setCandidates(next);
        } catch {
          if (!controller.signal.aborted) onMessage(t("creatorBrowse.aliasCandidateSearchFailed"), "error");
        }
      })();
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [aliasDraft, canManage, personId]);

  useEffect(() => {
    if (!isSuggestOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (suggestRef.current?.contains(event.target as Node)) return;
      setIsSuggestOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsSuggestOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isSuggestOpen]);

  const addAlias = async () => {
    if (!aliasDraft.trim()) return;
    try {
      const next = await api.createVoiceAlias(personId, aliasDraft);
      onAliasesChange(next);
      setAliasDraft("");
      onMessage(t("creatorBrowse.aliasSaved"), "success");
    } catch {
      onMessage(t("creatorBrowse.aliasSaveFailed"), "error");
    }
  };

  const deleteAlias = async (alias: VoiceAlias) => {
    try {
      const result = await api.deleteVoiceAlias(personId, alias.id);
      onAliasesChange(result.aliases);
      onMessage(result.deleted > 0 ? t("creatorBrowse.aliasDeleted") : t("creatorBrowse.primaryAliasKept"), "success");
    } catch {
      onMessage(t("creatorBrowse.aliasDeleteFailed"), "error");
    }
  };

  const mergeCandidate = async (candidate: VoiceAliasCandidate) => {
    try {
      const result = await api.mergeVoiceAliasCandidate(personId, candidate.personId);
      onMessage(t("creatorBrowse.aliasMerged", { merged: result.mergedName, target: result.targetName }), "success");
      onMerged();
      setCandidates((items) => items.filter((item) => item.personId !== candidate.personId));
      setMergeTarget(null);
      void loadMergeReviews();
    } catch {
      onMessage(t("creatorBrowse.aliasMergeFailed"), "error");
    }
  };

  const undoMerge = async (review: VoiceMergeReview) => {
    try {
      const result = await api.undoVoiceMerge(personId, review.id);
      onMessage(t("creatorBrowse.mergeRestored", { name: result.restoredName }), "success");
      onMerged();
      void loadMergeReviews();
    } catch {
      onMessage(t("creatorBrowse.mergeUndoFailed"), "error");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {aliases.length > 0 ? (
          aliases.map((alias) => (
            <Badge key={alias.id} variant={alias.source === "primary_name" ? "secondary" : "outline"} className="gap-1">
              {alias.alias}
              {canManage && alias.source !== "primary_name" && (
                <button
                  type="button"
                  className="rounded-sm hover:text-destructive"
                  aria-label={t("creatorBrowse.deleteAlias", { name: alias.alias })}
                  onClick={() => void deleteAlias(alias)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))
        ) : (
          <Badge variant="warning">{t("creatorBrowse.noAliases")}</Badge>
        )}
      </div>
      {canManage && (
        <>
          <div className="relative" ref={suggestRef}>
            <div className="flex gap-2">
              <div className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-3">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  ref={inputRef}
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  value={aliasDraft}
                  onKeyDown={dismissKeyboardOnEnter}
                  onChange={(event) => {
                    setAliasDraft(event.target.value);
                    setIsSuggestOpen(true);
                  }}
                  placeholder={t("creatorBrowse.aliasPlaceholder")}
                  aria-label={t("creatorBrowse.aliasPlaceholder")}
                />
              </div>
              <Button variant="outline" size="sm" onClick={() => void addAlias()}>
                <Plus className="h-4 w-4" /> {t("creatorBrowse.add")}
              </Button>
            </div>
            {shouldShowSuggestions && (
              <div className="app-scroll absolute left-0 right-0 top-11 z-30 max-h-72 overflow-auto rounded-md border bg-popover p-1 shadow-lg">
                {candidates.slice(0, aliasSuggestMaxResults).map((candidate) => (
                  <button
                    key={candidate.personId}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-sm px-3 py-2 text-left text-sm hover:bg-muted"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setAliasDraft(candidate.displayName);
                      setIsSuggestOpen(false);
                      inputRef.current?.focus();
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{candidate.displayName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t("creatorBrowse.worksCount", { count: candidate.knownWorks })} ·{" "}
                        {candidateAliasSummary(candidate) || t("creatorBrowse.noExtraAliases")}
                      </span>
                    </span>
                    <GitMerge className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            )}
          </div>
          {aliasDraft.trim().length >= aliasSuggestMinChars && candidates.length > aliasSuggestMaxResults && (
            <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
              {t("creatorBrowse.tooManyMatches")}
            </div>
          )}
          {candidates.length > 0 && candidates.length <= aliasSuggestMaxResults && (
            <div className="space-y-2">
              {candidates.slice(0, 4).map((candidate) => (
                <div
                  key={candidate.personId}
                  className="flex items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{candidate.displayName}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t("creatorBrowse.worksCount", { count: candidate.knownWorks })} ·{" "}
                      {candidateAliasSummary(candidate) || t("creatorBrowse.noExtraAliases")}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setMergeTarget(candidate)}>
                    <GitMerge className="h-4 w-4" />
                    {t("creatorBrowse.merge")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {mergeReviews.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <div className="text-sm font-medium">{t("creatorBrowse.mergeHistory")}</div>
          {mergeReviews.slice(0, 4).map((review) => (
            <div
              key={review.id}
              className="flex items-center justify-between gap-3 rounded-md border bg-background p-3 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{review.sourceName}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {review.status === "undone" ? t("creatorBrowse.undone") : t("creatorBrowse.merged")} ·{" "}
                  {review.createdAt}
                </div>
              </div>
              {canManage && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={review.status !== "merged"}
                  onClick={() => void undoMerge(review)}
                >
                  {t("creatorBrowse.undo")}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {mergeTarget && (
        <Dialog onClose={() => setMergeTarget(null)} layer="overlay-top" size="sm">
          <DialogHeader
            title={t("creatorBrowse.mergeVoiceActor")}
            description={t("creatorBrowse.mergeVoiceActorDescription", { name: mergeTarget.displayName })}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setMergeTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" onClick={() => void mergeCandidate(mergeTarget)}>
              {t("creatorBrowse.merge")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function candidateAliasSummary(candidate: VoiceAliasCandidate) {
  return [
    ...new Set(candidate.aliases.map((alias) => alias.alias).filter((alias) => alias !== candidate.displayName)),
  ].join(", ");
}
