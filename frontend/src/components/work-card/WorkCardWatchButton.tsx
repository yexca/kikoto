import { Check, Eye } from "lucide-react";
import { useTranslation } from "react-i18next";

import { WorkCardActionButton } from "./WorkCardShell";

/**
 * Adds a card's work to Availability Watch, with a visible label so the
 * action reads without a tooltip. A work already in the pool says so instead.
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
        className="inline-flex h-8 shrink-0 items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground"
        title={t("workCard.watchingTitle")}
      >
        <Check className="h-4 w-4" aria-hidden="true" />
        {t("workCard.watching")}
      </span>
    );
  }
  return (
    <WorkCardActionButton
      title={t("workCard.watchTitle")}
      label={t("workCard.watch")}
      showLabel
      disabled={pending}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onWatch();
      }}
    >
      <Eye className="h-4 w-4" />
    </WorkCardActionButton>
  );
}
