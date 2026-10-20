import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { CreatorCard } from "@/components/creator/CreatorCard";
import { useAuth } from "@/auth/AuthProvider";
import { DemoContentNotice } from "@/components/DemoReadOnlyNotice";
import { api, type VoiceSummary } from "@/lib/api";
import { creatorCoverUrl } from "@/lib/creatorApi";
import { currentInternalLocation, normalizeInternalLocation } from "@/lib/browserHistory";
import { CreatorListPage } from "@/pages/creator/CreatorListPage";
import { isVoiceListLocation, openVoiceRoute, writeLastVoiceListLocation } from "@/lib/voiceNavigationState";
import { voiceRouteKeyFromPath } from "@/lib/voiceRoute";
import { VoiceDetailPage } from "@/pages/voice/VoiceDetailPage";

type CreatorKind = "circle" | "voice";

type VoiceFilter = "all" | "favorite" | "tagged" | "available" | "local" | "remote" | "missing";

const voicePageSizeOptions = [24, 48, 96] as const;

const voiceFilterOptions: readonly { value: VoiceFilter; label: string }[] = [
  { value: "all", label: "All voices" },
  { value: "favorite", label: "Favorite" },
  { value: "tagged", label: "Tagged" },
  { value: "available", label: "Available" },
  { value: "local", label: "Local" },
  { value: "remote", label: "Remote" },
  { value: "missing", label: "Missing" },
];

const voiceFilters: readonly VoiceFilter[] = voiceFilterOptions.map((option) => option.value);

export function CreatorWorksPage({ kind, active = true }: { kind: CreatorKind; active?: boolean }) {
  const { t } = useTranslation();
  if (kind !== "voice") {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        {t("creatorBrowse.circleViewMoved")}
      </div>
    );
  }
  return <VoiceCreatorWorksPage active={active} />;
}

function VoiceCreatorWorksPage({ active }: { active: boolean }) {
  const { demoMode } = useAuth();
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    if (!active) return;
    const syncPath = () => {
      if (!isVoiceWorkspaceLocation(currentInternalLocation())) return;
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
  const routeKey = voiceRouteKeyFromPath(path);
  const [listVisited, setListVisited] = useState(routeKey === null);
  useEffect(() => {
    if (routeKey === null) setListVisited(true);
  }, [routeKey]);
  return (
    <>
      {demoMode && (
        <div className="mb-5">
          <DemoContentNotice surface="works" />
        </div>
      )}
      {routeKey !== null && <VoiceDetailPage routeKey={routeKey} active={active} />}
      {(listVisited || routeKey === null) && (
        <div hidden={routeKey !== null}>
          <VoiceListPage active={active && routeKey === null} />
        </div>
      )}
    </>
  );
}

const VoiceCard = memo(function VoiceCard({
  voice,
  onFavoriteToggle,
  onTagsSave,
}: {
  voice: VoiceSummary;
  onFavoriteToggle: (voice: VoiceSummary) => Promise<void>;
  onTagsSave: (voice: VoiceSummary, tags: string[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <CreatorCard
      name={voice.displayName}
      identityLabel={voice.latestWork ? undefined : t("creatorBrowse.voiceActor")}
      aliases={voice.aliases}
      coverUrl={creatorCoverUrl(voice)}
      latestWork={voice.latestWork}
      favorite={voice.favorite}
      userTags={voice.userTags}
      syncState={voice.syncState}
      availability={{ total: voice.knownWorks, local: voice.localWorks, available: voice.playableWorks }}
      availabilityCounts={{ local: voice.localWorks, remote: voice.remoteWorks }}
      onOpen={() => openVoiceRoute(voice.routeKey)}
      onFavoriteToggle={() => void onFavoriteToggle(voice)}
      onTagsSave={(tags) => onTagsSave(voice, tags)}
      tagScope="voice"
    />
  );
});

function VoiceListPage({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const filterOptions = voiceFilterOptions.map((option) => ({
    ...option,
    label:
      option.value === "all"
        ? t("creatorBrowse.allVoices")
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
                  : t("detailActions.missing"),
  }));
  return (
    <CreatorListPage<VoiceSummary, VoiceFilter>
      active={active}
      path="/voices"
      filters={voiceFilters}
      filterOptions={filterOptions}
      pageSizeOptions={voicePageSizeOptions}
      isListLocation={isVoiceListLocation}
      writeLastListLocation={writeLastVoiceListLocation}
      load={async (request) => {
        const result = await api.listVoices(request);
        return { items: result.voices, total: result.total, page: result.page };
      }}
      itemKey={(voice) => voice.personId}
      toggleFavorite={(voice) => api.updateVoiceUserState(voice.personId, { favorite: !voice.favorite })}
      saveTags={async (voice, tags) => ({ userTags: (await api.setVoiceUserTags(voice.personId, tags)).userTags })}
      renderItem={(voice, handlers) => (
        <VoiceCard voice={voice} onFavoriteToggle={handlers.onFavoriteToggle} onTagsSave={handlers.onTagsSave} />
      )}
      unfilteredEmptyMessage={t("creatorBrowse.noVoiceCredits")}
      copy={{
        label: t("creatorBrowse.voiceActors"),
        searchPlaceholder: t("creatorBrowse.searchVoices"),
        loading: t("creatorBrowse.loadingVoices"),
        refreshing: t("creatorBrowse.refreshingVoices"),
        results: t("creatorBrowse.voiceResults"),
        empty: t("creatorBrowse.noVoices"),
        pages: t("creatorBrowse.voicePages"),
      }}
    />
  );
}

function isVoiceWorkspaceLocation(location: string) {
  const normalized = normalizeInternalLocation(location);
  if (!normalized) return false;
  if (isVoiceListLocation(normalized)) return true;
  try {
    return voiceRouteKeyFromPath(new URL(normalized, "https://kikoto.invalid").pathname) !== null;
  } catch {
    return false;
  }
}
