import { Inbox, Search, Tags } from "lucide-react";
import { useEffect, useMemo, useState, type MouseEventHandler } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { CatalogSyncBadge } from "@/components/creator/CatalogSyncBadge";
import { CollectionPagination } from "@/components/collection/CollectionPagination";
import { api, type VoiceAlias, type VoiceSummary, type VoiceSummaryPage } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { MaintenanceToolbar, useMaintenanceSearch, type MaintenanceToolbarSlots } from "./MaintenanceControls";
import { MetadataEntryCover } from "./MetadataEntryCover";
import {
  MetadataActionsCell,
  MetadataActionsHeader,
  MetadataManageButton,
  metadataBodyClassName,
  metadataHeadClassName,
  metadataRowClassName,
  metadataTableClassName,
} from "./MetadataEntryTable";
import { VoiceAliasPanel } from "./VoiceAliasPanel";

const PAGE_SIZES = [25, 50] as const;
const VOICE_PARAM = "voice";

function requestedVoiceId() {
  const value = Number(new URLSearchParams(window.location.search).get(VOICE_PARAM));
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Metadata view for voice actor identity: a searchable table of known people
 * keyed by Kikoto person id, one column per fact, and a dialog that reviews
 * aliases and merges duplicates for one person. `?voice=<id>` opens that
 * person's dialog directly.
 */
export function VoiceAliasMaintenance({
  canManage,
  readOnly = false,
  toolbar,
}: {
  canManage: boolean;
  readOnly?: boolean;
  toolbar: MaintenanceToolbarSlots;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(25);
  const search = useMaintenanceSearch(() => setPage(1));
  const query = search.query;
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
        const next = await api.listVoices({ page, pageSize, query, sort: "id", signal: controller.signal });
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

  const paginationProps = {
    page,
    pageSize,
    totalItems: result.total,
    totalPages,
    itemLabel: t("creatorBrowse.voiceActors"),
    ariaLabel: t("creatorBrowse.voicePages"),
    onPageChange: setPage,
  };

  return (
    <div className="min-w-0 space-y-3">
      <MaintenanceToolbar
        slots={toolbar}
        query={search.draft}
        label={t("workManagement.searchVoices")}
        placeholder={t("workManagement.searchVoicesPlaceholder")}
        loading={loading}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZES}
        onQueryChange={search.setDraft}
        onQueryCommit={search.commit}
        onClear={search.clear}
        onRefresh={() => setRefreshKey((current) => current + 1)}
        onPageSizeChange={(size) => {
          setPageSize(size as (typeof PAGE_SIZES)[number]);
          setPage(1);
        }}
      />
      {(hasLoaded || !loadError) && (
        <CollectionPagination {...paginationProps} placement="top" compactMobile compactTop />
      )}
      <section
        id="metadata-aliases"
        aria-label={t("workManagement.voiceAliasesTitle")}
        className="overflow-hidden rounded-lg border bg-card"
      >
        <p className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
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
                  <Button className="mt-4" size="sm" variant="outline" onClick={search.clear}>
                    {t("unlinked.clearSearch")}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className={metadataTableClassName} aria-busy={loading}>
                <VoiceAliasTableHead />
                <tbody className={metadataBodyClassName}>
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
            </div>
          )}
        </div>
      </section>
      <CollectionPagination {...paginationProps} placement="bottom" />
      {managedId !== null && (
        <VoiceAliasDialog
          personId={managedId}
          canManage={canManage}
          readOnly={readOnly}
          onClose={closeVoice}
          onAliasesChange={(aliases) => updateVoiceAliases(managedId, aliases)}
          onMerged={() => setRefreshKey((current) => current + 1)}
          onMessage={(message, tone) => (tone === "error" ? toast.error(message) : toast.success(message))}
        />
      )}
    </div>
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
  return (
    <tr className={`${metadataRowClassName} align-middle`}>
      <th scope="row" className="whitespace-nowrap py-2 pl-4 pr-3 font-medium tabular-nums">
        {`#${voice.personId}`}
      </th>
      <td className="px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <MetadataEntryCover url={voice.latestWork?.coverUrl} name={voice.displayName} />
          <a
            onClick={onNavigate}
            href={`/voices/${voice.personId}`}
            className="min-w-0 font-medium transition-colors hover:text-primary"
          >
            {voice.displayName}
          </a>
        </div>
      </td>
      <td className="px-3 py-2">
        {aliases.length > 0 ? (
          <div className="flex min-w-0 flex-wrap gap-1">
            {aliases.map((alias) => (
              <Badge key={alias} variant="outline" className="max-w-full truncate px-1.5 py-0 text-[11px]">
                {alias}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground/60">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{voice.knownWorks}</td>
      <td className="px-3 py-2">
        <CatalogSyncBadge state={voice.syncState} appearance="dot" />
      </td>
      <MetadataActionsCell>
        <MetadataManageButton
          label={t("workManagement.manageAliasesFor", { name: voice.displayName })}
          onClick={onManage}
        />
      </MetadataActionsCell>
    </tr>
  );
}

function VoiceAliasDialog({
  personId,
  canManage,
  readOnly,
  onClose,
  onAliasesChange,
  onMerged,
  onMessage,
}: {
  personId: number;
  canManage: boolean;
  readOnly: boolean;
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
            personName={name}
            aliases={aliases}
            canManage={canManage}
            readOnly={readOnly}
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
      className={metadataTableClassName}
      role="status"
      aria-label={t("creatorBrowse.loadingVoices")}
      aria-busy="true"
    >
      <VoiceAliasTableHead />
      <tbody className={metadataBodyClassName} aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => (
          <tr key={index}>
            <td className="py-3 pl-4 pr-3">
              <div className="h-3 w-8 animate-pulse rounded bg-muted" />
            </td>
            <td className="px-3 py-2">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 shrink-0 animate-pulse rounded-md bg-muted" />
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              </div>
            </td>
            <td className="px-3 py-3">
              <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            </td>
            <td className="px-3 py-3">
              <div className="h-3 w-6 animate-pulse rounded bg-muted" />
            </td>
            <td className="px-3 py-3">
              <div className="h-3 w-14 animate-pulse rounded bg-muted" />
            </td>
            <td className="py-2 pr-1 sm:pr-3">
              <div className="ml-auto h-8 w-8 animate-pulse rounded-md bg-muted" />
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
    <thead className={metadataHeadClassName}>
      <tr className="h-10">
        <th scope="col" className="py-2 pl-4 pr-3 font-medium">
          {t("metadataEntries.id")}
        </th>
        <th scope="col" className="min-w-48 px-3 py-2 font-medium">
          {t("metadataEntries.name")}
        </th>
        <th scope="col" className="min-w-36 px-3 py-2 font-medium">
          {t("metadataEntries.aliases")}
        </th>
        <th scope="col" className="px-3 py-2 text-right font-medium">
          {t("metadataEntries.workCount")}
        </th>
        <th scope="col" className="px-3 py-2 font-medium">
          {t("metadataEntries.status")}
        </th>
        <MetadataActionsHeader />
      </tr>
    </thead>
  );
}
