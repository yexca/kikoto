import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { SourceVisibilityMode } from "@/components/source-visibility/sourceVisibility";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { MobileWorkCardLayout } from "@/components/work-card/MobileWorkCard";
import { workCollectionClassName, workCollectionStyle } from "@/components/work-collection/WorkCollectionLayout";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import type { ListeningStatus, SourcePresenceItem, Work } from "@/lib/api";
import type { LibraryColumnSetting } from "@/lib/libraryBrowseState";

import type { LocalLibraryScope } from "./libraryRoutes";
import { LibraryWorkCard } from "./LibraryWorkCard";

/**
 * The local or tracked works of the Library: the loaded page as cards with its
 * pagination, or its empty and load-failure states. A failure keeps the last
 * loaded cards on screen beside the retry.
 */
export function LocalLibraryPanel({
  scope,
  works,
  pagination,
  loadError,
  isLoading,
  onRetry,
  recommendationBadgesUnavailable,
  filtered,
  onClearFilters,
  showRecommendationScore,
  mobileColumns,
  desktopColumns,
  mobileCardLayout,
  coverSourceMode,
  onOpen,
  onRecommendationOpen,
  onStatusChange,
  onFavoriteSaved,
  onTagOpen,
  onUserTagOpen,
  onUntrack,
  canUntrack,
  isUntracking,
  onFetch,
  isFetchBusy,
}: {
  scope: LocalLibraryScope;
  works: Work[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    onPageChange: (page: number) => void;
  };
  loadError: string;
  isLoading: boolean;
  onRetry: () => void;
  /** Score badges are on, but the loaded page could not be scored. */
  recommendationBadgesUnavailable: boolean;
  /** A search or quick-mark filter narrows the list. */
  filtered: boolean;
  onClearFilters: () => void;
  showRecommendationScore: boolean;
  mobileColumns: LibraryColumnSetting;
  desktopColumns: LibraryColumnSetting;
  mobileCardLayout: MobileWorkCardLayout | null;
  coverSourceMode: SourceVisibilityMode;
  onOpen: (work: Work) => void;
  onRecommendationOpen: (work: Work) => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
  onFavoriteSaved: (work: Work, favorite: boolean) => void;
  onTagOpen: (tag: string) => void;
  onUserTagOpen: (tag: string) => void;
  onUntrack?: (work: Work, source: SourcePresenceItem) => Promise<void>;
  canUntrack: () => boolean;
  isUntracking: boolean;
  onFetch?: (work: Work, source: SourcePresenceItem) => void;
  isFetchBusy: boolean;
}) {
  const { t } = useTranslation();
  // Phones show the page beside the result count in the toolbar instead.
  const mobileNavigationLayout = useMobileNavigationLayout();
  return (
    <div className="space-y-3">
      {!loadError && !mobileNavigationLayout && (
        <WorkCollectionPagination {...pagination} placement="top" compactMobile compactTop />
      )}
      {recommendationBadgesUnavailable && (
        <div role="status" className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>{t("library.recommendationBadgesUnavailable")}</span>
          <Button variant="outline" size="sm" disabled={isLoading} onClick={onRetry}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      {loadError && <LibraryLoadErrorCard message={loadError} onRetry={onRetry} />}
      {works.length === 0 ? (
        !loadError && <EmptyLibraryWorksCard scope={scope} filtered={filtered} onClear={onClearFilters} />
      ) : (
        <section className={workCollectionClassName()} style={workCollectionStyle(mobileColumns, desktopColumns)}>
          {works.map((work) => (
            <LibraryWorkCard
              key={work.id}
              work={work}
              showRecommendationScore={showRecommendationScore}
              onRecommendationOpen={onRecommendationOpen}
              onOpen={onOpen}
              onStatusChange={onStatusChange}
              onFavoriteSaved={onFavoriteSaved}
              onTagOpen={onTagOpen}
              onUserTagOpen={onUserTagOpen}
              coverSourceScope={scope}
              coverSourceMode={coverSourceMode}
              onUntrack={onUntrack}
              canUntrack={canUntrack}
              isUntracking={isUntracking}
              onFetch={onFetch}
              isFetchBusy={isFetchBusy}
              mobileLayout={mobileCardLayout}
            />
          ))}
        </section>
      )}
      {!loadError && <WorkCollectionPagination {...pagination} placement="bottom" />}
    </div>
  );
}

function EmptyLibraryWorksCard({
  scope,
  filtered,
  onClear,
}: {
  scope: LocalLibraryScope;
  filtered: boolean;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm text-muted-foreground">
        <span>{scope === "tracked" ? t("library.noTrackedWorks") : t("library.noLocalWorks")}</span>
        {filtered && (
          <Button variant="outline" size="sm" onClick={onClear}>
            {t("library.clearSearchAndFilters")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function LibraryLoadErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="border-destructive/35">
      <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-destructive">{t("library.couldNotLoad")}</div>
          <div className="mt-1 text-xs text-muted-foreground">{message}</div>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" />
          {t("common.retry")}
        </Button>
      </CardContent>
    </Card>
  );
}
