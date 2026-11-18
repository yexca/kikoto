import { CloudDownload, Heart, Loader2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwindClassNames";

/**
 * The quiet look of a creator summary's personal actions: a muted ghost
 * control that names itself from tablet width, with the pressed state carried
 * by its icon rather than a filled button. The shared button keeps the 44px
 * touch target on coarse pointers.
 */
export const creatorQuietActionClassName =
  "h-8 w-8 px-0 text-muted-foreground hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground aria-pressed:text-foreground sm:w-auto sm:gap-1.5 sm:px-2 sm:text-xs";

/** The row of quiet actions in a creator summary, ending with the More menu. */
export function CreatorActionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-x-1 sm:gap-x-2 lg:justify-end" role="group" aria-label={label}>
      {children}
    </div>
  );
}

export function CreatorFavoriteButton({ favorite, onToggle }: { favorite: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const label = favorite ? t("creator.removeFavorite") : t("creator.addFavorite");
  return (
    <Button
      variant="ghost"
      size="icon"
      className={creatorQuietActionClassName}
      aria-label={label}
      aria-pressed={favorite}
      title={label}
      onClick={onToggle}
    >
      <Heart className={cn("h-4 w-4", favorite && "fill-current text-primary")} />
      <span className="hidden sm:inline">{t("detailActions.favorite")}</span>
    </Button>
  );
}

/**
 * The summary's More menu: the personal cover choice and the catalog
 * management entries. Callers pass only the entries the viewer may use, so a
 * listener without any sees no menu at all.
 */
export function CreatorMoreMenu({ label, items }: { label: string; items: ActionMenuItem[] }) {
  const { t } = useTranslation();
  return (
    <ActionMenu
      label={label}
      buttonLabel={t("detailActions.more")}
      items={items}
      triggerClassName={cn(creatorQuietActionClassName, "border-transparent bg-transparent")}
      buttonLabelClassName="hidden sm:inline"
      compact
    />
  );
}

/**
 * The summary's catalog refresh, for a viewer allowed to run it: First pull
 * until the catalog was pulled once, Refresh after that. While a refresh runs
 * it turns into the run's progress and opens the run for a viewer who may see
 * runs.
 */
export function CreatorRefreshButton({
  firstPull,
  refreshing,
  disabled,
  syncedAt,
  onRefresh,
  onOpenRun,
}: {
  firstPull: boolean;
  refreshing: boolean;
  disabled: boolean;
  /** When the catalog was last synced, already formatted. */
  syncedAt: string;
  onRefresh: () => void;
  onOpenRun?: () => void;
}) {
  const { t } = useTranslation();
  if (refreshing) {
    const label = onOpenRun ? t("detailActions.viewRefreshRun") : t("detailActions.catalogRefreshing");
    return (
      <Button
        variant="ghost"
        size="icon"
        className={creatorQuietActionClassName}
        aria-label={label}
        title={label}
        disabled={!onOpenRun}
        onClick={onOpenRun}
      >
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <span className="hidden sm:inline">{t("detailActions.refreshing")}</span>
      </Button>
    );
  }
  const label = firstPull ? t("detailActions.firstPull") : t("detailActions.refreshCatalog");
  const title = !firstPull && syncedAt ? t("detailActions.catalogSyncedAt", { time: syncedAt }) : label;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={creatorQuietActionClassName}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onRefresh}
    >
      {firstPull ? <CloudDownload className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}
