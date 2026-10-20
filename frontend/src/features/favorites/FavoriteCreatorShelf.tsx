import { memo } from "react";
import { useTranslation } from "react-i18next";

import {
  CreatorCard,
  CreatorCollectionSkeleton,
  creatorCardMinHeightClassName,
  creatorCollectionClassName,
} from "@/components/creator/CreatorCard";
import { Card, CardContent } from "@/components/ui/card";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type CircleSummary, type VoiceSummary } from "@/lib/api";
import { creatorCoverUrl } from "@/lib/creatorApi";
import { openCircleRoute } from "@/lib/circleNavigationState";
import { openVoiceRoute } from "@/lib/voiceNavigationState";
import type { FavoriteEntity } from "./favoritesBrowseState";
import { FavoriteLoadError } from "./FavoriteStates";

export function FavoriteCreatorShelf({
  kind,
  query,
  isLoading,
  hasSnapshot,
  loadError,
  circles,
  voices,
  onRetry,
  onCircleChange,
  onVoiceChange,
}: {
  kind: Exclude<FavoriteEntity, "works">;
  query: string;
  isLoading: boolean;
  hasSnapshot: boolean;
  loadError: string;
  circles: CircleSummary[];
  voices: VoiceSummary[];
  onRetry: () => void;
  onCircleChange: (circle: CircleSummary) => void;
  onVoiceChange: (voice: VoiceSummary) => void;
}) {
  const { t } = useTranslation();
  const needle = query.trim().toLowerCase();
  const filteredCircles = circles.filter(
    (circle) =>
      !needle ||
      [circle.externalId, circle.displayName, ...circle.userTags.map((tag) => tag.name)].some((value) =>
        value.toLowerCase().includes(needle),
      ),
  );
  const filteredVoices = voices.filter(
    (voice) =>
      !needle ||
      [voice.displayName, String(voice.personId), ...voice.aliases, ...voice.userTags.map((tag) => tag.name)].some(
        (value) => value.toLowerCase().includes(needle),
      ),
  );
  const items = kind === "circles" ? filteredCircles : filteredVoices;
  const entityLabel = kind === "circles" ? t("creatorBrowse.circles") : t("creatorBrowse.voiceActors");

  if (!hasSnapshot) {
    return loadError ? (
      <FavoriteLoadError message={loadError} onRetry={onRetry} />
    ) : (
      <CreatorCollectionSkeleton label={`${t("favorites.loadingSources")}: ${entityLabel}`} />
    );
  }
  if (items.length === 0) {
    return (
      <Card className={creatorCardMinHeightClassName} aria-busy={isLoading}>
        <CardContent
          className={`grid ${creatorCardMinHeightClassName} place-items-center p-5 text-sm text-muted-foreground`}
        >
          {t("favorites.noMatches")} · {entityLabel}
        </CardContent>
      </Card>
    );
  }
  return (
    <div
      className={creatorCollectionClassName}
      role="region"
      aria-label={`${t("favorites.all")}: ${entityLabel}`}
      aria-busy={isLoading}
    >
      {kind === "circles"
        ? filteredCircles.map((circle) => (
            <FavoriteCircleCard key={circle.externalId} circle={circle} onChange={onCircleChange} />
          ))
        : filteredVoices.map((voice) => (
            <FavoriteVoiceCard key={voice.personId} voice={voice} onChange={onVoiceChange} />
          ))}
    </div>
  );
}

const FavoriteCircleCard = memo(function FavoriteCircleCard({
  circle,
  onChange,
}: {
  circle: CircleSummary;
  onChange: (circle: CircleSummary) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const saveTags = async (tags: string[]) => {
    try {
      const result = await api.setCircleUserTags(circle.externalId, tags);
      onChange({ ...circle, userTags: result.userTags });
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.tagsUpdateFailed")));
    }
  };
  const removeFavorite = async () => {
    try {
      const next = await api.updateCircleUserState(circle.externalId, { favorite: false });
      onChange({ ...circle, ...next });
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.favoriteUpdateFailed")));
    }
  };
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
      onFavoriteToggle={() => void removeFavorite()}
      onTagsSave={saveTags}
      tagScope="circle"
    />
  );
});

const FavoriteVoiceCard = memo(function FavoriteVoiceCard({
  voice,
  onChange,
}: {
  voice: VoiceSummary;
  onChange: (voice: VoiceSummary) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const saveTags = async (tags: string[]) => {
    try {
      const result = await api.setVoiceUserTags(voice.personId, tags);
      onChange({ ...voice, userTags: result.userTags });
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.tagsUpdateFailed")));
    }
  };
  const removeFavorite = async () => {
    try {
      const next = await api.updateVoiceUserState(voice.personId, { favorite: false });
      onChange({ ...voice, ...next });
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.favoriteUpdateFailed")));
    }
  };
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
      onFavoriteToggle={() => void removeFavorite()}
      onTagsSave={saveTags}
      tagScope="voice"
    />
  );
});
