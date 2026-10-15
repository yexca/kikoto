import { useState } from "react";
import { Loader2, RotateCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  serviceReceives,
  type ContentBoundary,
  type ContentClass,
} from "@/features/work-detail/lyrics/contentRatingModel";
import { cn } from "@/lib/tailwindClassNames";

type ContentRatingState =
  { key: string; status: "checking" | "failed" } | { key: string; status: "done"; contentClass: ContentClass };

export type ContentRating = {
  status: "idle" | "checking" | "failed" | "done";
  /** The checked class, until the checked input changes. */
  contentClass: ContentClass | null;
  run: () => void;
};

/**
 * Checks the content policy class of an input only when asked, since a check
 * reads the work and possibly a whole lyrics file. A result belongs to the
 * input it was checked for: a new `key` drops it.
 */
export function useContentRating(key: string, check: () => Promise<ContentClass>): ContentRating {
  const [state, setState] = useState<ContentRatingState | null>(null);
  const current = state?.key === key ? state : null;
  const run = () => {
    setState({ key, status: "checking" });
    check()
      .then((contentClass) =>
        setState((latest) => (latest?.key === key ? { key, status: "done", contentClass } : latest)),
      )
      .catch(() => setState((latest) => (latest?.key === key ? { key, status: "failed" } : latest)));
  };
  return {
    status: current?.status ?? "idle",
    contentClass: current?.status === "done" ? current.contentClass : null,
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

const classBadges: Record<ContentClass, BadgeProps["variant"]> = {
  safe: "success",
  sensitive: "warning",
  unknown: "error",
  blocked: "error",
};

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
  const verdict =
    contentClass === null
      ? null
      : contentClass === "unknown" || contentClass === "blocked"
        ? t(`contentRating.${contentClass}`)
        : service === null
          ? contentClass === "safe"
            ? t("contentRating.safe")
            : t("contentRating.sensitive")
          : serviceReceives(contentClass, service)
            ? t("contentRating.receives", { service: service.name })
            : t("contentRating.notReceives", { service: service.name });
  const verdictClassName =
    contentClass === "unknown" || contentClass === "blocked"
      ? "text-error-foreground"
      : contentClass !== null && (service ? serviceReceives(contentClass, service) : contentClass === "safe")
        ? "text-muted-foreground"
        : "text-warning-foreground";
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
      {verdict && contentClass ? (
        <div className="flex items-start gap-2">
          <Badge variant={classBadges[contentClass]} className="mt-px shrink-0 px-1.5 py-0 text-2xs">
            {t(`contentRating.classes.${contentClass}`)}
          </Badge>
          <p className={cn("min-w-0 text-xs", verdictClassName)}>{verdict}</p>
        </div>
      ) : status === "failed" ? (
        <p className="text-xs text-error-foreground">{t("contentRating.failed")}</p>
      ) : (
        <p className="text-xs text-muted-foreground">{t("contentRating.hint")}</p>
      )}
    </div>
  );
}
