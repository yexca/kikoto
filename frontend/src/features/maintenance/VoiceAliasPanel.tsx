import { ArrowRight, CornerDownLeft, GitMerge, Plus, Search, Undo2, X } from "lucide-react";
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { formatDateTime } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type VoiceAlias, type VoiceAliasCandidate, type VoiceMergeReview } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

const aliasSuggestMinChars = 2;
const aliasSuggestMaxResults = 12;
const mergeHistoryPreview = 4;
const mergedAliasSources = new Set(["merged_name", "merged_primary_name", "merged_alias"]);

export type VoiceAliasMessageTone = "success" | "error";

type CandidateResult = { query: string; items: VoiceAliasCandidate[] };

/**
 * Alias review for one voice actor: the confirmed alias chips, one field that
 * either adds its text as an alias or merges a matching duplicate person, and
 * the undoable merge history. The host decides where feedback goes and how the
 * surrounding record is refreshed.
 */
export function VoiceAliasPanel({
  personId,
  personName,
  aliases,
  canManage,
  readOnly = false,
  onAliasesChange,
  onMerged,
  onMessage,
}: {
  personId: number;
  personName: string;
  aliases: VoiceAlias[];
  canManage: boolean;
  /** Demo shows the merge history read-only; undo and edits still require canManage. */
  readOnly?: boolean;
  onAliasesChange: (aliases: VoiceAlias[]) => void;
  onMerged: () => void;
  onMessage: (message: string, tone: VoiceAliasMessageTone) => void;
}) {
  const { t } = useTranslation();
  const [aliasDraft, setAliasDraft] = useState("");
  const [candidateResult, setCandidateResult] = useState<CandidateResult | null>(null);
  const [mergeReviews, setMergeReviews] = useState<VoiceMergeReview[]>([]);
  const [showAllReviews, setShowAllReviews] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<VoiceAliasCandidate | null>(null);
  const [pending, setPending] = useState(false);
  const aliasesLabelId = useId();
  const historyLabelId = useId();

  const draft = aliasDraft.trim();
  const searching = canManage && draft.length >= aliasSuggestMinChars;
  const candidates = candidateResult?.query === draft ? candidateResult.items : null;
  const existingAlias = aliases.find((alias) => alias.alias.toLowerCase() === draft.toLowerCase());

  const loadMergeReviews = async () => {
    if (!canManage && !readOnly) {
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
  }, [canManage, personId, readOnly]);

  useEffect(() => {
    if (!searching) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          const items = await api.listVoiceAliasCandidates(personId, draft);
          if (!controller.signal.aborted) setCandidateResult({ query: draft, items });
        } catch {
          if (controller.signal.aborted) return;
          setCandidateResult({ query: draft, items: [] });
          onMessage(t("creatorBrowse.aliasCandidateSearchFailed"), "error");
        }
      })();
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [draft, personId, searching]);

  const addAlias = async () => {
    if (!draft || existingAlias || pending) return;
    setPending(true);
    try {
      const next = await api.createVoiceAlias(personId, draft);
      onAliasesChange(next);
      setAliasDraft("");
      onMessage(t("creatorBrowse.aliasSaved"), "success");
    } catch {
      onMessage(t("creatorBrowse.aliasSaveFailed"), "error");
    } finally {
      setPending(false);
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
    setPending(true);
    try {
      const result = await api.mergeVoiceAliasCandidate(personId, candidate.personId);
      onMessage(t("creatorBrowse.aliasMerged", { merged: result.mergedName, target: result.targetName }), "success");
      onMerged();
      setCandidateResult((current) =>
        current ? { ...current, items: current.items.filter((item) => item.personId !== candidate.personId) } : current,
      );
      setMergeTarget(null);
      void loadMergeReviews();
    } catch {
      onMessage(t("creatorBrowse.aliasMergeFailed"), "error");
    } finally {
      setPending(false);
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

  const handleDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void addAlias();
  };

  const hasHiddenReviews = mergeReviews.length > mergeHistoryPreview;
  const visibleReviews = showAllReviews ? mergeReviews : mergeReviews.slice(0, mergeHistoryPreview);

  return (
    <div className="space-y-5">
      <section aria-labelledby={aliasesLabelId} className="space-y-2.5">
        <SectionLabel id={aliasesLabelId}>{t("creatorBrowse.aliasesTitle")}</SectionLabel>
        {aliases.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {aliases.map((alias) => (
              <AliasChip key={alias.id} alias={alias} canDelete={canManage} onDelete={() => void deleteAlias(alias)} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("creatorBrowse.noAliases")}</p>
        )}
        {canManage && (
          <div className="overflow-hidden rounded-md border bg-background focus-within:border-ring">
            <div className="flex h-10 items-center gap-2 px-3">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                value={aliasDraft}
                onKeyDown={handleDraftKeyDown}
                onChange={(event) => setAliasDraft(event.target.value)}
                placeholder={t("creatorBrowse.aliasPlaceholder")}
                aria-label={t("creatorBrowse.aliasPlaceholder")}
              />
              {aliasDraft && (
                <button
                  type="button"
                  className="-mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={t("unlinked.clearSearch")}
                  title={t("unlinked.clearSearch")}
                  onClick={() => setAliasDraft("")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {draft && (
              <div className="border-t">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 disabled:pointer-events-none disabled:text-muted-foreground"
                  disabled={Boolean(existingAlias) || pending}
                  onClick={() => void addAlias()}
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground">
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {existingAlias
                      ? t("creatorBrowse.aliasExists", { name: existingAlias.alias })
                      : t("creatorBrowse.addAsAlias", { name: draft })}
                  </span>
                  {!existingAlias && (
                    <CornerDownLeft
                      className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground sm:block"
                      aria-hidden="true"
                    />
                  )}
                </button>
                {searching && (
                  <CandidateList candidates={candidates} onMerge={(candidate) => setMergeTarget(candidate)} />
                )}
              </div>
            )}
          </div>
        )}
      </section>
      {mergeReviews.length > 0 && (
        <section aria-labelledby={historyLabelId} className="space-y-2.5">
          <SectionLabel id={historyLabelId}>{t("creatorBrowse.mergeHistory")}</SectionLabel>
          <ul className="divide-y rounded-md border">
            {visibleReviews.map((review) => (
              <MergeReviewRow
                key={review.id}
                review={review}
                canUndo={canManage}
                onUndo={() => void undoMerge(review)}
              />
            ))}
          </ul>
          {hasHiddenReviews && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setShowAllReviews((current) => !current)}
            >
              {showAllReviews
                ? t("creatorBrowse.showLessMergeHistory")
                : t("creatorBrowse.showAllMergeHistory", { count: mergeReviews.length })}
            </Button>
          )}
        </section>
      )}
      {mergeTarget && (
        <MergeConfirmDialog
          candidate={mergeTarget}
          targetName={personName}
          pending={pending}
          onCancel={() => setMergeTarget(null)}
          onConfirm={() => void mergeCandidate(mergeTarget)}
        />
      )}
    </div>
  );
}

function SectionLabel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h4 id={id} className="text-xs font-medium text-muted-foreground">
      {children}
    </h4>
  );
}

function AliasChip({ alias, canDelete, onDelete }: { alias: VoiceAlias; canDelete: boolean; onDelete: () => void }) {
  const { t } = useTranslation();
  const primary = alias.source === "primary_name";
  const merged = mergedAliasSources.has(alias.source);
  return (
    <li
      className={cn(
        "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs",
        primary ? "border-transparent bg-secondary font-medium text-secondary-foreground" : "bg-background",
      )}
    >
      {merged && (
        <span className="inline-flex shrink-0 text-muted-foreground" title={t("creatorBrowse.mergedAlias")}>
          <GitMerge className="h-3 w-3" aria-hidden="true" />
          <span className="sr-only">{t("creatorBrowse.mergedAlias")}</span>
        </span>
      )}
      <span className="truncate">{alias.alias}</span>
      {primary && <span className="shrink-0 text-[10px] text-muted-foreground">{t("creatorBrowse.primaryName")}</span>}
      {canDelete && !primary && (
        <button
          type="button"
          className="-mr-1 grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("creatorBrowse.deleteAlias", { name: alias.alias })}
          title={t("creatorBrowse.deleteAlias", { name: alias.alias })}
          onClick={onDelete}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </li>
  );
}

function CandidateList({
  candidates,
  onMerge,
}: {
  candidates: VoiceAliasCandidate[] | null;
  onMerge: (candidate: VoiceAliasCandidate) => void;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const tooManyCandidates = candidates !== null && candidates.length > aliasSuggestMaxResults;
  return (
    <div className="border-t">
      <div id={labelId} className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
        {t("creatorBrowse.duplicateCandidates")}
      </div>
      {candidates === null ? (
        <div className="space-y-2 px-3 pb-3 pt-1" role="status" aria-label={t("common.loading")} aria-busy="true">
          <div className="h-3 w-2/5 animate-pulse rounded bg-muted" />
          <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
        </div>
      ) : tooManyCandidates ? (
        <p className="px-3 pb-2.5 text-xs text-muted-foreground">{t("creatorBrowse.tooManyMatches")}</p>
      ) : candidates.length === 0 ? (
        <p className="px-3 pb-2.5 text-xs text-muted-foreground">{t("creatorBrowse.noDuplicateCandidates")}</p>
      ) : (
        <ul aria-labelledby={labelId} className="app-scrollbar max-h-64 overflow-y-auto pb-1">
          {candidates.map((candidate) => (
            <li key={candidate.personId} className="flex items-center gap-3 px-3 py-1.5">
              <PersonInitial name={candidate.displayName} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{candidate.displayName}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {[t("creatorBrowse.worksCount", { count: candidate.knownWorks }), candidateAliasSummary(candidate)]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                aria-label={t("creatorBrowse.mergeCandidate", { name: candidate.displayName })}
                onClick={() => onMerge(candidate)}
              >
                <GitMerge className="h-3.5 w-3.5" />
                {t("creatorBrowse.merge")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MergeReviewRow({
  review,
  canUndo,
  onUndo,
}: {
  review: VoiceMergeReview;
  canUndo: boolean;
  onUndo: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const undone = review.status !== "merged";
  const time = formatDateTime(serverTimestamp(review.createdAt), resolvedLocale) || review.createdAt;
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <GitMerge className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm", undone ? "text-muted-foreground" : "font-medium")}>
          {review.sourceName}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {undone ? t("creatorBrowse.undone") : t("creatorBrowse.merged")} · {time}
        </div>
      </div>
      {canUndo && !undone && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          aria-label={t("creatorBrowse.undoMergeOf", { name: review.sourceName })}
          onClick={onUndo}
        >
          <Undo2 className="h-3.5 w-3.5" />
          {t("creatorBrowse.undo")}
        </Button>
      )}
    </li>
  );
}

function MergeConfirmDialog({
  candidate,
  targetName,
  pending,
  onCancel,
  onConfirm,
}: {
  candidate: VoiceAliasCandidate;
  targetName: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog onClose={onCancel} layer="overlay-top" size="sm">
      <DialogHeader
        title={t("creatorBrowse.mergeVoiceActor")}
        description={t("creatorBrowse.mergeVoiceActorDescription", { name: candidate.displayName, target: targetName })}
      />
      <DialogBody>
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{candidate.displayName}</div>
            <div className="text-xs text-muted-foreground">
              {t("creatorBrowse.worksCount", { count: candidate.knownWorks })}
            </div>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-right">
            <div className="truncate font-medium">{targetName}</div>
            <div className="text-xs text-muted-foreground">{t("creatorBrowse.mergeKept")}</div>
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" disabled={pending} onClick={onConfirm}>
          <GitMerge className="h-3.5 w-3.5" />
          {t("creatorBrowse.merge")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function PersonInitial({ name }: { name: string }) {
  return (
    <span
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground"
      aria-hidden="true"
    >
      {Array.from(name.trim())[0] ?? "?"}
    </span>
  );
}

function candidateAliasSummary(candidate: VoiceAliasCandidate) {
  return [
    ...new Set(candidate.aliases.map((alias) => alias.alias).filter((alias) => alias !== candidate.displayName)),
  ].join(", ");
}

// Review timestamps are SQLite CURRENT_TIMESTAMP values: UTC without a zone.
function serverTimestamp(value: string) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
}
