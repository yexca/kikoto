import { Card, CardContent } from "@/components/ui/card";
import {
  workCollectionClassName,
  workCollectionStyle,
  type WorkCollectionColumnSetting,
} from "@/components/work-collection/WorkCollectionLayout";

export function WorkCollectionLoadingState({
  label = "Loading works",
  mobileColumns = "auto",
  desktopColumns = "auto",
}: {
  label?: string;
  mobileColumns?: WorkCollectionColumnSetting;
  desktopColumns?: WorkCollectionColumnSetting;
}) {
  return (
    <div
      className={`${workCollectionClassName()} min-h-72`}
      style={workCollectionStyle(mobileColumns, desktopColumns)}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      <Card className="overflow-hidden" aria-hidden="true">
        <CardContent className="flex h-full flex-col p-0">
          <div className="h-40 animate-pulse bg-muted" />
          <div className="flex min-h-32 flex-1 flex-col gap-3 p-4">
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            <div className="mt-auto flex gap-2">
              <div className="h-6 w-16 animate-pulse rounded bg-muted" />
              <div className="h-6 w-20 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
