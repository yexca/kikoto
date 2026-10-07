import { WorkDescription } from "./metadata/WorkDescription";
import {
  api,
  assetURL,
  type VoiceCredit,
  type WorkDetail,
  type WorkMetadataPresentation,
  type WorkMetadataSyncStatus,
} from "@/lib/api";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type ActiveSourceInfoModel,
  detailReturnTarget,
  formatDateTime,
  languageLabel,
  openDetailTagSearch,
} from "@/features/work-detail/workDetailHelpers";
import { usePageHeaderBack } from "@/app/pageHeader";
import i18n from "@/i18n";
import {
  Check,
  ChevronDown,
  CircleUserRound,
  Clock3,
  Cloud,
  CloudOff,
  ExternalLink,
  FolderTree,
  GitBranchPlus,
  HardDrive,
  Languages,
  Link2,
  RefreshCw,
  Star,
} from "lucide-react";
import { openVoiceRoute } from "@/lib/voiceNavigationState";
import { useAuth } from "@/auth/AuthProvider";
import { toastFromError, useToast } from "@/components/ui/toast";
import { badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { openCircleRoute, openCircleSeriesRoute } from "@/lib/circleNavigationState";
import {
  groupWorkVersions,
  type WorkVersionAvailabilityScope,
  workVersionAvailableForScope,
  workVersionKindLabel,
  workVersionMediaState,
} from "@/features/work-detail/workVersionModel";
import { openWorkCodeRoute, type WorkPreview } from "@/features/work-detail/workDetailShared";
import {
  metadataSourceGroups,
  metadataVariantLabel as metadataVariantLabelFor,
  orderedMetadataVariants,
  resolveMetadataVariant,
} from "@/features/work-detail/metadataPresentationModel";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { ageRatingPresentation } from "@/lib/ageRating";
import { formatBytes, formatDuration } from "@/features/work-detail/media/mediaTreeModel";
import { sourceTabStatusClass } from "@/features/work-detail/source/sourceContextModel";
import { historyStateWithReturn, NAVIGATION_EVENT } from "@/lib/browserHistory";
import type { SourceActionLayout } from "@/features/work-detail/WorkDetailActionBars";
import { DetailPurchaseBonusLine } from "@/features/work-detail/DetailPurchaseBonusLine";

export type UnifiedWorkDetailPresentation = {
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
  ratingCount: number | null;
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
  purchaseBonus?: WorkDetail["purchaseBonus"];
  purchaseBonuses?: WorkDetail["purchaseBonuses"];
  tags: string[];
  personalTags?: ReactNode;
  loading?: boolean;
};

export function UnifiedWorkDetailPage({
  presentation,
  compact,
  mobileTab,
  onMobileTabChange,
  actions,
  renderSourceActions,
  directory,
  onBack,
  children,
}: {
  presentation: UnifiedWorkDetailPresentation;
  compact: boolean;
  mobileTab: "info" | "directory";
  onMobileTabChange: (tab: "info" | "directory") => void;
  actions: ReactNode;
  /** Actions for the selected source: a menu with the Hero actions, or an inline list in wide Source info. */
  renderSourceActions?: (layout: SourceActionLayout) => ReactNode;
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
          actions={
            <>
              {actions}
              {renderSourceActions?.("menu")}
            </>
          }
          directory={directory}
        />
      ) : (
        <DesktopWorkDetailLayout
          {...presentation}
          actions={actions}
          renderSourceActions={renderSourceActions}
          directory={directory}
        />
      )}
      {children}
    </div>
  );
}

function DesktopWorkDetailLayout({
  actions,
  renderSourceActions,
  directory,
  ...presentation
}: UnifiedWorkDetailPresentation & {
  actions: ReactNode;
  renderSourceActions?: (layout: SourceActionLayout) => ReactNode;
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
    tags,
    personalTags,
    dlsiteFetchedAt,
  } = presentation;
  const entityResolver = useDetailEntityResolver(code);
  const versionMenu = detailVersionMenu(presentation);
  // Source info only sits beside the Directory on wide screens; narrower desktops
  // stack it below the Directory, so source actions stay a menu with the Hero actions.
  const sourceActionsInPanel = useMediaQueryMatch(WIDE_DETAIL_LAYOUT_QUERY);

  return (
    <div className="space-y-6">
      <section
        className="relative isolate overflow-clip rounded-xl border bg-card"
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
            <DetailTagLine tags={tags} personalTags={personalTags} />
            <DetailStatStrip {...presentation} />
            <MetadataSyncNotice
              sync={metadataSync}
              canSync={Boolean(canSyncMetadata && onSyncMetadata)}
              busy={metadataSyncBusy}
              onSync={onSyncMetadata}
              onLink={onLinkMetadata}
            />
            <div data-testid="hero-actions" className="mt-auto flex min-w-0 flex-wrap gap-2 pt-1">
              {actions}
              {!sourceActionsInPanel && renderSourceActions?.("menu")}
            </div>
          </div>
        </div>
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-4">
          <WorkDescription description={presentation.description} />
          {directory}
        </div>
        <DetailInfoPanel
          sourceInfo={sourceInfo}
          dlsiteFetchedAt={dlsiteFetchedAt}
          actions={sourceActionsInPanel ? renderSourceActions?.("list") : undefined}
          className="xl:sticky xl:top-20"
        />
      </div>
    </div>
  );
}

function DetailInfoPanel({
  sourceInfo,
  dlsiteFetchedAt,
  actions,
  className,
}: Pick<UnifiedWorkDetailPresentation, "sourceInfo" | "dlsiteFetchedAt"> & {
  actions?: ReactNode;
  className: string;
}) {
  return (
    <aside
      className={`min-w-0 divide-y overflow-hidden rounded-xl border bg-card ${className}`}
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
              <button
                type="button"
                className="inline-flex h-[26px] max-w-48 items-center rounded-full border bg-background/60 px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                title={tag}
                onClick={() => openDetailTagSearch("tag", tag)}
              >
                <span className="truncate">{tag}</span>
              </button>
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
      {personalTags}
    </div>
  );
}

function detailVersionMenu({
  code,
  baseCode,
  metadataLanguage,
  metadataPresentation,
  activeMetadataVariantKey,
  onMetadataVariantSelect,
  translations = [],
  activeVersionCode,
  onVersionSelect,
  remoteVersions,
}: Pick<
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
>) {
  const hasVersionControls =
    metadataLanguage || (metadataPresentation?.variants.length ?? 0) > 0 || baseCode || translations.length > 0;
  if (!hasVersionControls) return null;
  const availabilityScope: WorkVersionAvailabilityScope = remoteVersions ? "source" : "local";
  const baseTranslation = translations.find(
    (translation) => translation.primaryCode.toUpperCase() === (baseCode ?? "").toUpperCase(),
  );
  return (
    <WorkVersionMenus
      metadataLanguage={metadataLanguage ?? ""}
      metadataPresentation={metadataPresentation}
      activeMetadataVariantKey={activeMetadataVariantKey ?? ""}
      onMetadataVariantSelect={onMetadataVariantSelect}
      baseCode={baseCode ?? ""}
      baseAvailable={Boolean(baseTranslation && workVersionAvailableForScope(baseTranslation, availabilityScope))}
      translations={translations}
      activeVersionCode={activeVersionCode ?? code}
      onVersionSelect={onVersionSelect}
      remoteVersions={remoteVersions}
    />
  );
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
    voiceCredits.length > 0 ? voiceCredits : voiceActors.map((displayName) => ({ personId: 0, displayName }));
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
                  credit.personId > 0
                    ? openVoiceRoute(credit.personId)
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
  sales,
  releaseDate,
  ageRating,
  sourceInfo,
  compact = false,
}: Pick<
  UnifiedWorkDetailPresentation,
  "ratingLabel" | "rating" | "ratingCount" | "sales" | "releaseDate" | "ageRating" | "sourceInfo"
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
      key: "age",
      label: i18n.t("library.searchClauseKinds.age"),
      value: age.label === "Unknown" ? "—" : age.label,
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
  ];
  return (
    <dl
      data-testid="dlsite-info"
      className={
        compact
          ? "flex justify-between gap-x-2 overflow-x-auto min-[360px]:gap-x-3 rounded-lg border bg-background/60 px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "flex w-fit max-w-full flex-wrap gap-x-6 gap-y-2 self-start rounded-lg border bg-background/60 px-3.5 py-2 backdrop-blur-sm"
      }
    >
      {stats.map((stat) => (
        <div key={stat.key} className="min-w-0 shrink-0">
          <dt className="whitespace-nowrap text-2xs font-medium text-muted-foreground">{stat.label}</dt>
          <dd
            className={`mt-0.5 whitespace-nowrap font-semibold tabular-nums text-sm ${stat.valueClassName || "text-foreground"}`}
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
  ratingCount,
  sales,
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
  purchaseBonus,
  purchaseBonuses,
  tags,
  personalTags,
  loading,
  activeTab,
  onActiveTabChange,
  actions,
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
  ratingCount: number | null;
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
  purchaseBonus?: WorkDetail["purchaseBonus"];
  purchaseBonuses?: WorkDetail["purchaseBonuses"];
  tags: string[];
  personalTags?: ReactNode;
  loading?: boolean;
  activeTab: "info" | "directory";
  onActiveTabChange: (tab: "info" | "directory") => void;
  actions: ReactNode;
  directory: ReactNode;
}) {
  const entityResolver = useDetailEntityResolver(code);
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
        versionMenu={detailVersionMenu({
          code,
          baseCode,
          metadataLanguage,
          metadataPresentation,
          activeMetadataVariantKey,
          onMetadataVariantSelect,
          translations,
          activeVersionCode,
          onVersionSelect,
          remoteVersions,
        })}
      />

      <DetailCreditLine voiceActors={voiceActors} voiceCredits={voiceCredits} entityResolver={entityResolver} />

      <DetailPurchaseBonusLine purchaseBonus={purchaseBonus} purchaseBonuses={purchaseBonuses} />

      <DetailTagLine tags={tags} personalTags={personalTags} />

      <DetailStatStrip
        ratingLabel={ratingLabel}
        rating={rating}
        ratingCount={ratingCount}
        sales={sales}
        releaseDate={releaseDate}
        ageRating={ageRating}
        sourceInfo={sourceInfo}
        compact
      />

      <MetadataSyncNotice
        sync={metadataSync}
        canSync={Boolean(canSyncMetadata && onSyncMetadata)}
        busy={metadataSyncBusy}
        onSync={onSyncMetadata}
        onLink={onLinkMetadata}
      />

      <div data-testid="hero-actions" className="flex flex-wrap gap-2">
        {actions}
      </div>

      <div className="grid grid-cols-2 rounded-lg border bg-card p-1 text-sm">
        <button
          className={`min-h-10 rounded-md px-3 font-medium ${activeTab === "info" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
          onClick={() => onActiveTabChange("info")}
        >
          {i18n.t("libraryDetail.info")}
        </button>
        <button
          className={`min-h-10 rounded-md px-3 font-medium ${activeTab === "directory" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
          onClick={() => onActiveTabChange("directory")}
        >
          {i18n.t("libraryDetail.directory")}
        </button>
      </div>

      {activeTab === "info" ? (
        <div className="space-y-4">
          <WorkDescription description={description} />
          <DetailInfoPanel sourceInfo={sourceInfo} dlsiteFetchedAt={dlsiteFetchedAt} className="" />
        </div>
      ) : (
        directory
      )}
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
  const toast = useToast();
  const codeLabel = code || fallbackCode || i18n.t("libraryDetail.remoteOnly");
  const copyWorkCode = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(codeLabel);
      toast.success(i18n.t("libraryDetail.copiedWorkCode", { code: codeLabel }));
    } catch {
      toast.error(i18n.t("libraryDetail.copyWorkCodeFailed"));
    }
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-1.5" role="group" aria-label={i18n.t("libraryDetail.workCodeActions")}>
            <button
              type="button"
              className={badgeVariants({ variant: "secondary", className: "w-fit cursor-copy" })}
              aria-label={i18n.t("libraryDetail.copyWorkCodeFor", { code: codeLabel })}
              title={i18n.t("libraryDetail.work")}
              onClick={() => void copyWorkCode()}
            >
              {codeLabel}
            </button>
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
                  aria-label={i18n.t("libraryDetail.openDlsiteFor", { code: codeLabel })}
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
            )}
          </div>
          {versionMenu}
        </div>
        <h2 className="min-w-0 text-2xl font-semibold leading-tight xl:text-3xl">{title}</h2>
        {loading && <div className="h-2 w-40 animate-pulse rounded bg-muted" />}
      </div>
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

export function DetailSkeletonActions() {
  return (
    <div className="flex flex-wrap gap-2">
      <div className="h-9 w-24 animate-pulse rounded-md bg-muted" />
      <div className="h-9 w-28 animate-pulse rounded-md bg-muted" />
      <div className="h-9 w-20 animate-pulse rounded-md bg-muted" />
    </div>
  );
}

export function DirectorySkeleton() {
  return (
    <div className="min-h-[22rem] space-y-3" data-testid="directory-skeleton" aria-hidden="true">
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

// Matches Tailwind's `xl` breakpoint, where Source info becomes a sticky side panel.
const WIDE_DETAIL_LAYOUT_QUERY = "(min-width: 1280px)";

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

function WorkVersionMenus({
  metadataLanguage,
  metadataPresentation,
  activeMetadataVariantKey,
  onMetadataVariantSelect,
  baseCode,
  baseAvailable,
  translations,
  activeVersionCode,
  onVersionSelect,
  remoteVersions = false,
}: {
  metadataLanguage: string;
  metadataPresentation?: WorkMetadataPresentation;
  activeMetadataVariantKey: string;
  onMetadataVariantSelect?: (key: string) => void;
  baseCode: string;
  baseAvailable: boolean;
  translations: WorkDetail["translations"];
  activeVersionCode: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  remoteVersions?: boolean;
}) {
  return (
    <>
      <MetadataLanguageMenu
        metadataLanguage={metadataLanguage}
        metadataPresentation={metadataPresentation}
        activeMetadataVariantKey={activeMetadataVariantKey}
        onMetadataVariantSelect={onMetadataVariantSelect}
      />
      {(baseCode || translations.length > 0) && (
        <DirectoryEditionMenu
          baseCode={baseCode}
          baseAvailable={baseAvailable}
          translations={translations}
          activeVersionCode={activeVersionCode}
          onVersionSelect={onVersionSelect}
          remoteVersions={remoteVersions}
        />
      )}
    </>
  );
}

const versionChipClassName =
  "inline-flex h-[22px] max-w-full items-center gap-1 rounded-md border px-2 text-xs text-muted-foreground";

function VersionChipMenu({
  icon,
  label,
  menuLabel,
  interactive,
  children,
}: {
  icon: ReactNode;
  label: string;
  menuLabel: string;
  interactive: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  if (!interactive) {
    return (
      <div role="group" aria-label={menuLabel} title={menuLabel} className={versionChipClassName}>
        {icon}
        <span className="truncate">{label}</span>
      </div>
    );
  }
  return (
    <div ref={anchorRef} className="min-w-0 max-w-full">
      <button
        type="button"
        className={`${versionChipClassName} bg-background/60 font-medium transition-colors hover:border-primary hover:text-primary aria-expanded:border-primary aria-expanded:text-primary`}
        aria-label={menuLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={menuLabel}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align="start"
        className="w-[min(21rem,calc(100vw-1.5rem))] p-0 text-sm"
      >
        <div role="dialog" aria-label={menuLabel} className="app-scroll max-h-[min(28rem,70vh)] overflow-y-auto p-2">
          <h4 className="flex items-center gap-2 px-2 pb-1.5 pt-0.5 text-xs font-medium text-muted-foreground">
            {icon}
            {menuLabel}
          </h4>
          {children(() => setOpen(false))}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function MetadataLanguageMenu({
  metadataLanguage,
  metadataPresentation,
  activeMetadataVariantKey,
  onMetadataVariantSelect,
}: {
  metadataLanguage: string;
  metadataPresentation?: WorkMetadataPresentation;
  activeMetadataVariantKey: string;
  onMetadataVariantSelect?: (key: string) => void;
}) {
  const metadataVariants = orderedMetadataVariants(metadataPresentation?.variants ?? []);
  const activeMetadataVariant = resolveMetadataVariant(metadataPresentation, activeMetadataVariantKey);
  const label = activeMetadataVariant
    ? metadataVariantLabel(activeMetadataVariant, metadataVariants)
    : metadataLanguage
      ? languageLabel(metadataLanguage)
      : "";
  if (!label) return null;
  return (
    <VersionChipMenu
      icon={<Languages className="h-3 w-3 shrink-0" />}
      label={label}
      menuLabel={i18n.t("libraryDetail.metadataLanguage")}
      interactive={metadataVariants.length > 1}
    >
      {(close) => (
        <div role="menu" aria-label={i18n.t("libraryDetail.metadataLanguage")}>
          {metadataVariants.map((variant) => {
            const active = variant.key === activeMetadataVariant?.key;
            return (
              <button
                key={variant.key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left ${
                  active ? "bg-primary/10 font-medium text-primary" : "hover:bg-accent hover:text-accent-foreground"
                }`}
                onClick={() => {
                  if (!active) onMetadataVariantSelect?.(variant.key);
                  close();
                }}
              >
                <span className="truncate">{metadataVariantLabel(variant, metadataVariants)}</span>
                {active && <Check className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </VersionChipMenu>
  );
}

function DirectoryEditionMenu({
  baseCode,
  baseAvailable,
  translations,
  activeVersionCode,
  onVersionSelect,
  remoteVersions,
}: {
  baseCode: string;
  baseAvailable: boolean;
  translations: WorkDetail["translations"];
  activeVersionCode: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  remoteVersions: boolean;
}) {
  const [showAllEditions, setShowAllEditions] = useState(false);
  const availabilityScope: WorkVersionAvailabilityScope = remoteVersions ? "source" : "local";
  const collapsedGroups = groupWorkVersions(translations, {
    activeCode: activeVersionCode,
    remoteVersions,
    includeMetadataOnly: false,
    availabilityScope,
  });
  const expandedGroups = groupWorkVersions(translations, {
    activeCode: activeVersionCode,
    remoteVersions,
    includeMetadataOnly: true,
    availabilityScope,
  });
  const collapsedCodes = new Set(
    collapsedGroups.flatMap((group) => group.versions.map((version) => version.primaryCode.toUpperCase())),
  );
  const hiddenEditionCount = translations.filter(
    (version) => !collapsedCodes.has(version.primaryCode.toUpperCase()),
  ).length;
  const groups = showAllEditions ? expandedGroups : collapsedGroups;
  const activeCode = activeVersionCode.trim().toUpperCase();
  const activeGroup = expandedGroups.find((group) =>
    group.versions.some((version) => version.primaryCode.trim().toUpperCase() === activeCode),
  );
  const activeVersion = activeGroup?.versions.find(
    (version) => version.primaryCode.trim().toUpperCase() === activeCode,
  );
  const activeLanguage = activeGroup?.language ? languageLabel(activeGroup.language) : "";
  const label =
    activeVersion?.translationKind === "origin" && activeLanguage
      ? `${workVersionKindLabel(activeVersion)} · ${activeLanguage}`
      : activeLanguage || activeVersionCode;

  const selectVersion = (translation: WorkDetail["translations"][number], close: () => void) => {
    const active = translation.primaryCode.trim().toUpperCase() === activeCode;
    if (active || !workVersionAvailableForScope(translation, availabilityScope)) return;
    close();
    if (onVersionSelect) {
      onVersionSelect(translation);
    } else {
      openWorkCodeRoute(translation.primaryCode);
    }
  };

  return (
    <VersionChipMenu
      icon={<FolderTree className="h-3 w-3 shrink-0" />}
      label={label}
      menuLabel={i18n.t("libraryDetail.directoryEdition")}
      interactive
    >
      {(close) => (
        <div className="space-y-1">
          {baseCode && (
            <div className="px-2 text-xs">
              {baseAvailable ? (
                <button
                  type="button"
                  className="font-semibold text-primary hover:underline"
                  onClick={() => {
                    close();
                    openWorkCodeRoute(baseCode);
                  }}
                >
                  {i18n.t("libraryDetail.baseCode", { code: baseCode })}
                </button>
              ) : (
                <span className="font-semibold text-muted-foreground">
                  {i18n.t("libraryDetail.baseCode", { code: baseCode })}
                </span>
              )}
            </div>
          )}
          {groups.map((group) => {
            const language = group.language ? languageLabel(group.language) : i18n.t("libraryDetail.unknownLanguage");
            return (
              <div
                key={group.key}
                role="group"
                aria-label={i18n.t("libraryDetail.languageVersions", { language })}
                className="pt-1"
              >
                <div className="px-2 pb-0.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {language}
                </div>
                <div role="menu" aria-label={i18n.t("libraryDetail.languageCodes", { language })}>
                  {group.versions.map((translation) => {
                    const available = workVersionAvailableForScope(translation, availabilityScope);
                    const active = translation.primaryCode.trim().toUpperCase() === activeCode;
                    const stateLabel = workVersionStateLabel(translation, availabilityScope);
                    return (
                      <button
                        key={translation.primaryCode}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        aria-label={`${translation.primaryCode} ${workVersionKindLabel(translation)} ${stateLabel}`}
                        disabled={!active && !available}
                        className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left ${
                          active
                            ? "bg-primary/10 text-primary"
                            : available
                              ? "hover:bg-accent hover:text-accent-foreground"
                              : "text-muted-foreground opacity-70"
                        }`}
                        onClick={() => selectVersion(translation, close)}
                      >
                        <span className="min-w-0 truncate">
                          <span className="font-semibold tabular-nums">{translation.primaryCode}</span>
                          <span className="ml-2 text-xs opacity-80">{workVersionKindLabel(translation)}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5 text-xs opacity-80">
                          {stateLabel}
                          {active && <Check className="h-4 w-4" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {hiddenEditionCount > 0 && (
            <button
              type="button"
              className="w-full rounded-md px-2 py-1.5 text-left text-xs font-medium text-primary hover:bg-accent"
              aria-expanded={showAllEditions}
              onClick={() => setShowAllEditions((shown) => !shown)}
            >
              {showAllEditions
                ? i18n.t("libraryDetail.hideAllEditions")
                : i18n.t("libraryDetail.showAllEditions", { count: hiddenEditionCount })}
            </button>
          )}
        </div>
      )}
    </VersionChipMenu>
  );
}

function metadataVariantLabel(
  variant: WorkMetadataPresentation["variants"][number],
  variants: WorkMetadataPresentation["variants"],
) {
  return metadataVariantLabelFor(variant, variants, {
    original: i18n.t("libraryDetail.original"),
    language: languageLabel,
  });
}

function workVersionStateLabel(version: WorkDetail["translations"][number], scope: WorkVersionAvailabilityScope) {
  const mediaState = workVersionMediaState(version);
  if (scope === "local" && !version.localAvailable) {
    return mediaState === "indexed_available"
      ? i18n.t("libraryDetail.remoteOnly")
      : i18n.t("detailActions.unavailable");
  }
  switch (mediaState) {
    case "indexed_available":
      return scope === "local" ? i18n.t("libraryDetail.ready") : i18n.t("content.available");
    case "present_unindexed":
      return i18n.t("libraryDetail.indexOnOpen");
    case "metadata_only":
      return i18n.t("libraryDetail.metadataOnly");
    default:
      return i18n.t("detailActions.unavailable");
  }
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
  const noFilesValue = info.loading ? "..." : "—";
  const sizeValue = info.stats.knownSizeFiles > 0 ? formatBytes(info.stats.sizeBytes) : noFilesValue;
  const sizeDetail =
    info.stats.knownSizeFiles > 0 && info.stats.knownSizeFiles < info.stats.files
      ? i18n.t("libraryDetail.filesMeasured", { known: info.stats.knownSizeFiles, total: info.stats.files })
      : info.stats.knownSizeFiles > 0
        ? i18n.t("libraryDetail.allFileSizesMeasured")
        : i18n.t("libraryDetail.noMeasuredFileSize");
  const hasMeasuredDuration = info.stats.knownDurationMedia > 0;
  const durationValue = hasMeasuredDuration
    ? formatDuration(info.stats.durationSeconds)
    : info.metadataDurationSeconds
      ? formatDuration(info.metadataDurationSeconds)
      : noFilesValue;
  const durationLabel = hasMeasuredDuration
    ? i18n.t("libraryDetail.playableDuration")
    : i18n.t("libraryDetail.metadataDuration");
  const durationDetail = hasMeasuredDuration
    ? info.stats.knownDurationMedia < info.stats.playable
      ? i18n.t("libraryDetail.playableFilesMeasured", {
          known: info.stats.knownDurationMedia,
          total: info.stats.playable,
        })
      : i18n.t("libraryDetail.allPlayableDurationsMeasured")
    : info.metadataDurationSeconds
      ? i18n.t("libraryDetail.noMeasuredSourceDuration")
      : i18n.t("libraryDetail.noKnownDuration");

  return (
    <div data-testid="active-source-info" className="w-full min-w-0 p-4 text-sm">
      <div className="mb-3 min-w-0">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <SourceIcon className="h-4 w-4 shrink-0" />
          <span>{i18n.t("libraryDetail.sourceInfo")}</span>
        </div>
        <div className="mt-1 truncate font-semibold" title={info.label}>
          {info.label}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={`h-2 w-2 rounded-full ${sourceTabStatusClass(info.status)}`} aria-hidden="true" />
          <span>{info.statusLabel}</span>
        </div>
      </div>
      <div className="space-y-2.5">
        <SourceInfoRow
          testId="source-info-audio-row"
          firstLabel={i18n.t("libraryDetail.playable")}
          firstValue={info.loading && info.stats.files === 0 ? "..." : info.stats.playable.toLocaleString()}
          secondLabel={durationLabel}
          secondValue={durationValue}
          detail={durationDetail}
        />
        <SourceInfoRow
          testId="source-info-files-row"
          firstLabel={i18n.t("libraryDetail.filesLabel")}
          firstValue={info.loading && info.stats.files === 0 ? "..." : info.stats.files.toLocaleString()}
          secondLabel={i18n.t("libraryDetail.size")}
          secondValue={sizeValue}
          detail={sizeDetail}
        />
      </div>
    </div>
  );
}

function SourceInfoRow({
  testId,
  firstLabel,
  firstValue,
  secondLabel,
  secondValue,
  detail,
}: {
  testId: string;
  firstLabel: string;
  firstValue: string;
  secondLabel: string;
  secondValue: string;
  detail: string;
}) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-2xs leading-4">
      <span className="inline-flex shrink-0 items-baseline gap-1.5" data-source-primary-metrics>
        <InlineSourceMetric label={firstLabel} value={firstValue} />
        <span className="h-3 self-center border-l border-border" aria-hidden="true" />
        <InlineSourceMetric label={secondLabel} value={secondValue} />
      </span>
      <span className="min-w-0 flex-1 basis-32 leading-4 text-muted-foreground">({detail})</span>
    </div>
  );
}

function InlineSourceMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex shrink-0 items-baseline gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold text-foreground">{value}</span>
    </span>
  );
}

function openResolvedEntityRoute(route: string) {
  if (!route.startsWith("/")) return;
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.history.pushState(historyStateWithReturn(returnTo, i18n.t("detailActions.back")), "", route);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}
