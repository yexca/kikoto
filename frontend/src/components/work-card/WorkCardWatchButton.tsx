import { Eye } from "lucide-react";
import { useTranslation } from "react-i18next";

import { WorkCardActionButton } from "./WorkCardShell";

/**
 * Adds a card's work to Availability Watch: an icon action like the lists and
 * Quick mark beside it. A work already in the pool shows the same icon lit,
 * the way a work in a list lights the list icon.
 */
export function WorkCardWatchButton({
  watched,
  pending = false,
  onWatch,
}: {
  watched: boolean;
  pending?: boolean;
  onWatch: () => void;
}) {
  const { t } = useTranslation();
  if (watched) {
    return (
      <span
        role="img"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center"
        title={t("workCard.watchingTitle")}
        aria-label={t("workCard.watchingTitle")}
      >
        <Eye className="h-4 w-4 text-primary" aria-hidden="true" />
      </span>
    );
  }
  return (
    <WorkCardActionButton
      title={t("workCard.watchTitle")}
      disabled={pending}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onWatch();
      }}
    >
      <Eye className="h-4 w-4 text-muted-foreground" />
    </WorkCardActionButton>
  );
}
