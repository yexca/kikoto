import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { CreatorCard } from "@/components/creator/CreatorCard";
import { api, type CircleSummary } from "@/lib/api";
import { creatorCoverUrl } from "@/lib/creatorApi";
import { currentInternalLocation, normalizeInternalLocation } from "@/lib/browserHistory";
import { useAuth } from "@/auth/AuthProvider";
import { DemoContentNotice } from "@/components/DemoReadOnlyNotice";
import { openCircleRoute, isCircleListLocation, writeLastCircleListLocation } from "@/lib/circleNavigationState";
import { CreatorListPage } from "@/pages/creator/CreatorListPage";
import { CircleDetailPage } from "@/pages/circle/CircleDetailPage";

const circlePageSizeOptions = [24, 48, 96] as const;

type CircleFilter =
  "all" | "favorite" | "tagged" | "available" | "local" | "remote" | "missing" | "attention" | "stale";

const circleFilterOptions: readonly { value: CircleFilter; label: string }[] = [
  { value: "all", label: "All circles" },
  { value: "favorite", label: "Favorite" },
  { value: "tagged", label: "Tagged" },
  { value: "available", label: "Available" },
  { value: "local", label: "Local" },
  { value: "remote", label: "Remote" },
  { value: "missing", label: "Missing" },
  { value: "attention", label: "Attention" },
];

const circleFilters: readonly CircleFilter[] = [...circleFilterOptions.map((option) => option.value), "stale"];

export function CirclesPage({ active = true }: { active?: boolean }) {
  const { demoMode } = useAuth();
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    if (!active) return;
    const syncPath = () => {
      if (!isCircleWorkspaceLocation(currentInternalLocation())) return;
      setPath(window.location.pathname);
    };
    syncPath();
    window.addEventListener("popstate", syncPath);
    window.addEventListener("kikoto:navigation", syncPath);
    return () => {
      window.removeEventListener("popstate", syncPath);
      window.removeEventListener("kikoto:navigation", syncPath);
    };
  }, [active]);
  const route = circleRouteFromPath(path);
  const [listVisited, setListVisited] = useState(route === null);
  const showList = route === null;
  useEffect(() => {
    if (showList) setListVisited(true);
  }, [showList]);
  return (
    <>
      {demoMode && (
        <div className="mb-5">
          <DemoContentNotice surface="works" />
        </div>
      )}
      {route && <CircleDetailPage externalId={route.externalId} seriesCode={route.seriesCode} active={active} />}
      {(listVisited || showList) && (
        <div hidden={route !== null}>
          <CircleListPage active={active && route === null} />
        </div>
      )}
    </>
  );
}

const CircleCard = memo(function CircleCard({
  circle,
  onFavoriteToggle,
  onTagsSave,
}: {
  circle: CircleSummary;
  onFavoriteToggle: (circle: CircleSummary) => Promise<void>;
  onTagsSave: (circle: CircleSummary, tags: string[]) => Promise<void>;
}) {
  return (
    <CreatorCard
      name={circle.displayName}
      identityLabel={circle.externalId}
      aliases={circle.aliases}
      showAliases={false}
      coverUrl={creatorCoverUrl(circle)}
      latestWork={circle.latestWork}
      favorite={circle.favorite}
      userTags={circle.userTags}
      syncState={circle.syncState}
      availability={{ total: circle.catalogWorks, local: circle.localWorks, available: circle.playableWorks }}
      availabilitySummary={{ available: circle.playableWorks, total: circle.catalogWorks }}
      onOpen={() => openCircleRoute(circle.externalId)}
      onFavoriteToggle={() => void onFavoriteToggle(circle)}
      onTagsSave={(tags) => onTagsSave(circle, tags)}
      tagScope="circle"
    />
  );
});

function CircleListPage({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const filterOptions = circleFilterOptions.map((option) => ({
    ...option,
    label:
      option.value === "all"
        ? t("creatorBrowse.allCircles")
        : option.value === "favorite"
          ? t("creatorBrowse.favorite")
          : option.value === "tagged"
            ? t("creatorBrowse.tagged")
            : option.value === "available"
              ? t("content.available")
              : option.value === "local"
                ? t("detailActions.local")
                : option.value === "remote"
                  ? t("detailActions.remote")
                  : option.value === "missing"
                    ? t("detailActions.missing")
                    : t("sync.attention"),
  }));
  return (
    <CreatorListPage<CircleSummary, CircleFilter>
      active={active}
      path="/circles"
      filters={circleFilters}
      filterOptions={filterOptions}
      pageSizeOptions={circlePageSizeOptions}
      isListLocation={isCircleListLocation}
      writeLastListLocation={writeLastCircleListLocation}
      load={async (request) => {
        const result = await api.listCircles(request);
        return { items: result.circles, total: result.total, page: result.page };
      }}
      itemKey={(circle) => circle.externalId}
      toggleFavorite={(circle) => api.updateCircleUserState(circle.externalId, { favorite: !circle.favorite })}
      saveTags={async (circle, tags) => ({
        userTags: (await api.setCircleUserTags(circle.externalId, tags)).userTags,
      })}
      renderItem={(circle, handlers) => (
        <CircleCard circle={circle} onFavoriteToggle={handlers.onFavoriteToggle} onTagsSave={handlers.onTagsSave} />
      )}
      copy={{
        label: t("creatorBrowse.circles"),
        searchPlaceholder: t("creatorBrowse.searchCircles"),
        loading: t("creatorBrowse.loadingCircles"),
        refreshing: t("creatorBrowse.refreshingCircles"),
        results: t("creatorBrowse.circleResults"),
        empty: t("creatorBrowse.noCircles"),
        pages: t("creatorBrowse.circlePages"),
      }}
    />
  );
}

function circleRouteFromPath(path: string) {
  const match = path.match(/^\/circles\/([^/]+)(?:\/(series)(?:\/([^/]+))?)?\/?$/i);
  if (!match) return null;
  return {
    externalId: safeDecodePathSegment(match[1]),
    seriesCode: match[3] ? safeDecodePathSegment(match[3]) : match[2] ? null : undefined,
  };
}

function isCircleWorkspaceLocation(location: string) {
  const normalized = normalizeInternalLocation(location);
  if (!normalized) return false;
  if (isCircleListLocation(normalized)) return true;
  try {
    return circleRouteFromPath(new URL(normalized, "https://kikoto.invalid").pathname) !== null;
  } catch {
    return false;
  }
}

function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
