import type { TFunction } from "i18next";
import { CloudOff, ExternalLink, GitFork, HardDriveDownload, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import type { SourceVisibilityMode } from "@/components/source-visibility/sourceVisibility";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { MobileWorkCardSkeleton, type MobileWorkCardLayout } from "@/components/work-card/MobileWorkCard";
import { FetchConfirmDialog } from "@/components/work-collection/FetchConfirmDialog";
import { workCollectionClassName, workCollectionStyle } from "@/components/work-collection/WorkCollectionLayout";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { WorkSelectionAction, WorkSelectionBar } from "@/components/work-collection/WorkSelectionBar";
import { safeExternalHTTPURL } from "@/features/work-detail/workDetailShared";
import { LazyRemoteFetchWorkspaceDialog } from "@/features/work-detail/workflows/LazyRemoteFetchWorkspaceDialog";
import { useDeferredBusy } from "@/hooks/useDeferredBusy";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import type { LibrarySource, RemoteWork, RemoteWorksResponse } from "@/lib/api";
import type { LibraryColumnSetting } from "@/lib/libraryBrowseState";
import type { SearchClause } from "@/lib/librarySearchClauses";

import type { RemoteSourceViewState } from "./libraryBrowseModel";
import { remoteSourceBrowseModel, remoteSourcePanelModel, remoteWorkActionCode } from "./remoteSourceBrowseModel";
import { RemoteWorkCard } from "./RemoteWorkCard";
import { recommendationRevealDelay, useRemoteRecommendations } from "./useRemoteRecommendations";
import { useRemoteSourceActions } from "./useRemoteSourceActions";
import { useRemoteSourceSelection } from "./useRemoteSourceSelection";

// The last page each remote source returned in this session sizes its loading
// skeleton, so a small catalog does not flash a full grid of placeholders.
const remoteSourceLoadedCounts = new Map<number, number>();
const defaultRemoteSkeletonCount = 12;

function RemoteSourceSelectionBar({
  t,
  selectedCount,
  scopeSelectableCount,
  selectedForkableCount,
  selectedFetchableCount,
  isBulkBusy,
  onSelectScope,
  onClear,
  onExit,
  onFork,
  onFetch,
}: {
  t: TFunction;
  selectedCount: number;
  scopeSelectableCount: number;
  selectedForkableCount: number;
  selectedFetchableCount: number;
  isBulkBusy: boolean;
  onSelectScope: () => void;
  onClear: () => void;
  onExit: () => void;
  onFork: () => void;
  onFetch: () => void;
}) {
  return (
    <WorkSelectionBar
      selectedCount={selectedCount}
      scopeSelectableCount={scopeSelectableCount}
      scopeSelectedCount={selectedCount}
      onSelectScope={onSelectScope}
      onClear={onClear}
      onExit={onExit}
    >
      <WorkSelectionAction
        icon={<GitFork className="h-4 w-4" />}
        label={t("detailActions.fork")}
        count={selectedForkableCount}
        disabled={isBulkBusy}
        onClick={onFork}
      />
      <WorkSelectionAction
        icon={<HardDriveDownload className="h-4 w-4" />}
        label={t("detailActions.fetch")}
        count={selectedFetchableCount}
        disabled={isBulkBusy}
        onClick={onFetch}
      />
    </WorkSelectionBar>
  );
}

function RemoteSourceResults({
  source,
  visibleWorks,
  recommendations,
  remoteError,
  isInitialLoading,
  skeletonCount,
  searchClauses,
  mobileColumns,
  desktopColumns,
  mobileCardLayout,
  coverSourceMode,
  selectionMode,
  bulkCodes,
  isSyncingCode,
  actions,
  onToggleBulkCode,
  onClearSearch,
  onOpenPreview,
  onTagOpen,
  onWorkStateChanged,
  onSynced,
  onRetry,
  t,
}: {
  source: LibrarySource;
  visibleWorks: RemoteWork[];
  recommendations: ReturnType<typeof useRemoteRecommendations>;
  remoteError: NonNullable<RemoteWorksResponse["error"]> | null;
  isInitialLoading: boolean;
  skeletonCount: number;
  searchClauses: SearchClause[];
  mobileColumns: LibraryColumnSetting;
  desktopColumns: LibraryColumnSetting;
  mobileCardLayout: MobileWorkCardLayout | null;
  coverSourceMode: SourceVisibilityMode;
  selectionMode: boolean;
  bulkCodes: Set<string>;
  isSyncingCode: string | null;
  actions: ReturnType<typeof useRemoteSourceActions>;
  onToggleBulkCode: (code: string, checked: boolean) => void;
  onClearSearch: () => void;
  onOpenPreview: (work: RemoteWork) => void;
  onTagOpen: (tag: string) => void;
  onWorkStateChanged: (
    primaryCode: string,
    patch: Partial<Pick<RemoteWork, "workId" | "favorite" | "listeningStatus">>,
  ) => void;
  onSynced: (workID: number, options?: { openTracked?: boolean }) => Promise<void>;
  onRetry: () => void;
  t: TFunction;
}) {
  const showSkeleton = useDeferredBusy(isInitialLoading);
  if (isInitialLoading) {
    // A fast first page replaces the previous view directly; placeholders
    // appear only when the wait is noticeable.
    return showSkeleton ? (
      <RemoteWorkGridSkeleton
        count={skeletonCount}
        mobileColumns={mobileColumns}
        desktopColumns={desktopColumns}
        mobileCardLayout={mobileCardLayout}
      />
    ) : null;
  }
  if (remoteError) return <RemoteSourceErrorCard error={remoteError} onRetry={onRetry} />;
  if (visibleWorks.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm text-muted-foreground">
          <span>{searchClauses.length > 0 ? t("library.noRemoteSearchMatch") : t("library.noRemoteWorks")}</span>
          {searchClauses.length > 0 && (
            <Button variant="outline" size="sm" onClick={onClearSearch}>
              {t("library.clearSearch")}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <section className={workCollectionClassName()} style={workCollectionStyle(mobileColumns, desktopColumns)}>
        {visibleWorks.map((work, index) => (
          <div key={work.remoteId} className="h-full">
            <RemoteWorkCard
              work={{ ...work, recommendScore: recommendations.scores.get(work.primaryCode) ?? 0 }}
              recommendationScored={recommendations.scores.has(work.primaryCode)}
              revealDelay={recommendationRevealDelay(index)}
              source={source}
              coverSourceMode={coverSourceMode}
              mobileLayout={mobileCardLayout}
              selected={bulkCodes.has(work.primaryCode)}
              selectable={Boolean(work.primaryCode)}
              selectionActive={selectionMode}
              isBusy={isSyncingCode === work.primaryCode || actions.fetchWorkspace.isBusy}
              onSelectedChange={(checked) => onToggleBulkCode(work.primaryCode, checked)}
              onOpen={() => onOpenPreview(work)}
              onFork={() => void actions.forkWork(work, "manual_fork")}
              onTagOpen={onTagOpen}
              onMark={(status) => void actions.markRemoteWork(work, status)}
              canMark={() => actions.canStateRemoteWork(work)}
              onSave={() =>
                void actions.fetchWorkspace.open({
                  sourceId: source.id,
                  remoteCode: remoteWorkActionCode(work),
                  canonicalCode: work.primaryCode,
                  sourceDisplayName: source.displayName,
                })
              }
              onEnsureWork={() => actions.ensureRemoteWorkForList(work)}
              onListSaved={(workId, favorite) => {
                onWorkStateChanged(work.primaryCode, { workId, favorite });
                void onSynced(0);
              }}
            />
          </div>
        ))}
      </section>
    </div>
  );
}

export function RemoteSourcePanel({
  source,
  recommendationsEnabled,
  recommendationSessionId,
  result,
  loading,
  viewState,
  selectionMode,
  onSelectionModeChange,
  searchClauses,
  mobileColumns,
  desktopColumns,
  mobileCardLayout,
  coverSourceMode,
  onClearSearch,
  onPageChange,
  onOpenPreview,
  onTagOpen,
  onWorkStateChanged,
  onSynced,
  onRetry,
}: {
  source: LibrarySource;
  recommendationsEnabled: boolean;
  recommendationSessionId: string;
  result: RemoteWorksResponse | null;
  loading: boolean;
  viewState: RemoteSourceViewState;
  selectionMode: boolean;
  onSelectionModeChange: (active: boolean) => void;
  searchClauses: SearchClause[];
  mobileColumns: LibraryColumnSetting;
  desktopColumns: LibraryColumnSetting;
  mobileCardLayout: MobileWorkCardLayout | null;
  coverSourceMode: SourceVisibilityMode;
  onClearSearch: () => void;
  onPageChange: (page: number) => void;
  onOpenPreview: (work: RemoteWork) => void;
  onTagOpen: (tag: string) => void;
  onWorkStateChanged: (
    primaryCode: string,
    patch: Partial<Pick<RemoteWork, "workId" | "favorite" | "listeningStatus">>,
  ) => void;
  onSynced: (workID: number, options?: { openTracked?: boolean }) => Promise<void>;
  onRetry: () => void;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  // Errors also produce a result, so no result means the first page is still on its way.
  const isInitialLoading = result === null;
  useEffect(() => {
    if (result?.status === "ok") remoteSourceLoadedCounts.set(source.id, result.works.length);
  }, [result, source.id]);
  const skeletonCount = Math.min(
    defaultRemoteSkeletonCount,
    Math.max(1, remoteSourceLoadedCounts.get(source.id) ?? defaultRemoteSkeletonCount),
  );
  const { page } = viewState;
  const browse = remoteSourceBrowseModel({ result, viewState, onPageChange });
  const selection = useRemoteSourceSelection({
    selectableWorks: browse.selectableWorks,
    visibleWorks: browse.visibleWorks,
    selectionMode,
    loading,
    page,
    totalPages: browse.totalPages,
    onPageChange,
  });
  const model = remoteSourcePanelModel({ browse, bulkCodes: selection.bulkCodes });
  const auth = useAuth();
  const recommendations = useRemoteRecommendations({
    sourceId: source.id,
    works: model.visibleWorks,
    sessionId: recommendationSessionId,
    enabled: recommendationsEnabled && !loading && Boolean(auth.user) && !auth.demoMode && result?.status === "ok",
  });
  const actions = useRemoteSourceActions({
    source,
    selectedSyncable: model.selectedSyncable,
    selectedSaveable: model.selectedSaveable,
    toast,
    t,
    onWorkStateChanged,
    onSynced,
  });
  const { isSyncingCode, isBulkBusy, saveConfirm, clearSaveConfirm, bulkForkSelected, bulkSaveSelected } = actions;
  const remotePaginationProps = model.remotePaginationProps;
  // Phones show the page beside the result count in the toolbar instead.
  const mobileNavigationLayout = useMobileNavigationLayout();
  const remoteTopPagination = (
    <WorkCollectionPagination {...remotePaginationProps} placement="top" compactMobile compactTop />
  );

  return (
    <section className="space-y-3 pb-4 lg:pb-8">
      {!model.remoteError && !isInitialLoading && !mobileNavigationLayout && remoteTopPagination}
      {selectionMode && (
        <RemoteSourceSelectionBar
          t={t}
          selectedCount={model.selectedWorks.length}
          scopeSelectableCount={model.selectableWorks.length}
          selectedForkableCount={model.selectedSyncable.length}
          selectedFetchableCount={model.selectedSaveable.length}
          isBulkBusy={isBulkBusy}
          onSelectScope={() => selection.toggleAllVisible(true)}
          onClear={selection.clearSelection}
          onExit={() => {
            selection.clearSelection();
            onSelectionModeChange(false);
          }}
          onFork={() => void bulkForkSelected()}
          onFetch={() => void bulkSaveSelected()}
        />
      )}
      {recommendations.failed && (
        <div role="status" className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>{t("errors.unavailable")}</span>
          <Button variant="outline" size="sm" onClick={recommendations.retry}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      <RemoteSourceResults
        source={source}
        visibleWorks={model.visibleWorks}
        recommendations={{
          ...recommendations,
          scores:
            auth.demoMode && recommendationsEnabled
              ? new Map(model.visibleWorks.map((work) => [work.primaryCode, work.recommendScore]))
              : recommendations.scores,
        }}
        remoteError={model.remoteError}
        isInitialLoading={isInitialLoading}
        skeletonCount={skeletonCount}
        searchClauses={searchClauses}
        mobileColumns={mobileColumns}
        desktopColumns={desktopColumns}
        mobileCardLayout={mobileCardLayout}
        coverSourceMode={coverSourceMode}
        selectionMode={selectionMode}
        bulkCodes={selection.bulkCodes}
        isSyncingCode={isSyncingCode}
        actions={actions}
        onToggleBulkCode={selection.toggleBulkCode}
        onClearSearch={onClearSearch}
        onOpenPreview={onOpenPreview}
        onTagOpen={onTagOpen}
        onWorkStateChanged={onWorkStateChanged}
        onSynced={onSynced}
        onRetry={onRetry}
        t={t}
      />
      {!model.remoteError && !isInitialLoading && (
        <WorkCollectionPagination {...remotePaginationProps} placement="bottom" />
      )}
      {saveConfirm && (
        <FetchConfirmDialog
          count={saveConfirm.codes.length}
          onClose={clearSaveConfirm}
          onConfirm={() => void saveConfirm.run()}
        />
      )}
      <LazyRemoteFetchWorkspaceDialog workspace={actions.fetchWorkspace} />
    </section>
  );
}

function RemoteSourceErrorCard({
  error,
  onRetry,
}: {
  error: { code: string; message: string; url?: string; retryable: boolean };
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const disabled = error.code === "disabled";
  const url = safeExternalHTTPURL(error.url);
  return (
    <Card className="border-error-border bg-error-surface">
      <CardContent className="flex flex-col gap-4 p-5 text-sm text-error-foreground sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <CloudOff className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="min-w-0 space-y-1">
            <div className="font-semibold">
              {disabled ? t("library.remoteSourceDisabledTitle") : t("library.remoteSourceUnavailableTitle")}
            </div>
            <p className="text-sm/6">
              {disabled
                ? t("library.remoteSourceDisabledDescription")
                : t("library.remoteSourceUnavailableDescription")}
            </p>
            {error.message && <p className="text-xs/5 opacity-80">{error.message}</p>}
            {url && (
              <a
                className="inline-flex max-w-full items-start gap-1 break-all text-xs underline underline-offset-2 hover:no-underline"
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{url}</span>
              </a>
            )}
          </div>
        </div>
        {error.retryable && (
          <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" />
            {t("library.retryRemoteSource")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function RemoteWorkGridSkeleton({
  count,
  mobileColumns,
  desktopColumns,
  mobileCardLayout,
}: {
  count: number;
  mobileColumns: LibraryColumnSetting;
  desktopColumns: LibraryColumnSetting;
  mobileCardLayout: MobileWorkCardLayout | null;
}) {
  return (
    <section className={workCollectionClassName()} style={workCollectionStyle(mobileColumns, desktopColumns)}>
      {Array.from({ length: count }, (_, index) =>
        mobileCardLayout ? (
          <MobileWorkCardSkeleton key={index} layout={mobileCardLayout} />
        ) : (
          <div key={index} className="overflow-hidden rounded-lg border bg-card">
            <div className="p-1.5 pb-0">
              <div className="aspect-[4/3] animate-pulse rounded-[calc(var(--radius)-4px)] bg-muted" />
            </div>
            <div className="space-y-2 px-3 pb-3 pt-2.5">
              <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
              <div className="flex gap-1.5 pt-2">
                <div className="h-6 w-16 animate-pulse rounded bg-muted" />
                <div className="h-6 w-20 animate-pulse rounded bg-muted" />
              </div>
            </div>
          </div>
        ),
      )}
    </section>
  );
}
