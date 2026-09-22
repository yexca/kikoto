import { ChevronRight, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
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
  const { resolvedLocale } = useLocale();
  return (
    <details className="group mt-1.5 text-xs">
      <summary className="-ml-0.5 inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-6 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
        {t("workMaintenance.details", { count: items.length })}
      </summary>
      <ul className="mt-1 max-w-2xl divide-y overflow-hidden rounded-md border bg-background/50">
        {items.map((item) => (
          <li
            key={`${item.workId}:${item.providerCode}`}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2"
          >
            <div className="min-w-0 space-y-1">
              <p className="break-words font-medium">
                <span className="font-mono">{item.primaryCode}</span>
                <span className="text-muted-foreground"> · {item.providerName}</span>
              </p>
              {item.issues.map((issue) => (
                <p key={issue.component} className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      issue.status === "unavailable" ? "bg-error" : "bg-warning"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="text-foreground">
                    {t(
                      issue.status === "unavailable"
                        ? "metadataIssues.unavailable"
                        : issue.component === "cover"
                          ? "metadataIssues.coverFailed"
                          : "metadataIssues.metadataFailed",
                    )}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{t("metadataIssues.attempts", { count: issue.failureCount })}</span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={issue.checkedAt}>
                    {formatDateTime(issue.checkedAt, resolvedLocale) || issue.checkedAt}
                  </time>
                </p>
              ))}
            </div>
            {item.providerCode === "dlsite" && (
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={disabled || item.retrying}
                onClick={() => onRetry([item.workId])}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t("workMaintenance.retryEdition", { code: item.primaryCode })}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
