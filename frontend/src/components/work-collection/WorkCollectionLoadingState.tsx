import { Card, CardContent } from "@/components/ui/card";
import {
  workCollectionClassName,
  workCollectionStyle,
  type WorkCollectionColumnSetting,
} from "@/components/work-collection/WorkCollectionLayout";
import { useTranslation } from "react-i18next";

export function WorkCollectionLoadingState({
  label,
  mobileColumns = "auto",
  desktopColumns = "auto",
}: {
  label?: string;
  mobileColumns?: WorkCollectionColumnSetting;
  desktopColumns?: WorkCollectionColumnSetting;
}) {
  const { t } = useTranslation();
  const resolvedLabel = label ?? t("collection.loadingWorks");
  return (
    <div
      className={`${workCollectionClassName()} min-h-72`}
      style={workCollectionStyle(mobileColumns, desktopColumns)}
      role="status"
      aria-label={resolvedLabel}
      aria-busy="true"
    >
      <Card className="overflow-hidden" aria-hidden="true">
        <CardContent className="flex h-full flex-col p-0">
          <div className="p-1.5 pb-0">
            <div className="aspect-[4/3] animate-pulse rounded-[calc(var(--radius)-4px)] bg-muted" />
          </div>
          <div className="flex min-h-32 flex-1 flex-col gap-2.5 px-3 pb-3 pt-2.5">
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            <div className="mt-auto flex gap-1.5">
              <div className="h-6 w-16 animate-pulse rounded bg-muted" />
              <div className="h-6 w-20 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
