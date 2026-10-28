import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type ListeningStatus, type Work } from "@/lib/api";

import type { CompactWorkCardLayout } from "./CompactWorkCard";
import { workHasLibraryFiles } from "./sourceBadges";
import { WorkCardWatchButton } from "./WorkCardWatchButton";
import { WorkRatingControl } from "./WorkRatingControl";
import { WorkCardDLsiteAction, WorkCardFooter, WorkCardListButton, WorkCardQuickMarkButton } from "./WorkCardShell";

export type WorkCardActionWork = Pick<
  Work,
  "id" | "favorite" | "memberLists" | "userRating" | "listeningStatus" | "availability"
>;

/**
 * The action row of a card outside the Library, always in one order: DLsite
 * at the start, then Watch, the lists, your rating, and Quick mark at the end.
 * Each appears only when it applies: Watch for a work the caller offers to
 * watch that the library does not have, and the personal actions for a work
 * Kikoto knows when the account may mark it.
 */
export function WorkCardActionFooter({
  layout,
  dlsiteUrl,
  watch,
  work,
  canMark,
  onWorkChange,
}: {
  layout: CompactWorkCardLayout | null;
  dlsiteUrl: string;
  watch?: { watched: boolean; pending: boolean; onWatch: () => void } | null;
  work?: WorkCardActionWork | null;
  canMark: boolean;
  /** Receives the work's new personal state after a change saves. */
  onWorkChange?: (workId: number, patch: Partial<Work>) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const personal = canMark && work ? work : null;
  // There is nothing to wait for on a work the library already has.
  const offeredWatch = watch && !workHasLibraryFiles(work?.availability) ? watch : null;
  const changeStatus = async (target: WorkCardActionWork, status: ListeningStatus) => {
    try {
      const result = await api.updateWorkUserState(target.id, { listeningStatus: status });
      onWorkChange?.(target.id, { listeningStatus: result.listeningStatus, favorite: result.favorite });
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    }
  };
  const changeRating = async (target: WorkCardActionWork, rating: number | null) => {
    try {
      const result = await api.updateWorkUserState(target.id, { userRating: rating });
      onWorkChange?.(target.id, { userRating: result.userRating });
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    }
  };
  return (
    <WorkCardFooter
      className={layout === "row" ? "h-10 border-border/40" : undefined}
      left={<WorkCardDLsiteAction href={dlsiteUrl} />}
      right={
        <>
          {offeredWatch && (
            <WorkCardWatchButton
              watched={offeredWatch.watched}
              pending={offeredWatch.pending}
              onWatch={offeredWatch.onWatch}
            />
          )}
          {personal && (
            <>
              <WorkCardListButton
                workId={personal.id}
                active={personal.favorite}
                memberLists={personal.memberLists}
                fitLabel
                onSaved={(favorite) => onWorkChange?.(personal.id, { favorite })}
              />
              <WorkRatingControl
                variant="card"
                value={personal.userRating ?? null}
                onChange={(rating) => void changeRating(personal, rating)}
              />
              <WorkCardQuickMarkButton
                value={personal.listeningStatus}
                onChange={(status) => void changeStatus(personal, status)}
              />
            </>
          )}
        </>
      }
    />
  );
}
