import { Settings2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import {
  discoverCardLayout,
  DISCOVER_LAYOUT_STORE,
  useWorkCollectionLayout,
  WorkCollectionDisplayPicker,
} from "@/components/work-collection/WorkCollectionLayout";
import { ForYouView } from "@/features/for-you/ForYouView";
import { forYouPanelFromSearch, type ForYouPanel } from "@/features/for-you/forYouPanels";
import { RecommendationActivity, UserPreferencePanels } from "@/features/preferences";
import { openWorkCodeRoute } from "@/features/work-detail/workDetailShared";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { cn } from "@/lib/tailwindClassNames";

const ACTIVITY_SECTION_ID = "for-you-settings-activity";

function replacePanel(panel: ForYouPanel | null) {
  const params = new URLSearchParams(window.location.search);
  if (panel) params.set("panel", panel);
  else params.delete("panel");
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`,
  );
}

/**
 * For you (`/for-you`): small draws from the local library under one
 * temperature, with Discover's display choice. The settings, a dialog or a
 * sheet on phones, hold the recommendation tuning followed by the account's
 * recommendation activity; saving the tuning draws again.
 */
export function ForYouPage({ userId, readOnly, canMark }: { userId: number; readOnly: boolean; canMark: boolean }) {
  const { t } = useTranslation();
  const mobile = useMobileNavigationLayout();
  const [panel, setPanel] = useState<ForYouPanel | null>(() => forYouPanelFromSearch(window.location.search));
  const layout = useWorkCollectionLayout(undefined, DISCOVER_LAYOUT_STORE);
  const cardLayout = discoverCardLayout(
    mobile ? layout.mobileCardMode : layout.desktopCardMode,
    !mobile,
    layout.mobileColumns,
  );

  useEffect(() => {
    const sync = () => setPanel(forYouPanelFromSearch(window.location.search));
    window.addEventListener(NAVIGATION_EVENT, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(NAVIGATION_EVENT, sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  const showPanel = (next: ForYouPanel | null) => {
    setPanel(next);
    replacePanel(next);
  };

  // `?panel=activity` opens the same settings at the activity report below the tuning.
  useEffect(() => {
    if (panel !== "activity") return;
    const frame = window.requestAnimationFrame(() =>
      document.getElementById(ACTIVITY_SECTION_ID)?.scrollIntoView({ block: "start" }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [panel]);

  const settings = panel && (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-1">
        <h2 className="min-w-0 truncate text-base font-semibold">{t("subscriptions.forYou.settings")}</h2>
        <Button
          variant="ghost"
          size={mobile ? "icon" : "icon-sm"}
          className={cn("shrink-0 text-muted-foreground", !mobile && "-mr-2")}
          aria-label={t("subscriptions.closeSettings")}
          title={t("subscriptions.closeSettings")}
          onClick={() => showPanel(null)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <UserPreferencePanels userId={userId} section="recommendation" readOnly={readOnly} />
      {/* The report is context for the tuning above it. */}
      <div id={ACTIVITY_SECTION_ID} className="min-w-0 scroll-mt-4 pt-4">
        <RecommendationActivity userId={userId} />
      </div>
    </div>
  );

  return (
    <div className="w-full space-y-5">
      <ForYouView
        canMark={canMark}
        cardLayout={cardLayout}
        mobileColumns={layout.mobileColumns}
        desktopColumns={layout.desktopColumns}
        onOpenWork={(code) => openWorkCodeRoute(code)}
        toolbar={
          <>
            <WorkCollectionDisplayPicker
              mobileColumns={layout.mobileColumns}
              desktopColumns={layout.desktopColumns}
              onMobileColumnsChange={layout.setMobileColumns}
              onDesktopColumnsChange={layout.setDesktopColumns}
              cardModes={{
                mobile: layout.mobileCardMode,
                desktop: layout.desktopCardMode,
                onMobileChange: layout.setMobileCardMode,
                onDesktopChange: layout.setDesktopCardMode,
              }}
            />
            <Button
              variant="toolbar"
              size="icon-sm"
              aria-haspopup="dialog"
              aria-expanded={Boolean(panel)}
              aria-label={t("subscriptions.forYou.settings")}
              title={t("subscriptions.forYou.settings")}
              onClick={() => showPanel("tuning")}
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          </>
        }
      />
      {settings && !mobile && (
        <Dialog onClose={() => showPanel(null)} ariaLabel={t("subscriptions.forYou.settings")} size="full">
          <DialogBody className="px-4">{settings}</DialogBody>
        </Dialog>
      )}
      {mobile && (
        <MobileSheet
          open={Boolean(settings)}
          onOpenChange={(open) => {
            if (!open) showPanel(null);
          }}
          ariaLabel={t("subscriptions.forYou.settings")}
          className="flex h-[85dvh] flex-col overflow-hidden"
        >
          <div className="app-scroll min-h-0 flex-1 overflow-y-auto p-4">{settings}</div>
        </MobileSheet>
      )}
    </div>
  );
}
