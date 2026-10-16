import { useTranslation } from "react-i18next";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { LLMAssessment } from "@/lib/llmApi";
import { serviceReceives, type ContentBoundary, type ContentClass } from "@/lib/contentPolicy";

export const contentClassBadges: Record<ContentClass, BadgeProps["variant"]> = {
  safe: "success",
  sensitive: "warning",
  restricted: "warning",
  unknown: "error",
  blocked: "error",
};

export function ContentAssessment({
  assessment,
  service,
}: {
  assessment: LLMAssessment;
  service: (ContentBoundary & { name: string }) | null;
}) {
  const { t } = useTranslation();
  const refused = assessment.class === "unknown" || assessment.class === "blocked";
  const allowed = service !== null && serviceReceives(assessment.class, service);
  return (
    <div role="status" className="space-y-1.5 text-xs">
      {assessment.mode === "translation_text" && (
        <>
          <p className="text-muted-foreground">{t("contentRating.translationText")}</p>
          <p className="text-muted-foreground">
            {t("contentRating.checkedFields", {
              fields: (assessment.checkedFields ?? [])
                .map((field) => t(`maintenance.llm.ruleFields.${field}`))
                .join(" / "),
            })}
          </p>
          {assessment.class === "safe" && <p className="text-muted-foreground">{t("contentRating.noKeywordMatch")}</p>}
          {!assessment.keywordRuleCount && (
            <p className="text-warning-foreground">{t("contentRating.noApplicableKeywords")}</p>
          )}
        </>
      )}
      <div className="flex items-start gap-2">
        <Badge variant={contentClassBadges[assessment.class]} className="mt-px shrink-0 px-1.5 py-0 text-2xs">
          {t(`contentRating.classes.${assessment.class}`)}
        </Badge>
        <p
          className={
            refused
              ? "text-error-foreground"
              : service && !allowed
                ? "text-warning-foreground"
                : "text-muted-foreground"
          }
        >
          {refused
            ? t(`contentRating.${assessment.class}`)
            : service
              ? t(allowed ? "contentRating.receives" : "contentRating.notReceives", { service: service.name })
              : t(`contentRating.${assessment.class}`)}
        </p>
      </div>
      {service && (
        <p className="text-muted-foreground">
          {t("contentRating.maximum", { maximum: t(`contentRating.classes.${service.maxContentClass}`) })}
        </p>
      )}
      {assessment.matches.map((match, index) => (
        <p key={index} className="break-words text-muted-foreground">
          {match.rule}
          {match.field ? ` · ${t(`maintenance.llm.ruleFields.${match.field}`)}` : ""}
          {match.action ? ` · ${t(`contentRating.classes.${match.action}`)}` : ""}
        </p>
      ))}
    </div>
  );
}
