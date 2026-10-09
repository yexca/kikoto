import { PanelLeft, PanelLeftClose, PanelLeftOpen, PanelTop } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cx } from "@/lib/classNames";

/** Remembers whether a wide page rail names its items beside their icons. */
export function useRailLabelsShown(storageKey: string, fallback: boolean) {
  const [shown, setShown] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored === null ? fallback : stored === "true";
  });
  const toggle = () => {
    setShown((current) => {
      const next = !current;
      localStorage.setItem(storageKey, String(next));
      return next;
    });
  };
  return [shown, toggle] as const;
}

export type RailOrientation = "vertical" | "horizontal";

/** Remembers whether a wide page rail stands beside its page or runs as a row above it. */
export function useRailOrientation(storageKey: string) {
  const [orientation, setOrientation] = useState<RailOrientation>(() =>
    localStorage.getItem(storageKey) === "horizontal" ? "horizontal" : "vertical",
  );
  const toggle = () => {
    setOrientation((current) => {
      const next = current === "vertical" ? "horizontal" : "vertical";
      localStorage.setItem(storageKey, next);
      return next;
    });
  };
  return [orientation, toggle] as const;
}

/**
 * The button below a wide page rail that shows or hides its item names. Like
 * the app sidebar's collapse control, the icon-only state keeps its action as
 * the accessible name and tooltip.
 */
export function RailLabelsToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      className={cx(
        "h-11 shrink-0 gap-2 font-normal text-muted-foreground",
        expanded ? "w-full justify-start px-3" : "w-11 justify-center px-0",
      )}
      aria-label={expanded ? undefined : t("app.showTabNames")}
      title={expanded ? undefined : t("app.showTabNames")}
      onClick={onToggle}
    >
      {expanded ? <PanelLeftClose className="h-5 w-5" /> : <PanelLeftOpen className="h-5 w-5" />}
      {expanded && <span className="whitespace-nowrap text-sm">{t("app.hideTabNames")}</span>}
    </Button>
  );
}

/**
 * The button that moves a wide page rail between a column beside the page and
 * a row above it. Like the names toggle, the icon-only state keeps its action
 * as the accessible name and tooltip.
 */
export function RailOrientationToggle({
  orientation,
  expanded,
  onToggle,
}: {
  orientation: RailOrientation;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = t(orientation === "vertical" ? "app.showTabsAbove" : "app.showTabsBeside");
  const Icon = orientation === "vertical" ? PanelTop : PanelLeft;
  return (
    <Button
      variant="ghost"
      className={cx(
        "h-11 shrink-0 gap-2 font-normal text-muted-foreground",
        expanded ? "w-full justify-start px-3" : "w-11 justify-center px-0",
      )}
      aria-label={expanded ? undefined : label}
      title={expanded ? undefined : label}
      onClick={onToggle}
    >
      <Icon className="h-5 w-5" />
      {expanded && <span className="whitespace-nowrap text-sm">{label}</span>}
    </Button>
  );
}
