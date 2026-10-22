import {
  ExternalLink,
  ImageOff,
  Loader2,
  Pencil,
  RotateCcw,
  SearchCheck,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import type { MouseEventHandler, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { formatNumber } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { ageRatingPresentation } from "@/lib/ageRating";
import { assetURL, type MaintenanceWork } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { MetadataIssueDetails } from "./MetadataIssueDetails";
import { MetadataStatus, SourceStatus, canRetryMetadata, metadataRetryWorkId } from "./WorkMaintenanceStatus";

const VISIBLE_TAGS = 16;

/**
 * One work's saved metadata at a glance, beside the Metadata work table on
 * wide screens and in a sheet on narrower ones: identity, metadata and source
 * state with their recovery actions, the facts and tags a reader decides by,
 * and the way into the editor and the work page. It reads only the table row,
 * so opening it makes no request.
 */
export function WorkInspector({
  work,
  titleId,
  canSyncMetadata,
  canManageSources,
  disabled,
  retrying,
  checking,
  editing,
  onEdit,
  onRetry,
  onCheckSources,
  onOpenWork,
  onClose,
}: {
  work: MaintenanceWork;
  /** Id of the title, so the surrounding region or dialog can name itself after the work. */
  titleId: string;
  canSyncMetadata: boolean;
  canManageSources: boolean;
  /** The list is loading or failed, so recovery actions wait. */
  disabled: boolean;
  retrying: boolean;
  checking: boolean;
  editing: boolean;
  onEdit?: () => void;
  onRetry: (ids: number[]) => void;
  /** Present only where checking sources applies to this work. */
  onCheckSources?: () => void;
  onOpenWork: MouseEventHandler<HTMLAnchorElement>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const href = `/${encodeURIComponent(work.primaryCode)}`;
  const retryId = canSyncMetadata ? metadataRetryWorkId(work) : null;
  const ageRating = ageRatingPresentation(work.ageRating ?? "");
  const voices = work.voiceActors.filter(Boolean);
  const facts: Array<[string, ReactNode]> = [];
  if (work.releaseDate) facts.push([t("workMaintenance.inspector.releaseDate"), work.releaseDate]);
  if (ageRating.known)
    facts.push([
      t("workMaintenance.inspector.ageRating"),
      <span
        className={cn(
          "rounded-full border px-1.5 py-0.5 text-3xs font-semibold leading-none",
          ageRating.badgeClassName,
        )}
      >
        {ageRating.label}
      </span>,
    ]);
  if (work.series) facts.push([t("workMaintenance.inspector.series"), work.series]);
  if (voices.length > 0) facts.push([t("workMaintenance.inspector.voices"), voices.join(" · ")]);
  if (work.trackCount > 0)
    facts.push([t("workMaintenance.inspector.tracks"), formatNumber(work.trackCount, resolvedLocale)]);
  if (work.rating !== null)
    facts.push([
      t("workMaintenance.inspector.rating"),
      work.ratingCount
        ? t("workMaintenance.inspector.ratingWithCount", {
            rating: work.rating.toFixed(2),
            count: formatNumber(work.ratingCount, resolvedLocale),
          })
        : work.rating.toFixed(2),
    ]);
  if (work.sales !== null) facts.push([t("workMaintenance.inspector.sales"), formatNumber(work.sales, resolvedLocale)]);
  const tags = work.tags.filter(Boolean);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-start gap-3 p-4 pb-3">
        <div className="grid aspect-square w-20 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted ring-1 ring-foreground/5">
          {work.coverUrl ? (
            <img src={assetURL(work.coverUrl)} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImageOff className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-xs text-muted-foreground">{work.primaryCode}</p>
          <h3 id={titleId} className="mt-0.5 line-clamp-3 break-words text-sm font-semibold leading-snug">
            {work.title}
          </h3>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={work.circle}>
            {work.circle || t("workCard.unknownCircle")}
          </p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          className="-mr-1 -mt-1 shrink-0 text-muted-foreground"
          aria-label={t("workMaintenance.inspector.close")}
          title={t("workMaintenance.inspector.close")}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <dl className="mx-4 divide-y rounded-lg border text-sm">
        <StateLine label={t("workMaintenance.metadataColumn")}>
          <MetadataStatus work={work} known={canSyncMetadata} />
          {retryId !== null && canRetryMetadata(work) && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-7 px-2 text-xs"
              disabled={disabled || retrying}
              onClick={() => onRetry([retryId])}
            >
              <RotateCcw className={cn("h-3.5 w-3.5", retrying && "animate-spin")} />
              {t("workMaintenance.retry")}
            </Button>
          )}
        </StateLine>
        <StateLine label={t("workMaintenance.sourceColumn")}>
          <SourceStatus tier={work.sourceTier} />
          {onCheckSources && canManageSources && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-7 px-2 text-xs"
              disabled={disabled || checking}
              onClick={onCheckSources}
            >
              <SearchCheck className={cn("h-3.5 w-3.5", checking && "animate-pulse")} />
              {t("unlinked.checkSources")}
            </Button>
          )}
        </StateLine>
      </dl>
      {work.metadataIssues.length > 0 && (
        <div className="mx-4">
          <MetadataIssueDetails
            items={work.metadataIssues}
            disabled={disabled || retrying}
            defaultOpen
            onRetry={onRetry}
          />
        </div>
      )}

      {facts.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 pt-4 text-sm">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-xs leading-5 text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words leading-5">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <section className="px-4 pt-4" aria-label={t("workMaintenance.inspector.tags")}>
        <h4 className="text-xs text-muted-foreground">{t("workMaintenance.inspector.tags")}</h4>
        {tags.length > 0 ? (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {tags.slice(0, VISIBLE_TAGS).map((tag) => (
              <li
                key={tag}
                className="max-w-full truncate rounded-[var(--badge-radius)] bg-muted px-2 text-xs leading-6 text-muted-foreground"
              >
                {tag}
              </li>
            ))}
            {tags.length > VISIBLE_TAGS && (
              <li className="px-1 text-xs leading-6 text-muted-foreground">+{tags.length - VISIBLE_TAGS}</li>
            )}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">{t("workMaintenance.inspector.noTags")}</p>
        )}
      </section>

      <div className="mt-4 flex items-center gap-2 border-t p-3">
        {onEdit && (
          <Button size="sm" className="flex-1" disabled={editing} onClick={onEdit}>
            {editing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
            {t("detailActions.editMetadata")}
          </Button>
        )}
        <Button asChild size="sm" variant="outline" className={onEdit ? undefined : "flex-1"}>
          <a href={href} onClick={onOpenWork}>
            <SquareArrowOutUpRight className="h-4 w-4" />
            {t("workMaintenance.inspector.openWork")}
          </a>
        </Button>
        {work.dlsiteUrl && (
          <Button
            asChild
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground"
            title={t("unlinked.openDlsite")}
          >
            <a
              href={work.dlsiteUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={t("unlinked.openDlsiteFor", { code: work.primaryCode })}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

function StateLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-3 px-3 py-1.5">
      <dt className="w-16 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</dd>
    </div>
  );
}
