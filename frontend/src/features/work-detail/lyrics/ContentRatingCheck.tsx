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

/** A toolbar button that checks content ratings on demand, with its progress while it runs. */
export function ContentRatingButton({
  checking,
  checked,
  progress,
  disabled = false,
  onCheck,
}: {
  checking: boolean;
  /** Whether a result is shown, so pressing again checks again. */
  checked: boolean;
  /** Finished and total checks of a check that covers several inputs. */
  progress?: { done: number; total: number } | null;
  disabled?: boolean;
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      title={t("contentRating.hint")}
      disabled={disabled || checking}
      onClick={onCheck}
    >
      {checking ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : checked ? (
        <RotateCw className="h-3.5 w-3.5" />
      ) : (
        <ShieldCheck className="h-3.5 w-3.5" />
      )}
      {checking && progress
        ? t("contentRating.checking", { done: progress.done, total: progress.total })
        : checked
          ? t("contentRating.recheck")
          : t("contentRating.check")}
    </Button>
  );
}

/** The result of a single content rating, or why there is none. */
export function ContentRatingResult({
  rating,
  service,
}: {
  rating: ContentRating;
  /** The chosen service, when there is one. */
  service: (ContentBoundary & { name: string }) | null;
}) {
  const { t } = useTranslation();
  if (rating.assessment) {
    return (
      <div className="rounded-md border bg-background/60 px-3 py-2.5" aria-live="polite">
        <ContentAssessment assessment={rating.assessment} service={service} />
      </div>
    );
  }
  if (rating.status === "failed") {
    return (
      <p className="text-xs text-error-foreground" aria-live="polite">
        {t("contentRating.failed")}
      </p>
    );
  }
  return null;
}
