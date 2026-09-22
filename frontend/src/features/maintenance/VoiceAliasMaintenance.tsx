import { Inbox, Search, Tags } from "lucide-react";
import { useEffect, useMemo, useState, type MouseEventHandler } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { CatalogSyncBadge } from "@/components/creator/CatalogSyncBadge";
import { formatNumber } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, assetURL, type VoiceAlias, type VoiceSummary, type VoiceSummaryPage } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { MaintenancePager, MaintenanceSearchForm } from "./MaintenanceControls";
import { VoiceAliasPanel } from "./VoiceAliasPanel";

const PAGE_SIZES = [25, 50] as const;
const VOICE_PARAM = "voice";

function requestedVoiceId() {
  const value = Number(new URLSearchParams(window.location.search).get(VOICE_PARAM));
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Metadata view for voice actor identity: a searchable table of known people
 * with their confirmed aliases, and a dialog that reviews aliases and merges
 * duplicates for one person. `?voice=<id>` opens that person's dialog directly.
 */
export function VoiceAliasMaintenance({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(25);
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [result, setResult] = useState<VoiceSummaryPage>({
    voices: [],
    page: 1,
    pageSize: 25,
    total: 0,
    tagOptions: [],
  });
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [managedId, setManagedId] = useState<number | null>(requestedVoiceId);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const next = await api.listVoices({ page, pageSize, query, signal: controller.signal });
        if (controller.signal.aborted) return;
        if (next.voices.length === 0 && page > 1 && next.total <= (page - 1) * pageSize) {
          setPage(Math.max(1, Math.ceil(next.total / pageSize)));
          return;
        }
        setResult(next);
        setHasLoaded(true);
        setLoadError("");
      } catch {
        if (!controller.signal.aborted) setLoadError(t("errors.unavailable"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [page, pageSize, query, refreshKey, t]);

  const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
  const initialLoading = loading && !hasLoaded;

  const openVoice = (personId: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set(VOICE_PARAM, String(personId));
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    setManagedId(personId);
  };
  const closeVoice = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete(VOICE_PARAM);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    setManagedId(null);
  };
  const navigateVoice: MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState({}, "", event.currentTarget.getAttribute("href"));
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };
  const updateVoiceAliases = (personId: number, aliases: VoiceAlias[]) => {
    setResult((current) => ({
      ...current,
      voices: current.voices.map((voice) =>
        voice.personId === personId ? { ...voice, aliases: aliases.map((alias) => alias.alias) } : voice,
      ),
    }));
  };

  return (
    <section
      id="metadata-aliases"
      aria-label={t("workManagement.voiceAliasesTitle")}
      className="overflow-hidden rounded-lg border bg-card"
    >
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="truncate text-base font-semibold">{t("workManagement.voiceAliasesTitle")}</h2>
          <span className="text-sm tabular-nums text-muted-foreground">
            {formatNumber(result.total, resolvedLocale)}
          </span>
        </div>
        <MaintenanceSearchForm
          value={queryDraft}
          label={t("workManagement.searchVoices")}
          placeholder={t("workManagement.searchVoicesPlaceholder")}
          loading={loading}
          onChange={setQueryDraft}
          onSubmit={() => {
            setPage(1);
            setQuery(queryDraft.trim());
          }}
          onClear={() => {
            setQueryDraft("");
            setQuery("");
            setPage(1);
          }}
          onRefresh={() => setRefreshKey((current) => current + 1)}
        />
      </div>
      <p className="border-y bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        {t("workManagement.voiceAliasesDescription")}
      </p>
      <div className="min-h-64">
        {loadError && hasLoaded && (
          <div
            className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-error-border bg-error-surface px-4 py-2"
            role="alert"
          >
            <span className="text-sm text-error-foreground">
              {loadError} {t("unlinked.existingResultsShown")}
            </span>
            <Button size="sm" variant="outline" onClick={() => setRefreshKey((current) => current + 1)}>
              {t("common.retry")}
            </Button>
          </div>
        )}
        {!hasLoaded && loadError ? (
          <div className="grid min-h-64 place-items-center px-4 py-10 text-center" role="alert">
            <div>
              <p className="text-sm text-error-foreground">{loadError}</p>
              <Button
                className="mt-4"
                size="sm"
                variant="outline"
                onClick={() => setRefreshKey((current) => current + 1)}
              >
                {t("common.retry")}
              </Button>
            </div>
          </div>
        ) : initialLoading ? (
          <VoiceAliasTableSkeleton />
        ) : result.voices.length === 0 ? (
          <div className="grid min-h-64 place-items-center px-6 py-10 text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
                {query ? <Search className="h-4 w-4" /> : <Inbox className="h-4 w-4" />}
              </div>
              <p className="text-sm font-medium">
                {query ? t("workManagement.noMatchingVoices") : t("creatorBrowse.noVoiceCredits")}
              </p>
              {query && (
                <Button
                  className="mt-4"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setQueryDraft("");
                    setQuery("");
                    setPage(1);
                  }}
                >
                  {t("unlinked.clearSearch")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <table className="w-full table-fixed text-left text-sm" aria-busy={loading}>
            <VoiceAliasTableHead />
            <tbody className="divide-y">
              {result.voices.map((voice) => (
                <VoiceAliasRow
                  key={voice.personId}
                  voice={voice}
                  onNavigate={navigateVoice}
                  onManage={() => openVoice(voice.personId)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
      <MaintenancePager
        page={page}
        totalPages={totalPages}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZES}
        loading={loading}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size as (typeof PAGE_SIZES)[number]);
          setPage(1);
        }}
      />
      {managedId !== null && (
        <VoiceAliasDialog
          personId={managedId}
          canManage={canManage}
          onClose={closeVoice}
          onAliasesChange={(aliases) => updateVoiceAliases(managedId, aliases)}
          onMerged={() => setRefreshKey((current) => current + 1)}
          onMessage={(message, tone) => (tone === "error" ? toast.error(message) : toast.success(message))}
        />
      )}
    </section>
  );
}

function VoiceAliasRow({
  voice,
  onNavigate,
  onManage,
}: {
  voice: VoiceSummary;
  onNavigate: MouseEventHandler<HTMLAnchorElement>;
  onManage: () => void;
}) {
  const { t } = useTranslation();
  const aliases = useMemo(
    () => [...new Set(voice.aliases.filter((alias) => alias.trim() && alias !== voice.displayName))],
    [voice.aliases, voice.displayName],
  );
  const href = `/voices/${voice.personId}`;
  const coverUrl = voice.latestWork?.coverUrl;
  const initial = Array.from(voice.displayName.trim())[0] ?? "?";
  return (
    <tr className="group transition-colors hover:bg-muted/30">
      <td className="min-w-0 py-2.5 pl-4 align-top">
        <div className="flex min-w-0 gap-3">
          <div
            className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary ring-1 ring-foreground/5"
            aria-hidden="true"
          >
            {coverUrl ? (
              <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <span className="text-lg font-semibold text-secondary-foreground">{initial}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <a
                onClick={onNavigate}
                href={href}
                className="truncate font-medium transition-colors hover:text-primary"
                title={voice.displayName}
              >
                {voice.displayName}
              </a>
              <span className="font-mono text-xs text-muted-foreground">#{voice.personId}</span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              {aliases.length > 0 ? (
                aliases.map((alias) => (
                  <Badge key={alias} variant="outline" className="max-w-full truncate px-1.5 py-0 text-[11px]">
                    {alias}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">{t("creatorBrowse.noAliases")}</span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{t("creator.works", { count: voice.knownWorks })}</span>
              <CatalogSyncBadge state={voice.syncState} appearance="dot" />
            </div>
          </div>
        </div>
      </td>
      <td className="py-2.5 pr-1 align-top sm:pr-3">
        <div className="flex justify-end sm:mt-1.5">
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground max-sm:h-11 max-sm:w-11"
            onClick={onManage}
            aria-label={t("workManagement.manageAliasesFor", { name: voice.displayName })}
            title={t("workManagement.manageAliases")}
          >
            <Tags className="h-4 w-4" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

function VoiceAliasDialog({
  personId,
  canManage,
  onClose,
  onAliasesChange,
  onMerged,
  onMessage,
}: {
  personId: number;
  canManage: boolean;
  onClose: () => void;
  onAliasesChange: (aliases: VoiceAlias[]) => void;
  onMerged: () => void;
  onMessage: (message: string, tone: "success" | "error") => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState<VoiceAlias[] | null>(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const detail = await api.getVoiceSummary(personId, controller.signal);
        if (controller.signal.aborted) return;
        setName(detail.displayName);
        setAliases(detail.aliasRecords ?? []);
        setError("");
      } catch {
        if (!controller.signal.aborted) setError(t("errors.unavailable"));
      }
    })();
    return () => controller.abort();
  }, [personId, reloadKey, t]);

  return (
    <Dialog onClose={onClose} size="lg" ariaLabel={name || t("workManagement.manageAliases")}>
      <DialogHeader
        title={name || t("workManagement.manageAliases")}
        description={t("creatorBrowse.aliasesDescription")}
        icon={<Tags className="h-4 w-4" />}
        onClose={onClose}
        closeLabel={t("common.close")}
      />
      <DialogBody>
        {error ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm" role="alert">
            <span className="text-error-foreground">{error}</span>
            <Button size="sm" variant="outline" onClick={() => setReloadKey((current) => current + 1)}>
              {t("common.retry")}
            </Button>
          </div>
        ) : aliases === null ? (
          <div className="space-y-2" role="status" aria-label={t("common.loading")} aria-busy="true">
            <div className="h-5 w-40 animate-pulse rounded bg-muted" />
            <div className="h-9 w-full animate-pulse rounded bg-muted" />
          </div>
        ) : (
          <VoiceAliasPanel
            personId={personId}
            aliases={aliases}
            canManage={canManage}
            onAliasesChange={(next) => {
              setAliases(next);
              onAliasesChange(next);
            }}
            onMerged={() => {
              setReloadKey((current) => current + 1);
              onMerged();
            }}
            onMessage={onMessage}
          />
        )}
      </DialogBody>
    </Dialog>
  );
}

function VoiceAliasTableSkeleton() {
  const { t } = useTranslation();
  return (
    <table
      className="w-full table-fixed text-left text-sm"
      role="status"
      aria-label={t("creatorBrowse.loadingVoices")}
      aria-busy="true"
    >
      <VoiceAliasTableHead />
      <tbody className="divide-y" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => (
          <tr key={index}>
            <td className="py-2.5 pl-4">
              <div className="flex gap-3">
                <div className="h-12 w-12 shrink-0 animate-pulse rounded-md bg-muted" />
                <div className="min-w-0 flex-1 space-y-2 pt-1">
                  <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                  <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted" />
                  <div className="h-2.5 w-20 animate-pulse rounded bg-muted" />
                </div>
              </div>
            </td>
            <td className="py-2.5 pr-3">
              <div className="ml-auto mt-1.5 h-8 w-8 animate-pulse rounded-md bg-muted" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VoiceAliasTableHead() {
  const { t } = useTranslation();
  return (
    <>
      <colgroup>
        <col />
        <col className="w-12 sm:w-20" />
      </colgroup>
      <thead className="sr-only">
        <tr>
          <th>{t("creatorBrowse.voiceActor")}</th>
          <th>{t("unlinked.actions")}</th>
        </tr>
      </thead>
    </>
  );
}
