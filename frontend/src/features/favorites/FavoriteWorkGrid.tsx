import type { TFunction } from "i18next";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import {
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  WorkCardQuickMarkButton,
  WorkCardSelection,
  WorkCardShell,
  dlsiteTagBadges,
  userTagBadges,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import {
  workCollectionClassName,
  workCollectionStyle,
  type WorkCollectionColumnSetting,
} from "@/components/work-collection/WorkCollectionLayout";
import type { Work } from "@/lib/api";
import { openCircleSeriesRoute } from "@/lib/circleNavigationState";
import { hasPlaybackHistory } from "@/lib/playbackHistory";
import type { FavoriteWorkItemHandlers } from "./FavoriteWorkList";

export function FavoriteWorkGrid({
  works,
  selectedWorkIDs,
  selectionActive,
  isListSaving,
  busy,
  mobileColumns,
  desktopColumns,
  handlers,
  onUserTagOpen,
}: {
  works: Work[];
  selectedWorkIDs: Set<number>;
  selectionActive: boolean;
  isListSaving: boolean;
  busy: boolean;
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
  handlers: FavoriteWorkItemHandlers;
  onUserTagOpen: (tag: string) => void;
}) {
  return (
    <div
      className={workCollectionClassName()}
      style={workCollectionStyle(mobileColumns, desktopColumns)}
      aria-busy={busy}
    >
      {works.map((work) => (
        <div key={work.id} data-favorite-work-id={work.id} tabIndex={-1} className="outline-none">
          <FavoriteWorkCard
            work={work}
            selected={selectedWorkIDs.has(work.id)}
            selectionActive={selectionActive}
            isListSaving={isListSaving}
            handlers={handlers}
            onUserTagOpen={onUserTagOpen}
          />
        </div>
      ))}
    </div>
  );
}

const FavoriteWorkCard = memo(function FavoriteWorkCard({
  work,
  selected,
  selectionActive,
  isListSaving,
  handlers,
  onUserTagOpen,
}: {
  work: Work;
  selected: boolean;
  selectionActive: boolean;
  isListSaving: boolean;
  handlers: FavoriteWorkItemHandlers;
  onUserTagOpen: (tag: string) => void;
}) {
  const { t } = useTranslation();
  const view = favoriteWorkCardView(work, onUserTagOpen, t);

  return (
    <WorkCardShell
      work={view}
      selection={
        selectionActive ? (
          <WorkCardSelection checked={selected} onChange={(checked) => handlers.onSelectedChange(work.id, checked)} />
        ) : undefined
      }
      onOpen={() => handlers.onOpen(work)}
      onSeriesOpen={
        work.seriesTitleId && work.circleExternalId
          ? () => openCircleSeriesRoute(work.circleExternalId, work.seriesTitleId)
          : undefined
      }
      footer={
        <WorkCardFooter
          left={<WorkCardDLsiteAction href={work.dlsiteUrl} />}
          right={
            <>
              <WorkCardListButton
                workId={work.id}
                active={work.favorite}
                disabled={isListSaving}
                onSaved={() => void handlers.onListsChanged(work)}
              />
              <WorkCardQuickMarkButton
                value={work.listeningStatus}
                onChange={(status) => void handlers.onStatusChange(work.id, status)}
              />
            </>
          }
        />
      }
    />
  );
});

function favoriteWorkCardView(work: Work, onUserTagOpen: (tag: string) => void, t: TFunction): WorkCardViewModel {
  return {
    code: work.primaryCode,
    title: work.title,
    circle: work.circle || t("workCard.unknownCircle"),
    circleExternalId: work.circleExternalId,
    ageRating: work.ageRating,
    voiceActors: work.voiceActors,
    voiceCredits: work.voiceCredits,
    coverUrl: work.coverUrl,
    rating: work.rating,
    ratingCount: work.ratingCount,
    sales: work.sales,
    regularPrice: work.regularPrice,
    price: work.price,
    priceCurrency: work.priceCurrency,
    series: work.series || null,
    hasAvailableNonOriginEdition: work.hasAvailableNonOriginEdition,
    hasPlaybackHistory: hasPlaybackHistory(work.progress),
    dlsiteTags: [
      {
        key: `status:${work.listeningStatus}`,
        label: t(`library.status.${work.listeningStatus}`),
        variant: "secondary",
      },
      ...dlsiteTagBadges(work.tags),
    ],
    userTags: userTagBadges(work.userTags ?? [], onUserTagOpen),
    sourceBadges: sourcePresenceBadges(work.sourcePresence, work.availability),
  };
}
