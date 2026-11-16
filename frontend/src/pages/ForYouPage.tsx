import { Settings2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import {
  discoverCardLayout,
  DISCOVER_LAYOUT_STORE,
  useWorkCollectionLayout,
  WorkCollectionDisplayPicker,
} from "@/components/work-collection/WorkCollectionLayout";
import { ForYouView } from "@/features/for-you/ForYouView";
import { FOR_YOU_PANELS, forYouPanelFromSearch, type ForYouPanel } from "@/features/for-you/forYouPanels";
import { RecommendationActivity, UserPreferencePanels } from "@/features/preferences";
import { openWorkCodeRoute } from "@/features/work-detail/workDetailShared";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { cn } from "@/lib/tailwindClassNames";

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
 * temperature, with Discover's display choice. Recommendation tuning and the
 * account's recommendation activity open in a settings dialog, a sheet on
 * phones; saving the tuning draws again.
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

  const settings = panel && (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-1">
        <div role="tablist" aria-label={t("subscriptions.forYou.settings")} className={segmentedListClassName()}>
          {FOR_YOU_PANELS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              id={`for-you-settings-tab-${item}`}
              aria-selected={panel === item}
              aria-controls="for-you-settings-panel"
              className={segmentedItemClassName(panel === item)}
              onClick={() => showPanel(item)}
            >
              {t(`subscriptions.forYou.panels.${item}`)}
            </button>
          ))}
        </div>
        {/* The tabs name the panel, so it has no title bar; Close sits beside them. */}
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
      <div
        role="tabpanel"
        id="for-you-settings-panel"
        aria-labelledby={`for-you-settings-tab-${panel}`}
        className="min-w-0"
      >
        {panel === "tuning" ? (
          <UserPreferencePanels userId={userId} section="recommendation" readOnly={readOnly} />
        ) : (
          <RecommendationActivity userId={userId} />
        )}
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
        // One fixed height for both tabs, so switching tabs never resizes the dialog.
        <Dialog
          onClose={() => showPanel(null)}
          ariaLabel={t("subscriptions.forYou.settings")}
          size="2xl"
          className="h-[min(85dvh,var(--dialog-max-height))]"
        >
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
