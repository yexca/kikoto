import { WorkDescription } from "./metadata/WorkDescription";
import {
  api,
  assetURL,
  type StaffCredit,
  type StaffRole,
  type VoiceCredit,
  type WorkDetail,
  type WorkMetadataPresentation,
  type WorkMetadataSyncStatus,
} from "@/lib/api";
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  type ActiveSourceInfoModel,
  detailReturnTarget,
  formatDateTime,
  openDetailTagSearch,
} from "@/features/work-detail/workDetailHelpers";
import { PageHeaderDetail, usePageHeaderBack } from "@/app/pageHeader";
import i18n from "@/i18n";
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleUserRound,
  Clock3,
  Cloud,
  CloudOff,
  ExternalLink,
  GitBranchPlus,
  HardDrive,
  Link2,
  RefreshCw,
  Star,
  UsersRound,
} from "lucide-react";
import { openVoiceRoute } from "@/lib/voiceNavigationState";
import { voiceDetailPath } from "@/lib/voiceRoute";
import { useAuth } from "@/auth/AuthProvider";
import { toastFromError, useToast } from "@/components/ui/toast";
import { badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwindClassNames";
import { openCircleRoute, openCircleSeriesRoute } from "@/lib/circleNavigationState";
import {
  type WorkVersionAvailabilityScope,
  workVersionAvailableForScope,
} from "@/features/work-detail/workVersionModel";
import type { WorkPreview } from "@/features/work-detail/workDetailShared";
import { metadataSourceGroups } from "@/features/work-detail/metadataPresentationModel";
import type { UserTagRowLayout } from "@/components/UserTagRow";
import {
  type DirectoryEditionInput,
  directoryEditionModel,
  MetadataLanguageMenu,
  WorkVersionMenus,
} from "@/features/work-detail/WorkVersionMenus";
import { ageRatingPresentation } from "@/lib/ageRating";
import { copyText } from "@/lib/clipboard";
import { openLibraryAgeRatingSearch } from "@/lib/libraryAgeRatingSearch";
import { formatBytes, formatDuration } from "@/features/work-detail/media/mediaTreeModel";
import { sourceTabStatusClass } from "@/features/work-detail/source/sourceContextModel";
import { historyStateWithReturn, NAVIGATION_EVENT } from "@/lib/browserHistory";
import { CompactDetailTabs } from "@/features/work-detail/CompactDetailTabs";
import { DetailBundleLine } from "@/features/work-detail/DetailBundleLine";
import { DetailPurchaseBonusLine } from "@/features/work-detail/DetailPurchaseBonusLine";

export type UnifiedWorkDetailPresentation = {
  coverUrl: string;
  fallbackCode: string;
  code: string;
  dlsiteUrl: string;
  /** A custom work has no provider rating or sales to show. */
  customWork?: boolean;
  title: string;
  description?: string;
  circle: string;
  circleExternalId: string;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  ratingLabel: string;
  rating: number | null;
  ratingCount: number | null;
  /** The viewer's own rating of a persisted work, null when unrated; absent for a remote-only work. */
  userRating?: number | null;
  sales: number | null;
  baseCode?: string;
  metadataLanguage?: string;
  metadataPresentation?: WorkMetadataPresentation;
  metadataSync?: WorkMetadataSyncStatus;
  canSyncMetadata?: boolean;
  metadataSyncBusy?: boolean;
  onSyncMetadata?: () => void;
  onLinkMetadata?: () => void;
  activeMetadataVariantKey?: string;
  onMetadataVariantSelect?: (key: string) => void;
  translations?: WorkDetail["translations"];
  activeVersionCode?: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  remoteVersions?: boolean;
  dlsiteFetchedAt: string;
  releaseDate: string;
  ageRating: string;
  sourceInfo: ActiveSourceInfoModel;
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  /** Non-voice credits, shown in their own card above Source info. */
  staffCredits?: StaffCredit[];
  purchaseBonus?: WorkDetail["purchaseBonus"];
  purchaseBonuses?: WorkDetail["purchaseBonuses"];
  bundleMembers?: WorkDetail["bundleMembers"];
  includedInBundles?: WorkDetail["includedInBundles"];
  tags: string[];
  /**
   * Renders the viewer's personal tag chips and editor; absent for a remote-only
   * work. The phone layout places the provider tags between them.
   */
  personalTags?: (layout?: UserTagRowLayout) => ReactNode;
  loading?: boolean;
};

export function UnifiedWorkDetailPage({
  presentation,
  compact,
  mobileTab,
  onMobileTabChange,
  actions,
  sourceActions,
  directory,
  onBack,
  children,
}: {
  presentation: UnifiedWorkDetailPresentation;
  compact: boolean;
  mobileTab: "info" | "directory";
  onMobileTabChange: (tab: "info" | "directory") => void;
  /** The Hero actions: one primary action, then the quiet personal and Manage controls. */
  actions: ReactNode;
  /** The selected source's actions, listed in Source info. */
  sourceActions?: ReactNode;
  directory: ReactNode;
  onBack: () => void;
  children?: ReactNode;
}) {
  usePageHeaderBack({
    label: detailReturnTarget("library").label,
    title: presentation.title,
    onBack,
  });

  return (
    <div className="space-y-5">
      {compact ? (
        <MobileWorkDetailLayout
          {...presentation}
          activeTab={mobileTab}
          onActiveTabChange={onMobileTabChange}
          actions={actions}
          sourceActions={sourceActions}
          directory={directory}
        />
      ) : (
        <DesktopWorkDetailLayout
          {...presentation}
          actions={actions}
          sourceActions={sourceActions}
          directory={directory}
        />
      )}
      {children}
    </div>
  );
}

function DesktopWorkDetailLayout({
  actions,
  sourceActions,
  directory,
  ...presentation
}: UnifiedWorkDetailPresentation & {
  actions: ReactNode;
  sourceActions?: ReactNode;
  directory: ReactNode;
}) {
  const {
    coverUrl,
    fallbackCode,
    code,
    dlsiteUrl,
    title,
    circle,
    circleExternalId,
    series,
    seriesTitleId,
    seriesCircleExternalId,
    loading = false,
    metadataSync,
    canSyncMetadata = false,
    metadataSyncBusy = false,
    onSyncMetadata,
    onLinkMetadata,
    sourceInfo,
    voiceActors,
    voiceCredits,
    purchaseBonus,
    purchaseBonuses,
    bundleMembers,
    includedInBundles,
    tags,
    personalTags,
    dlsiteFetchedAt,
    staffCredits,
  } = presentation;
  const entityResolver = useDetailEntityResolver(code);
  const versionMenu = detailVersionMenu(presentation);

  return (
    <div className="space-y-6">
      {/* The cover tint alone sets the Hero apart from the page; it draws no frame. */}
      <section
        className="relative isolate overflow-clip rounded-xl bg-card"
        data-testid="detail-hero"
        aria-label={title}
      >
        {coverUrl && (
          <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
            <img
              src={assetURL(coverUrl)}
              alt=""
              className="h-full w-full scale-125 object-cover opacity-30 blur-3xl saturate-150"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-card/30 via-card/75 to-card" />
          </div>
        )}
        <div className="grid gap-6 p-5 md:grid-cols-[minmax(13rem,0.9fr)_minmax(0,1.6fr)] lg:p-6 xl:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
          <div
            className="self-start overflow-hidden rounded-lg bg-muted shadow-xl ring-1 ring-border"
            data-testid="detail-cover"
          >
            <div className="aspect-[4/3]">
              {coverUrl ? (
                <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-contain" />
              ) : (
                <div className="grid h-full place-items-center text-4xl font-bold">{fallbackCode.slice(0, 2)}</div>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <DetailTitleBlock
              fallbackCode={fallbackCode}
              code={code}
              dlsiteUrl={dlsiteUrl}
              title={title}
              circle={circle}
              circleExternalId={circleExternalId}
              series={series}
              seriesTitleId={seriesTitleId}
              seriesCircleExternalId={seriesCircleExternalId}
              loading={loading}
              entityResolver={entityResolver}
              versionMenu={versionMenu}
            />
            <DetailCreditLine voiceActors={voiceActors} voiceCredits={voiceCredits} entityResolver={entityResolver} />
            <DetailPurchaseBonusLine purchaseBonus={purchaseBonus} purchaseBonuses={purchaseBonuses} />
            <DetailBundleLine bundleMembers={bundleMembers} includedInBundles={includedInBundles} />
            <DetailTagLine tags={tags} personalTags={personalTags} />
            <DetailStatStrip {...presentation} />
            <MetadataSyncNotice
              sync={metadataSync}
              canSync={Boolean(canSyncMetadata && onSyncMetadata)}
              busy={metadataSyncBusy}
              onSync={onSyncMetadata}
              onLink={onLinkMetadata}
            />
            <div
              data-testid="hero-actions"
              className="mt-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 pt-1"
            >
              {actions}
            </div>
          </div>
        </div>
      </section>

      {/* The files lead the main column. The side column reads like the work's
          own page: what it is, who made it, then the facts and actions of the
          shown source. It scrolls with the page, so the cards after a long
          description stay reachable. Below xl the side column follows the
          files in the same order. */}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">{directory}</div>
        <div className="min-w-0 space-y-4">
          <WorkDescription description={presentation.description} />
          <DetailStaffCredits credits={staffCredits} />
          <DetailInfoPanel sourceInfo={sourceInfo} dlsiteFetchedAt={dlsiteFetchedAt} actions={sourceActions} />
        </div>
      </div>
    </div>
  );
}

function DetailInfoPanel({
  sourceInfo,
  dlsiteFetchedAt,
  actions,
}: Pick<UnifiedWorkDetailPresentation, "sourceInfo" | "dlsiteFetchedAt"> & {
  /** The selected source's actions; a viewer allowed none sees the panel without them. */
  actions?: ReactNode;
}) {
  return (
    <aside
      className="min-w-0 divide-y overflow-hidden rounded-xl border bg-card"
      aria-label={i18n.t("libraryDetail.sourceInfo")}
      data-testid="detail-source-metadata"
    >
      <ActiveSourceInfo info={sourceInfo} />
      {actions && <div className="p-2 empty:hidden">{actions}</div>}
      {dlsiteFetchedAt && (
        <div className="flex items-center gap-2 px-4 py-3 text-2xs text-muted-foreground">
          <Clock3 className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate tabular-nums">
            {i18n.t("libraryDetail.metadataUpdatedAt", { time: dlsiteFetchedAt })}
          </span>
        </div>
      )}
    </aside>
  );
}

const staffRoleOrder: StaffRole[] = ["author", "scenario", "illustration", "music", "other"];

/** The work's staff by role; each name searches the library for works crediting it in any staff role. */
function DetailStaffCredits({ credits = [] }: { credits?: StaffCredit[] }) {
  const headingId = useId();
  const groups = staffRoleOrder
    .map((role) => ({
      role,
      // Provider data can list a name twice in one role; it is credited once.
      names: [...new Set(credits.filter((credit) => credit.role === role).map((credit) => credit.name))],
    }))
    .filter((group) => group.names.length > 0);
  if (groups.length === 0) return null;
  return (
    <section className="min-w-0 rounded-xl border bg-card p-4 text-sm" aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <UsersRound className="h-4 w-4 shrink-0" />
        {i18n.t("libraryDetail.staffCredits")}
      </h2>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        {groups.map((group) => (
          <Fragment key={group.role}>
            <dt className="text-muted-foreground">{i18n.t(`libraryDetail.staffRoles.${group.role}`)}</dt>
            <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-1">
              {group.names.map((name, index) => (
                <span key={name} className="inline-flex min-w-0 items-baseline">
                  <button
                    type="button"
                    className="min-w-0 break-words rounded-sm text-left font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
                    title={i18n.t("libraryDetail.searchStaff", { name })}
                    onClick={() => openDetailTagSearch("staff", name)}
                  >
                    {name}
                  </button>
                  {index < group.names.length - 1 && <span className="ml-1 text-muted-foreground">·</span>}
                </span>
              ))}
            </dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

function DetailTagLine({ tags, personalTags }: Pick<UnifiedWorkDetailPresentation, "tags" | "personalTags">) {
  const [expanded, setExpanded] = useState(false);
  const collapsedCount = 12;
  const visibleTags = expanded ? tags : tags.slice(0, collapsedCount);
  const hiddenCount = tags.length - visibleTags.length;
  if (tags.length === 0 && !personalTags) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="detail-identity-metadata">
      {tags.length > 0 && (
        <ul className="contents" aria-label={i18n.t("libraryDetail.tags")}>
          {visibleTags.map((tag) => (
            <li key={tag} className="contents">
              <DetailTagChip tag={tag} />
            </li>
          ))}
        </ul>
      )}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="inline-flex h-[26px] items-center rounded-full px-2 text-xs font-medium text-muted-foreground hover:text-primary"
          aria-expanded={false}
          aria-label={`${i18n.t("libraryDetail.tags")} +${hiddenCount}`}
          onClick={() => setExpanded(true)}
        >
          +{hiddenCount}
        </button>
      )}
      {personalTags?.()}
    </div>
  );
}

/**
 * The phone tag row: one line that scrolls sideways into the left page gutter,
 * with the viewer's personal tags first, then every provider tag, and the
 * personal tag editor pinned at its end.
 */
function MobileDetailTagLine({ tags, personalTags }: Pick<UnifiedWorkDetailPresentation, "tags" | "personalTags">) {
  if (tags.length === 0 && !personalTags) return null;
  const providerTags =
    tags.length > 0 ? (
      <ul className="contents" aria-label={i18n.t("libraryDetail.tags")}>
        {tags.map((tag) => (
          <li key={tag} className="contents">
            <DetailTagChip tag={tag} />
          </li>
        ))}
      </ul>
    ) : undefined;
  const noTags =
    tags.length === 0 ? (
      <span className="whitespace-nowrap text-xs text-muted-foreground">{i18n.t("libraryDetail.noTags")}</span>
    ) : undefined;
  return (
    // The flow root keeps the strip's focus-ring padding out of the Hero spacing.
    <div className="flow-root" data-testid="detail-identity-metadata">
      <div className="scrollbar-hidden -my-1 -ml-4 overflow-x-auto overflow-y-hidden overscroll-x-contain py-1 pl-4">
        <div className="flex w-max min-w-full items-center gap-1.5">
          {personalTags
            ? personalTags({
                after: providerTags,
                placeholder: noTags,
                // The page background and its fade let the tags scroll under the pinned editor.
                triggerClassName:
                  "sticky right-0 ml-auto shrink-0 bg-background pl-1.5 before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-4 before:bg-gradient-to-l before:from-background before:to-transparent",
              })
            : providerTags}
        </div>
      </div>
    </div>
  );
}

function DetailTagChip({ tag }: { tag: string }) {
  return (
    <button
      type="button"
      className="inline-flex h-[26px] max-w-48 items-center rounded-full border bg-background/60 px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
      title={tag}
      onClick={() => openDetailTagSearch("tag", tag)}
    >
      <span className="truncate">{tag}</span>
    </button>
  );
}

function detailVersionMenu(presentation: DetailVersionPresentation) {
  const { metadataLanguage, metadataPresentation, baseCode, translations = [] } = presentation;
  const hasVersionControls =
    metadataLanguage || (metadataPresentation?.variants.length ?? 0) > 0 || baseCode || translations.length > 0;
  if (!hasVersionControls) return null;
  return (
    <WorkVersionMenus
      metadataLanguage={metadataLanguage ?? ""}
      metadataPresentation={metadataPresentation}
      activeMetadataVariantKey={presentation.activeMetadataVariantKey ?? ""}
      onMetadataVariantSelect={presentation.onMetadataVariantSelect}
      edition={detailEditionInput(presentation)}
    />
  );
}

type DetailVersionPresentation = Pick<
  UnifiedWorkDetailPresentation,
  | "code"
  | "baseCode"
  | "metadataLanguage"
  | "metadataPresentation"
  | "activeMetadataVariantKey"
  | "onMetadataVariantSelect"
  | "translations"
  | "activeVersionCode"
  | "onVersionSelect"
  | "remoteVersions"
>;

function detailEditionInput({
  code,
  baseCode,
  translations = [],
  activeVersionCode,
  onVersionSelect,
  remoteVersions,
}: DetailVersionPresentation): DirectoryEditionInput {
  const availabilityScope: WorkVersionAvailabilityScope = remoteVersions ? "source" : "local";
  const baseTranslation = translations.find(
    (translation) => translation.primaryCode.toUpperCase() === (baseCode ?? "").toUpperCase(),
  );
  return {
    baseCode: baseCode ?? "",
    baseAvailable: Boolean(baseTranslation && workVersionAvailableForScope(baseTranslation, availabilityScope)),
    translations,
    activeVersionCode: activeVersionCode ?? code,
    onVersionSelect,
    remoteVersions: remoteVersions ?? false,
  };
}

function DetailCreditLine({
  voiceActors,
  voiceCredits,
  entityResolver,
}: {
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  entityResolver: DetailEntityResolver;
}) {
  const credits =
    voiceCredits.length > 0
      ? voiceCredits
      : voiceActors.map((displayName): VoiceCredit => ({ personId: 0, routeKey: "", displayName }));
  return (
    <div className="flex min-w-0 items-baseline gap-3 text-sm" aria-label={i18n.t("libraryDetail.voiceActors")}>
      <span className="shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">CV</span>
      {credits.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-1">
          {credits.map((credit, index) => (
            <span key={`${credit.personId}:${credit.displayName}`} className="inline-flex items-baseline">
              <button
                type="button"
                className="rounded-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
                onClick={() =>
                  voiceDetailPath(credit.routeKey)
                    ? openVoiceRoute(credit.routeKey)
                    : entityResolver.resolveEntity("voice", credit.displayName)
                }
              >
                {credit.displayName}
              </button>
              {index < credits.length - 1 && <span className="ml-1 text-muted-foreground">·</span>}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-muted-foreground">{i18n.t("libraryDetail.noVoiceActorMetadata")}</span>
      )}
    </div>
  );
}

function DetailStatStrip({
  ratingLabel,
  rating,
  ratingCount,
  userRating,
  sales,
  customWork = false,
  releaseDate,
  ageRating,
  sourceInfo,
  compact = false,
}: Pick<
  UnifiedWorkDetailPresentation,
  | "ratingLabel"
  | "rating"
  | "ratingCount"
  | "userRating"
  | "sales"
  | "customWork"
  | "releaseDate"
  | "ageRating"
  | "sourceInfo"
> & { compact?: boolean }) {
  const normalizedRatingLabel = ratingLabel.toLowerCase().includes("dl") ? i18n.t("workCard.ratingShort") : ratingLabel;
  const age = ageRatingPresentation(ageRating);
  const hasMeasuredDuration = sourceInfo.stats.knownDurationMedia > 0;
  const durationSeconds = hasMeasuredDuration ? sourceInfo.stats.durationSeconds : sourceInfo.metadataDurationSeconds;
  const releaseDay = /^\d{4}-\d{2}-\d{2}/.test(releaseDate) ? releaseDate.slice(0, 10) : releaseDate;
  const stats: { key: string; label: string; value: ReactNode; detail?: string; valueClassName?: string }[] = [
    {
      key: "rating",
      label: normalizedRatingLabel,
      value:
        rating === null ? (
          "—"
        ) : (
          <span className="inline-flex items-baseline gap-1">
            <Star className="h-3 w-3 self-center fill-current text-warning" aria-hidden="true" />
            {rating.toFixed(2)}
          </span>
        ),
      detail: ratingCount ? ratingCount.toLocaleString() : undefined,
    },
    {
      key: "userRating",
      label: compact ? i18n.t("workCard.userRatingShort") : i18n.t("workCard.userRating"),
      value: userRating ? (
        <span
          className="inline-flex items-baseline gap-1"
          aria-label={i18n.t("workCard.userRatingValue", { value: userRating })}
        >
          <Star className="h-3 w-3 self-center fill-current text-primary" aria-hidden="true" />
          {userRating}
        </span>
      ) : (
        "—"
      ),
    },
    {
      key: "age",
      label: i18n.t("library.searchClauseKinds.age"),
      value: age.known ? (
        <button
          type="button"
          className="touch-target relative rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={i18n.t("library.searchClauseLabels.age", { value: age.label })}
          onClick={() => openLibraryAgeRatingSearch(ageRating)}
        >
          {age.label}
        </button>
      ) : (
        "—"
      ),
      valueClassName: age.textClassName,
    },
    {
      key: "sales",
      label: i18n.t("library.sortOptions.sales"),
      value: sales === null ? "—" : sales.toLocaleString(),
    },
    {
      key: "released",
      label: i18n.t("libraryDetail.released"),
      value: releaseDay || "—",
    },
    {
      key: "duration",
      label: compact
        ? i18n.t("libraryDetail.durationShort")
        : hasMeasuredDuration
          ? i18n.t("libraryDetail.playableDuration")
          : i18n.t("libraryDetail.metadataDuration"),
      value: durationSeconds ? formatDuration(durationSeconds) : sourceInfo.loading ? "…" : "—",
    },
  ].filter(
    (stat) =>
      (!customWork || (stat.key !== "rating" && stat.key !== "sales")) &&
      (stat.key !== "userRating" || userRating !== undefined),
  );
  // The figures draw no box of their own. Wider layouts set them off from the tags with a hairline
  // only as wide as the figures; a phone drops it, sits the row close under the tags, and scrolls
  // it sideways once the figures outgrow the row.
  return (
    <dl
      data-testid="dlsite-info"
      className={
        compact
          ? "-mt-1 flex w-fit max-w-full gap-x-2 overflow-x-auto overflow-y-hidden min-[360px]:gap-x-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "flex w-fit max-w-full flex-wrap gap-x-7 gap-y-2 self-start border-t border-border/70 pt-3"
      }
    >
      {stats.map((stat) => (
        <div key={stat.key} className="min-w-0 shrink-0">
          <dt className="whitespace-nowrap text-2xs font-medium text-muted-foreground">{stat.label}</dt>
          <dd
            className={`${compact ? "" : "mt-0.5 "}whitespace-nowrap font-semibold tabular-nums text-sm ${stat.valueClassName || "text-foreground"}`}
          >
            {stat.value}
            {stat.detail && (
              <span
                className={`ml-1 text-2xs font-normal text-muted-foreground ${compact ? "max-[359px]:hidden" : ""}`}
              >
                ({stat.detail})
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function MobileWorkDetailLayout({
  coverUrl,
  fallbackCode,
  code,
  dlsiteUrl,
  title,
  description,
  circle,
  circleExternalId,
  series,
  seriesTitleId,
  seriesCircleExternalId,
  ratingLabel,
  rating,
  userRating,
  ratingCount,
  sales,
  customWork,
  baseCode,
  metadataLanguage,
  metadataPresentation,
  metadataSync,
  canSyncMetadata = false,
  metadataSyncBusy = false,
  onSyncMetadata,
  onLinkMetadata,
  activeMetadataVariantKey,
  onMetadataVariantSelect,
  translations,
  activeVersionCode,
  onVersionSelect,
  remoteVersions,
  dlsiteFetchedAt,
  releaseDate,
  ageRating,
  sourceInfo,
  voiceActors,
  voiceCredits,
  staffCredits,
  purchaseBonus,
  purchaseBonuses,
  bundleMembers,
  includedInBundles,
  tags,
  personalTags,
  loading,
  activeTab,
  onActiveTabChange,
  actions,
  sourceActions,
  directory,
}: {
  coverUrl: string;
  fallbackCode: string;
  code: string;
  dlsiteUrl: string;
  title: string;
  description?: string;
  circle: string;
  circleExternalId: string;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  ratingLabel: string;
  rating: number | null;
  userRating?: number | null;
  ratingCount: number | null;
  sales: number | null;
  customWork?: boolean;
  baseCode?: string;
  metadataLanguage?: string;
  metadataPresentation?: WorkMetadataPresentation;
  metadataSync?: WorkMetadataSyncStatus;
  canSyncMetadata?: boolean;
  metadataSyncBusy?: boolean;
  onSyncMetadata?: () => void;
  onLinkMetadata?: () => void;
  activeMetadataVariantKey?: string;
  onMetadataVariantSelect?: (key: string) => void;
  translations?: WorkDetail["translations"];
  activeVersionCode?: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  remoteVersions?: boolean;
  dlsiteFetchedAt: string;
  releaseDate: string;
  ageRating: string;
  sourceInfo: ActiveSourceInfoModel;
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  staffCredits?: StaffCredit[];
  purchaseBonus?: WorkDetail["purchaseBonus"];
  purchaseBonuses?: WorkDetail["purchaseBonuses"];
  bundleMembers?: WorkDetail["bundleMembers"];
  includedInBundles?: WorkDetail["includedInBundles"];
  tags: string[];
  personalTags?: UnifiedWorkDetailPresentation["personalTags"];
  loading?: boolean;
  activeTab: "info" | "directory";
  onActiveTabChange: (tab: "info" | "directory") => void;
  actions: ReactNode;
  /** The selected source's actions, listed in the Info tab's Source info. */
  sourceActions?: ReactNode;
  directory: ReactNode;
}) {
  const entityResolver = useDetailEntityResolver(code);
  const [infoCollapsed, toggleInfoCollapsed] = useDetailInfoCollapsed();
  return (
    <section className="space-y-4">
      <div className="relative isolate">
        {coverUrl && (
          <img
            src={assetURL(coverUrl)}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10 h-full w-full scale-y-110 object-cover opacity-40 blur-2xl saturate-150"
          />
        )}
        <div className="overflow-hidden rounded-lg bg-muted shadow-lg ring-1 ring-border">
          <div className="aspect-[4/3] max-h-[58vh]">
            {coverUrl ? (
              <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-contain" />
            ) : (
              <div className="grid h-full place-items-center text-4xl font-bold">{fallbackCode.slice(0, 2)}</div>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <MobileDetailIdentity
          fallbackCode={fallbackCode}
          code={code}
          dlsiteUrl={dlsiteUrl}
          title={title}
          circle={circle}
          circleExternalId={circleExternalId}
          series={series}
          seriesTitleId={seriesTitleId}
          seriesCircleExternalId={seriesCircleExternalId}
          voiceActors={voiceActors}
          voiceCredits={voiceCredits}
          loading={loading}
          entityResolver={entityResolver}
          infoCollapsed={infoCollapsed}
          onToggleInfoCollapsed={toggleInfoCollapsed}
          metadataMenu={
            <MetadataLanguageMenu
              metadataLanguage={metadataLanguage ?? ""}
              metadataPresentation={metadataPresentation}
              activeMetadataVariantKey={activeMetadataVariantKey ?? ""}
              onMetadataVariantSelect={onMetadataVariantSelect}
              compact
            />
          }
        />

        {!infoCollapsed && (
          <>
            <DetailPurchaseBonusLine purchaseBonus={purchaseBonus} purchaseBonuses={purchaseBonuses} />

            <DetailBundleLine bundleMembers={bundleMembers} includedInBundles={includedInBundles} />

            <MobileDetailTagLine tags={tags} personalTags={personalTags} />

            <DetailStatStrip
              ratingLabel={ratingLabel}
              rating={rating}
              userRating={userRating}
              ratingCount={ratingCount}
              sales={sales}
              customWork={customWork}
              releaseDate={releaseDate}
              ageRating={ageRating}
              sourceInfo={sourceInfo}
              compact
            />
          </>
        )}
      </div>

      <MetadataSyncNotice
        sync={metadataSync}
        canSync={Boolean(canSyncMetadata && onSyncMetadata)}
        busy={metadataSyncBusy}
        onSync={onSyncMetadata}
        onLink={onLinkMetadata}
      />

      {/* The actions close the Hero, right above the Info and Directory row whose
          Directory Play starts. The row scrolls sideways into the page gutter;
          each control's touch area reaches past its 32px face to 44px, and the
          padding keeps those areas and focus rings inside the clipped strip; the
          flow root keeps that padding out of the Hero spacing. */}
      <div className="flow-root">
        <div className="-mx-4 -my-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain px-4 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div
            data-testid="hero-actions"
            className="flex w-max items-center gap-3 [&_button]:relative [&_button]:before:absolute [&_button]:before:-inset-1.5"
          >
            {actions}
          </div>
        </div>
      </div>

      <CompactDetailTabs
        activeTab={activeTab}
        onActiveTabChange={onActiveTabChange}
        source={{ label: sourceInfo.tabLabel, status: sourceInfo.status, statusLabel: sourceInfo.statusLabel }}
        edition={directoryEditionModel(
          detailEditionInput({ code, baseCode, translations, activeVersionCode, onVersionSelect, remoteVersions }),
        )}
        info={
          <div className="space-y-4">
            <WorkDescription description={description} />
            <DetailStaffCredits credits={staffCredits} />
            <DetailInfoPanel sourceInfo={sourceInfo} dlsiteFetchedAt={dlsiteFetchedAt} actions={sourceActions} />
          </div>
        }
        directory={directory}
      />
    </section>
  );
}

type DetailEntityKind = "circle" | "series" | "voice";

type DetailEntityResolver = {
  resolvingEntity: DetailEntityKind | null;
  resolveEntity: (kind: DetailEntityKind, name: string) => void;
};

function useDetailEntityResolver(code: string): DetailEntityResolver {
  const toast = useToast();
  const { demoMode } = useAuth();
  const [resolvingEntity, setResolvingEntity] = useState<DetailEntityKind | null>(null);
  const resolveEntity = async (kind: DetailEntityKind, name: string) => {
    if (resolvingEntity || !code) return;
    setResolvingEntity(kind);
    toast.info(
      kind === "series"
        ? i18n.t("workCard.loadingSeries")
        : i18n.t("workCard.loadingEntity", { kind: i18n.t(`workCard.entityKinds.${kind}`) }),
    );
    try {
      const result = demoMode
        ? await api.lookupWorkEntityLink(code, kind, name)
        : await api.resolveWorkEntityLink(code, kind, name);
      if (result.route) openResolvedEntityRoute(result.route);
    } catch (error) {
      toast.notify(
        toastFromError(error, i18n.t("workCard.couldNotOpenEntity", { kind: i18n.t(`workCard.entityKinds.${kind}`) })),
      );
    } finally {
      setResolvingEntity(null);
    }
  };
  return { resolvingEntity, resolveEntity };
}

function DetailTitleBlock({
  fallbackCode,
  code,
  dlsiteUrl,
  title,
  circle,
  circleExternalId,
  series,
  seriesTitleId,
  seriesCircleExternalId,
  loading,
  entityResolver,
  versionMenu,
}: {
  fallbackCode: string;
  code: string;
  dlsiteUrl: string;
  title: string;
  circle: string;
  circleExternalId: string;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  loading?: boolean;
  entityResolver: DetailEntityResolver;
  versionMenu?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <WorkCodeActions workCode={code || fallbackCode} dlsiteUrl={dlsiteUrl} />
          {versionMenu}
        </div>
        <h2 className="min-w-0 text-2xl font-semibold leading-tight xl:text-3xl">{title}</h2>
        {loading && <div className="skeleton-reveal h-2 w-40 animate-pulse rounded bg-muted" />}
      </div>
      <DetailCircleLine
        circle={circle}
        circleExternalId={circleExternalId}
        series={series}
        seriesTitleId={seriesTitleId}
        seriesCircleExternalId={seriesCircleExternalId}
        entityResolver={entityResolver}
      />
    </div>
  );
}

/**
 * The phone layout's identity block: the work code and DLsite link sit in the
 * app header and the directory edition in the Directory row, so the block opens
 * on a smaller title that starts with any metadata-language chip and is
 * followed by the work details toggle, and keeps the circle and voice actor
 * lines close under it.
 */
function MobileDetailIdentity({
  fallbackCode,
  code,
  dlsiteUrl,
  title,
  circle,
  circleExternalId,
  series,
  seriesTitleId,
  seriesCircleExternalId,
  voiceActors,
  voiceCredits,
  loading,
  entityResolver,
  metadataMenu,
  infoCollapsed,
  onToggleInfoCollapsed,
}: {
  fallbackCode: string;
  code: string;
  dlsiteUrl: string;
  title: string;
  circle: string;
  circleExternalId: string;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  loading?: boolean;
  entityResolver: DetailEntityResolver;
  /**
   * The metadata-language chip, which renders nothing without another language.
   * It flows as the title's first word, so the title keeps the full width.
   */
  metadataMenu?: ReactNode;
  /** Leaves only the title on one line, for a viewer who hid the work details. */
  infoCollapsed: boolean;
  onToggleInfoCollapsed: () => void;
}) {
  const toggleLabel = i18n.t(infoCollapsed ? "libraryDetail.expandWorkInfo" : "libraryDetail.collapseWorkInfo");
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <PageHeaderDetail>
        <WorkCodeActions workCode={code || fallbackCode} dlsiteUrl={dlsiteUrl} />
      </PageHeaderDetail>
      <div className="flex min-w-0 items-start gap-1">
        {infoCollapsed ? (
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold leading-snug" aria-label={title} title={title}>
            {metadataMenu}
            {title}
          </h2>
        ) : (
          <CollapsibleDetailTitle title={title} leading={metadataMenu} />
        )}
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 -mt-0.5 h-7 w-7 shrink-0 text-muted-foreground"
          aria-expanded={!infoCollapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggleInfoCollapsed}
        >
          {infoCollapsed ? <ChevronsUpDown className="h-4 w-4" /> : <ChevronsDownUp className="h-4 w-4" />}
        </Button>
      </div>
      {loading && <div className="skeleton-reveal h-2 w-40 animate-pulse rounded bg-muted" />}
      {!infoCollapsed && (
        <>
          <DetailCircleLine
            circle={circle}
            circleExternalId={circleExternalId}
            series={series}
            seriesTitleId={seriesTitleId}
            seriesCircleExternalId={seriesCircleExternalId}
            entityResolver={entityResolver}
          />
          <DetailCreditLine voiceActors={voiceActors} voiceCredits={voiceCredits} entityResolver={entityResolver} />
        </>
      )}
    </div>
  );
}

/** The work code, which copies itself, and its DLsite link. */
function WorkCodeActions({ workCode, dlsiteUrl }: { workCode: string; dlsiteUrl: string }) {
  const toast = useToast();
  const copyWorkCode = async () => {
    try {
      await copyText(workCode);
      toast.success(i18n.t("libraryDetail.copiedWorkCode", { code: workCode }));
    } catch {
      toast.error(i18n.t("libraryDetail.copyWorkCodeFailed"));
    }
  };
  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      role="group"
      aria-label={i18n.t("libraryDetail.workCodeActions")}
    >
      {workCode ? (
        <button
          type="button"
          className={badgeVariants({ variant: "secondary", className: "w-fit cursor-copy" })}
          aria-label={i18n.t("libraryDetail.copyWorkCodeFor", { code: workCode })}
          title={i18n.t("libraryDetail.work")}
          onClick={() => void copyWorkCode()}
        >
          {workCode}
        </button>
      ) : (
        <span className={badgeVariants({ variant: "secondary", className: "w-fit" })}>
          {i18n.t("libraryDetail.remoteOnly")}
        </span>
      )}
      {dlsiteUrl && (
        <Button
          variant="outline"
          size="icon"
          className="h-[22px] w-[22px] shrink-0 p-0"
          asChild
          title={i18n.t("workCard.openDLsite")}
        >
          <a
            href={dlsiteUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={i18n.t("libraryDetail.openDlsiteFor", { code: workCode })}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        </Button>
      )}
    </div>
  );
}

function DetailCircleLine({
  circle,
  circleExternalId,
  series,
  seriesTitleId,
  seriesCircleExternalId,
  entityResolver,
}: {
  circle: string;
  circleExternalId: string;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  entityResolver: DetailEntityResolver;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      {circle ? (
        <button
          className="inline-flex max-w-full items-center gap-1 truncate hover:text-primary"
          onClick={() =>
            circleExternalId ? openCircleRoute(circleExternalId) : entityResolver.resolveEntity("circle", circle)
          }
        >
          <CircleUserRound className="h-4 w-4 shrink-0" />
          <span className="truncate">{circle || i18n.t("workCard.unknownCircle")}</span>
        </button>
      ) : (
        <span className="inline-flex max-w-full items-center gap-1 truncate">
          <CircleUserRound className="h-4 w-4 shrink-0" />
          <span className="truncate">{circle || i18n.t("workCard.unknownCircle")}</span>
        </span>
      )}
      {series && (
        <span className="inline-flex max-w-full items-center gap-1 truncate">
          <span className="text-border">/</span>
          <button
            className="truncate hover:text-primary"
            onClick={() =>
              seriesTitleId && seriesCircleExternalId
                ? openCircleSeriesRoute(seriesCircleExternalId, seriesTitleId)
                : entityResolver.resolveEntity("series", series)
            }
          >
            {series}
          </button>
        </span>
      )}
    </div>
  );
}

const detailInfoCollapsedKey = "kikoto:work-detail-info-collapsed";

/** Remembers whether this viewer hid the work details above the phone layout's actions. */
function useDetailInfoCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(detailInfoCollapsedKey) === "true";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(detailInfoCollapsedKey, String(next));
      } catch {
        // The choice still applies to this page view.
      }
      return next;
    });
  };
  return [collapsed, toggle] as const;
}

/**
 * A long title shows three lines; tapping it reveals the rest. A title that
 * fits shows no toggle. The heading keeps the full text for assistive
 * technology either way. A `leading` control flows inline before the text,
 * above the expand control, and stays out of the heading's name.
 */
function CollapsibleDetailTitle({ title, leading }: { title: string; leading?: ReactNode }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => setExpanded(false), [title]);
  useEffect(() => {
    const heading = headingRef.current;
    // An expanded title is unclamped, so it keeps the measurement taken while collapsed.
    if (!heading || expanded) return;
    const measure = () => setOverflowing(heading.scrollHeight > heading.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(heading);
    return () => observer.disconnect();
  }, [expanded, title]);

  const toggleable = overflowing || expanded;
  return (
    <div className="relative flex min-w-0 items-end gap-1">
      <h2
        ref={headingRef}
        className={cn("min-w-0 flex-1 break-words text-lg font-semibold leading-snug", !expanded && "line-clamp-3")}
        aria-label={title}
      >
        {leading}
        {title}
      </h2>
      {toggleable && (
        <button
          type="button"
          className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          aria-label={i18n.t(expanded ? "libraryDetail.collapseTitle" : "libraryDetail.expandTitle")}
          onClick={() => setExpanded((value) => !value)}
        />
      )}
      {toggleable && (
        <ChevronDown
          className={cn("mb-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

function MetadataSyncNotice({
  sync,
  canSync,
  busy,
  onSync,
  onLink,
}: {
  sync?: WorkMetadataSyncStatus;
  canSync: boolean;
  busy: boolean;
  onSync?: () => void;
  onLink?: () => void;
}) {
  const status = sync?.status;
  const checkedAt = sync?.checkedAt ?? "";
  if (status !== "not_synced" && status !== "not_found" && status !== "remote_fallback") return null;
  const unavailable = status === "not_found";
  const filled = status === "remote_fallback";
  const sourceGroups = metadataSourceGroups(sync?.fields);
  return (
    <div
      className={`rounded-lg border p-3 text-sm sm:col-span-2 ${
        unavailable
          ? "border-warning-border bg-warning-surface text-warning-foreground"
          : "border-info-border bg-info-surface text-info-foreground"
      }`}
      data-testid="metadata-sync-notice"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">
            {filled
              ? i18n.t("libraryDetail.metadataRemoteFallback")
              : unavailable
                ? i18n.t("libraryDetail.metadataUnavailable")
                : i18n.t("libraryDetail.metadataNotSynced")}
          </div>
          <p className="mt-1 text-xs opacity-80">
            {filled
              ? i18n.t("libraryDetail.metadataRemoteFallbackDescription", { source: sync?.source ?? "" })
              : unavailable
                ? i18n.t("libraryDetail.metadataNotRecorded")
                : i18n.t("libraryDetail.metadataNotSynced")}
          </p>
          {sourceGroups.map((group) => (
            <p key={group.source} className="mt-1 text-xs opacity-80">
              {i18n.t("libraryDetail.metadataFieldSources", {
                source: group.source,
                fields: group.fields
                  .map((field) => i18n.t(`libraryDetail.metadataFields.${field}`, { defaultValue: "" }))
                  .filter(Boolean)
                  .join(i18n.t("libraryDetail.metadataFieldSeparator")),
              })}
            </p>
          ))}
          {checkedAt && (
            <div className="mt-1 text-xs opacity-70">
              {i18n.t("common.checking")} {formatDateTime(checkedAt)}
            </div>
          )}
        </div>
        {(unavailable || filled) && onLink && (
          <Button variant="outline" size="sm" onClick={onLink}>
            <Link2 className="h-4 w-4" />
            {i18n.t("libraryDetail.useOtherWorkMetadata")}
          </Button>
        )}
        {!unavailable && canSync && onSync && (
          <Button variant="outline" size="sm" onClick={onSync} disabled={busy}>
            <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
            {busy ? i18n.t("sheets.refreshingVoiceMetadata") : i18n.t("sheets.metadataRefresh")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The Hero actions: the one primary action, then the quiet personal and Manage controls. */
export function HeroActionGroups({ primary, children }: { primary: ReactNode; children: ReactNode }) {
  return (
    <>
      {primary}
      <div className="flex items-center gap-1">{children}</div>
    </>
  );
}

export function DetailSkeletonActions() {
  return (
    <HeroActionGroups
      primary={<div className="skeleton-reveal h-[var(--control-height)] w-28 animate-pulse rounded-md bg-muted" />}
    >
      <div className="skeleton-reveal h-8 w-8 animate-pulse rounded-md bg-muted" />
      <div className="skeleton-reveal h-8 w-14 animate-pulse rounded-md bg-muted" />
      <div className="skeleton-reveal h-8 w-8 animate-pulse rounded-md bg-muted" />
    </HeroActionGroups>
  );
}

export function DirectorySkeleton() {
  return (
    <div className="skeleton-reveal min-h-[22rem] space-y-3" data-testid="directory-skeleton" aria-hidden="true">
      <div className="flex h-9 items-center gap-2 rounded-md border bg-background px-3">
        <div className="h-3 w-10 animate-pulse rounded bg-muted" />
        <div className="h-3 w-3 animate-pulse rounded-full bg-muted" />
        <div className="h-3 w-32 animate-pulse rounded bg-muted" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex min-h-12 items-center gap-3 rounded-md border bg-background px-3 py-2">
            <div className="h-7 w-7 shrink-0 animate-pulse rounded-md bg-muted" />
            <div className="min-w-0 flex-1 space-y-2">
              <div
                className={`h-3 animate-pulse rounded bg-muted ${index % 3 === 0 ? "w-2/3" : index % 3 === 1 ? "w-1/2" : "w-3/4"}`}
              />
              <div className="h-2.5 w-24 animate-pulse rounded bg-muted/80" />
            </div>
            <div className="h-8 w-8 shrink-0 animate-pulse rounded-md bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}

function detailHeroValue<T>(workValue: T | null | undefined, previewValue: T | null | undefined, fallback: T): T {
  return workValue ?? previewValue ?? fallback;
}

export function detailHeroModel(code: string, work: WorkDetail | null, preview: WorkPreview | null) {
  const persisted: Partial<WorkDetail> = work || {};
  const optimistic: Partial<WorkPreview> = preview || {};
  return {
    primaryCode: detailHeroValue(persisted.primaryCode, optimistic.primaryCode, code),
    title: detailHeroValue(persisted.title, optimistic.title, code),
    coverUrl: detailHeroValue(persisted.coverUrl, optimistic.coverUrl, ""),
    circle: detailHeroValue(persisted.circle, optimistic.circle, ""),
    circleExternalId: detailHeroValue(persisted.circleExternalId, optimistic.circleExternalId, ""),
    rating: detailHeroValue(persisted.rating, optimistic.rating, null),
    ratingCount: detailHeroValue(persisted.ratingCount, undefined, null),
    sales: detailHeroValue(persisted.sales, optimistic.sales, null),
    series: detailHeroValue(persisted.series, undefined, ""),
    dlsiteFetchedAt: detailHeroValue(persisted.dlsiteFetchedAt, undefined, ""),
    releaseDate: detailHeroValue(persisted.releaseDate, optimistic.releaseDate, null),
    ageRating: detailHeroValue(persisted.ageRating, undefined, ""),
    durationSeconds: detailHeroValue(persisted.durationSeconds, undefined, null),
    voiceActors: detailHeroValue(persisted.voiceActors, optimistic.voiceActors, []),
    tags: detailHeroValue(persisted.tags, optimistic.tags, []),
  };
}

export function useCompactDetailLayout() {
  return useMediaQueryMatch("(max-width: 767px)");
}

function useMediaQueryMatch(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function ActiveSourceInfo({ info }: { info: ActiveSourceInfoModel }) {
  const SourceIcon =
    info.kind === "local"
      ? HardDrive
      : info.kind === "tracked"
        ? GitBranchPlus
        : info.kind === "remote"
          ? Cloud
          : CloudOff;
  const { files, playable, knownSizeFiles, sizeBytes } = info.stats;
  const countPending = info.loading && files === 0;
  // A size summed from only some files reads as approximate; its title names how many were measured.
  const partialSize = knownSizeFiles > 0 && knownSizeFiles < files;
  const sizeValue =
    knownSizeFiles > 0 ? `${partialSize ? "≈" : ""}${formatBytes(sizeBytes)}` : info.loading ? "..." : "—";

  // The source tabs already show an available source's status, and the Hero stat strip its duration.
  return (
    <div data-testid="active-source-info" className="w-full min-w-0 space-y-2 p-4 text-sm">
      <div className="flex min-w-0 items-center gap-2 font-semibold">
        <SourceIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate" title={info.label}>
          {info.label}
        </span>
      </div>
      {info.status !== "available" && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={`h-2 w-2 rounded-full ${sourceTabStatusClass(info.status)}`} aria-hidden="true" />
          <span>{info.statusLabel}</span>
        </div>
      )}
      <dl className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-2xs leading-4">
        <SourceInfoMetric
          label={i18n.t("libraryDetail.playable")}
          value={countPending ? "..." : playable.toLocaleString()}
        />
        <SourceInfoMetric
          label={i18n.t("libraryDetail.filesLabel")}
          value={countPending ? "..." : files.toLocaleString()}
        />
        <SourceInfoMetric
          label={i18n.t("libraryDetail.size")}
          value={sizeValue}
          title={
            partialSize ? i18n.t("libraryDetail.filesMeasured", { known: knownSizeFiles, total: files }) : undefined
          }
        />
      </dl>
    </div>
  );
}

function SourceInfoMetric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="inline-flex shrink-0 items-baseline gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums text-foreground" title={title}>
        {value}
      </dd>
    </div>
  );
}

function openResolvedEntityRoute(route: string) {
  if (!route.startsWith("/")) return;
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.history.pushState(historyStateWithReturn(returnTo, i18n.t("common.back")), "", route);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}
