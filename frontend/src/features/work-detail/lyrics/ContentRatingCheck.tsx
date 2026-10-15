import { useState } from "react";
import { Loader2, RotateCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ContentAssessment } from "@/components/content/ContentAssessment";
import type { LLMAssessment } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { type ContentBoundary, type ContentClass } from "@/features/work-detail/lyrics/contentRatingModel";

type ContentRatingState =
  { key: string; status: "checking" | "failed" } | { key: string; status: "done"; assessment: LLMAssessment };

export type ContentRating = {
  status: "idle" | "checking" | "failed" | "done";
  /** The checked class, until the checked input changes. */
  contentClass: ContentClass | null;
  assessment: LLMAssessment | null;
  run: () => void;
};

/**
 * Checks the content policy class of an input only when asked, since a check
 * reads the work and possibly a whole lyrics file. A result belongs to the
 * input it was checked for: a new `key` drops it.
 */
export function useContentRating(key: string, check: () => Promise<LLMAssessment>): ContentRating {
  const [state, setState] = useState<ContentRatingState | null>(null);
  const current = state?.key === key ? state : null;
  const run = () => {
    setState({ key, status: "checking" });
    check()
      .then((assessment) => setState((latest) => (latest?.key === key ? { key, status: "done", assessment } : latest)))
      .catch(() => setState((latest) => (latest?.key === key ? { key, status: "failed" } : latest)));
  };
  return {
    status: current?.status ?? "idle",
    contentClass: current?.status === "done" ? current.assessment.class : null,
    assessment: current?.status === "done" ? current.assessment : null,
    run,
  };
}

/** A service as a choice, noting when the checked content may not go to it. */
export function ServiceChoiceLabel({ name, excluded }: { name: string; excluded: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="flex min-w-0 items-center justify-between gap-3">
      <span className="truncate">{name}</span>
      {excluded && <span className="shrink-0 text-xs text-warning-foreground">{t("contentRating.notForContent")}</span>}
    </span>
  );
}

/** The content rating of a request form: a check button, then the class and what it means for the chosen service. */
export function ContentRatingCheck({
  rating,
  service,
  disabled = false,
}: {
  rating: ContentRating;
  /** The chosen service, when there is one. */
  service: (ContentBoundary & { name: string }) | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { status, contentClass } = rating;
  const checking = status === "checking";
  return (
    <div className="space-y-1.5 rounded-md border bg-background/60 px-3 py-2.5" aria-live="polite">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{t("contentRating.title")}</span>
        </span>
        <Button variant="ghost" size="sm" className="shrink-0" disabled={disabled || checking} onClick={rating.run}>
          {checking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : contentClass ? (
            <RotateCw className="h-3.5 w-3.5" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
          {contentClass ? t("contentRating.recheck") : t("contentRating.check")}
        </Button>
      </div>
      {rating.assessment ? (
        <ContentAssessment assessment={rating.assessment} service={service} />
      ) : status === "failed" ? (
        <p className="text-xs text-error-foreground">{t("contentRating.failed")}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{t("contentRating.hint")}</p>
      )}
    </div>
  );
}
