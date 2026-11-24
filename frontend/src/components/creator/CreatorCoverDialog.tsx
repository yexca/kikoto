import { Check, ImageOff, Loader2, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { useStableCallback } from "@/hooks/useStableCallback";
import { assetURL } from "@/lib/api";
import type { CreatorCover, CreatorLatestWork } from "@/lib/creatorApi";
import { startLoad } from "@/lib/effectScope";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { cn } from "@/lib/tailwindClassNames";

export type CreatorCoverWork = {
  primaryCode: string;
  title: string;
  coverUrl: string;
};

export type CreatorCoverWorksRequest = {
  page: number;
  pageSize: number;
  query: string;
  signal: AbortSignal;
};

const coverWorksPageSize = 24;

/**
 * Chooses the cover of a circle or voice actor from their works. The first
 * choice restores the latest work's cover, which follows each new release.
 */
export function CreatorCoverDialog({
  name,
  cover,
  latestWork,
  loadWorks,
  onSelect,
  onClose,
}: {
  name: string;
  cover: CreatorCover | null;
  latestWork: CreatorLatestWork | null;
  /** One page of the creator's works; `total` counts every work that matches the query. */
  loadWorks: (request: CreatorCoverWorksRequest) => Promise<{ works: CreatorCoverWork[]; total: number }>;
  /** Saves the chosen work; an empty code restores the latest work's cover. */
  onSelect: (primaryCode: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const load = useStableCallback(loadWorks);
  const [query, setQuery] = useState("");
  const [request, setRequest] = useState({ query: "", page: 1, attempt: 0 });
  const [works, setWorks] = useState<CreatorCoverWork[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [saving, setSaving] = useState(false);
  const chosenCode = cover?.custom ? cover.primaryCode.toUpperCase() : "";

  useEffect(() => {
    const next = query.trim();
    if (next === request.query) return;
    const timer = window.setTimeout(() => setRequest((current) => ({ ...current, query: next, page: 1 })), 250);
    return () => window.clearTimeout(timer);
  }, [query, request.query]);

  useEffect(() => {
    setStatus("loading");
    return startLoad(
      (signal) => load({ page: request.page, pageSize: coverWorksPageSize, query: request.query, signal }),
      {
        onSuccess: (result) => {
          setWorks((current) => appendCoverWorks(request.page === 1 ? [] : current, result.works));
          setTotal(result.total);
          setStatus("ready");
        },
        onError: () => setStatus("failed"),
      },
    );
  }, [load, request]);

  const select = async (primaryCode: string) => {
    if (saving) return;
    if (primaryCode.toUpperCase() === chosenCode) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await onSelect(primaryCode);
    } finally {
      setSaving(false);
    }
  };

  const hasMore = status === "ready" && request.page * coverWorksPageSize < total;

  return (
    <Dialog onClose={onClose} size="xl">
      <DialogHeader
        title={t("creator.coverTitle")}
        description={t("creator.coverDescription", { name })}
        onClose={onClose}
        closeLabel={t("creator.coverClose")}
      />
      <DialogBody className="space-y-3">
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-3 rounded-lg border bg-card p-2 text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
            !chosenCode && "border-primary",
          )}
          aria-pressed={!chosenCode}
          disabled={saving}
          onClick={() => void select("")}
        >
          <span className="block w-20 shrink-0 overflow-hidden rounded-md">
            <CoverImage url={latestWork?.coverUrl ?? ""} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t("creator.coverLatest")}</span>
            <span className="block text-xs text-muted-foreground">{t("creator.coverLatestHint")}</span>
          </span>
          {!chosenCode && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
        </button>

        <div className="search-field flex min-h-10 items-center gap-2 rounded-lg border bg-card px-3 text-sm">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            value={query}
            onKeyDown={dismissKeyboardOnEnter}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("creator.coverSearch")}
            aria-label={t("creator.coverSearch")}
          />
          {query.trim() && (
            <button
              type="button"
              className="rounded-sm text-muted-foreground hover:text-foreground"
              onClick={() => setQuery("")}
              aria-label={t("collection.clearSearch")}
              title={t("collection.clearSearch")}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div
          className="grid grid-cols-3 gap-2 sm:grid-cols-4"
          role="group"
          aria-label={t("creator.coverWorks")}
          aria-busy={status === "loading"}
        >
          {works.map((work) => {
            const chosen = work.primaryCode.toUpperCase() === chosenCode;
            const label = t("creator.coverUse", { code: work.primaryCode, title: work.title });
            return (
              <button
                key={work.primaryCode}
                type="button"
                className={cn(
                  "relative overflow-hidden rounded-lg border bg-card text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                  chosen && "border-primary",
                )}
                aria-label={label}
                aria-pressed={chosen}
                title={label}
                disabled={saving || !work.coverUrl}
                onClick={() => void select(work.primaryCode)}
              >
                <CoverImage url={work.coverUrl} />
                <span className="block truncate px-1.5 py-1 text-xs text-muted-foreground">{work.title}</span>
                {chosen && (
                  <span
                    className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground"
                    aria-hidden="true"
                  >
                    <Check className="h-3 w-3" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {status === "loading" && (
          <p className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t("creator.coverLoading")}
          </p>
        )}
        {status === "ready" && works.length === 0 && (
          <p className="py-2 text-center text-sm text-muted-foreground">{t("creator.coverNoWorks")}</p>
        )}
        {status === "failed" && (
          <div className="flex items-center justify-center gap-3 py-2 text-sm text-muted-foreground" role="alert">
            <span>{t("creator.coverLoadFailed")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRequest((current) => ({ ...current, attempt: current.attempt + 1 }))}
            >
              {t("creatorBrowse.retry")}
            </Button>
          </div>
        )}
        {hasMore && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRequest((current) => ({ ...current, page: current.page + 1 }))}
            >
              {t("creator.coverLoadMore")}
            </Button>
          </div>
        )}
      </DialogBody>
    </Dialog>
  );
}

function CoverImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed) {
    return (
      <span className="flex aspect-[4/3] w-full items-center justify-center bg-secondary text-secondary-foreground">
        <ImageOff className="h-5 w-5 opacity-60" aria-hidden="true" />
      </span>
    );
  }
  return (
    <img
      src={assetURL(url)}
      alt=""
      className="aspect-[4/3] w-full object-cover"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/** A work listed once per source keeps one entry, preferring one that has a cover. */
function appendCoverWorks(current: CreatorCoverWork[], added: CreatorCoverWork[]) {
  const works = [...current];
  const indexes = new Map(works.map((work, index) => [work.primaryCode.toUpperCase(), index]));
  for (const work of added) {
    const key = work.primaryCode.toUpperCase();
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, works.length);
      works.push(work);
    } else if (!works[index].coverUrl && work.coverUrl) {
      works[index] = work;
    }
  }
  return works;
}
