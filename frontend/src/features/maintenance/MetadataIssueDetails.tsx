import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { MetadataIssueWork } from "@/lib/api";

export function MetadataIssueDetails({
  items,
  disabled,
  onRetry,
}: {
  items: MetadataIssueWork[];
  disabled: boolean;
  onRetry: (ids: number[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <details className="mt-2 text-xs">
      <summary className="min-h-11 cursor-pointer py-3 text-muted-foreground sm:min-h-0 sm:py-1">
        {t("workMaintenance.details", { count: items.length })}
      </summary>
      <ul className="space-y-3 py-2">
        {items.map((item) => (
          <li key={`${item.workId}:${item.providerCode}`} className="space-y-1">
            <p className="break-words font-medium">
              {item.primaryCode} · {item.providerName}
            </p>
            {item.issues.map((issue) => (
              <p key={issue.component} className="text-muted-foreground">
                {t(
                  issue.status === "unavailable"
                    ? "metadataIssues.unavailable"
                    : issue.component === "cover"
                      ? "metadataIssues.coverFailed"
                      : "metadataIssues.metadataFailed",
                )}
                {" · "}
                {t("metadataIssues.attempts", { count: issue.failureCount })}
                {" · "}
                {issue.checkedAt}
              </p>
            ))}
            {item.providerCode === "dlsite" && (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || item.retrying}
                onClick={() => onRetry([item.workId])}
              >
                {t("workMaintenance.retryEdition", { code: item.primaryCode })}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
