import { Heart, Loader2 } from "lucide-react";
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

/**
 * The row of personal actions and the More menu under a creator summary, with
 * the personal tags as chips at its end, so the tags need no row of their own.
 */
export function CreatorActionRow({
  label,
  tags,
  children,
}: {
  label: string;
  /** The personal tag chips and their editor. */
  tags?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-2 sm:gap-x-2 lg:justify-end">
      <div className="flex min-w-0 items-center gap-x-1 sm:gap-x-2" role="group" aria-label={label}>
        {children}
      </div>
      {tags && <div className="flex min-w-0 flex-wrap items-center gap-1 sm:ml-1">{tags}</div>}
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
    />
  );
}

/**
 * The line under a creator's catalog statistics. It appears only when it
 * explains something: while a catalog refresh runs, or while the catalog was
 * never pulled, when only works the library already knows are listed. A
 * viewer allowed to pull finds the pull right there as a quiet link, so the
 * summary needs no standing button for it.
 */
export function CreatorCatalogNote({
  refreshing,
  notPulled,
  onOpenRun,
  onPull,
}: {
  refreshing: boolean;
  notPulled: boolean;
  /** Opens the running refresh in Activity, for a viewer who may see runs. */
  onOpenRun?: () => void;
  /** Queues the first pull, for a viewer allowed to refresh the catalog. */
  onPull?: () => void;
}) {
  const { t } = useTranslation();
  if (refreshing) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1" role="status">
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {t("detailActions.catalogRefreshing")}
        </span>
        {onOpenRun && <NoteLink onClick={onOpenRun}>{t("detailActions.viewRefreshRun")}</NoteLink>}
      </p>
    );
  }
  if (!notPulled) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{t("detailActions.catalogNotPulledHint")}</span>
      {onPull && <NoteLink onClick={onPull}>{t("detailActions.pullCatalog")}</NoteLink>}
    </p>
  );
}

function NoteLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="touch-target relative rounded-sm font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
