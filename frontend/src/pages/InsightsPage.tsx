import { ArchiveRestore } from "lucide-react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";

import { DemoListeningNotice } from "@/components/DemoReadOnlyNotice";
import { Button } from "@/components/ui/button";
import { contentPageClassName } from "@/components/ui/page-width";
import { ListeningHistoryPage, openLinkInPlace } from "@/features/listening-history/ListeningHistoryPage";
import { cn } from "@/lib/tailwindClassNames";
import { TIME_ZONE_SETTINGS_PATH, YOUR_DATA_SETTINGS_PATH } from "@/pages/settingsPaths";

/**
 * The account's own listening as one page: the listening dashboard, with the
 * way to Your data, where the same account exports and imports it, beside the
 * dashboard's other data actions, and the way to the account's time zone.
 * Demo states above it that its listening history is simulated.
 */
export function InsightsPage({
  listening,
  demoMode,
  onOpenPath,
}: {
  listening: Omit<ComponentProps<typeof ListeningHistoryPage>, "actions" | "timeZoneLink">;
  demoMode: boolean;
  onOpenPath: (path: string) => void;
}) {
  const { t } = useTranslation();
  const dataPath = YOUR_DATA_SETTINGS_PATH;
  return (
    <div className={cn(contentPageClassName, "space-y-5")}>
      {demoMode && <DemoListeningNotice />}
      <ListeningHistoryPage
        {...listening}
        timeZoneLink={{ href: TIME_ZONE_SETTINGS_PATH, open: () => onOpenPath(TIME_ZONE_SETTINGS_PATH) }}
        actions={
          <Button asChild variant="ghost" size="sm" className="shrink-0">
            <a
              href={dataPath}
              title={t("personal.insights.dataHint")}
              onClick={(event) => openLinkInPlace(event, { href: dataPath, open: () => onOpenPath(dataPath) })}
            >
              <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
              {t("nav.userData")}
            </a>
          </Button>
        }
      />
    </div>
  );
}
