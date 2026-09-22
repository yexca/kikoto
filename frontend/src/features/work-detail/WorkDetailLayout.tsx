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
  isInternalReturnPath,
  languageLabel,
} from "@/features/work-detail/workDetailHelpers";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { usePageHeaderBack } from "@/app/pageHeader";
import i18n from "@/i18n";
import {
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
  RefreshCw,
  Tags,
  UserRound,
} from "lucide-react";
import { openVoiceRoute } from "@/pages/voiceNavigationState";
import { toastFromError, useToast } from "@/components/ui/toast";
import { badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { openCircleRoute, openCircleSeriesRoute } from "@/pages/circleNavigationState";
import {
  groupWorkVersions,
  preferredWorkVersion,
  type WorkVersionAvailabilityScope,
  workVersionAvailableForScope,
  type WorkVersionGroup,
  workVersionKindLabel,
  workVersionMediaState,
} from "@/features/work-detail/workVersionModel";
import { openWorkCodeRoute, type WorkPreview } from "@/features/work-detail/workDetailShared";
import { orderedMetadataVariants, resolveMetadataVariant } from "@/features/work-detail/metadataPresentationModel";
import { FloatingSelect } from "@/components/ui/floating-select";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { ageRatingPresentation } from "@/lib/ageRating";
import { formatBytes, formatDuration } from "@/features/work-detail/media/mediaTreeModel";
import { sourceTabStatusClass } from "@/features/work-detail/source/sourceContextModel";
import {
  defaultLibraryBrowseState,
  libraryBrowseSearch,
  libraryBrowseStateFromSearch,
} from "@/pages/libraryBrowseState";
import { formatSearchClause, parseSearchClauses } from "@/pages/librarySearchClauses";
import { historyStateWithReturn, NAVIGATION_EVENT } from "@/lib/browserHistory";

export type UnifiedWorkDetailPresentation = {
  coverUrl: string;
  fallbackCode: string;
  code: string;
  dlsiteUrl: string;
  title: string;
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
  directory,
  onBack,
  children,
}: {
  presentation: UnifiedWorkDetailPresentation;
  compact: boolean;
  mobileTab: "info" | "directory";
  onMobileTabChange: (tab: "info" | "directory") => void;
  actions: ReactNode;
  directory: ReactNode;
  onBack: () => void;
  children?: ReactNode;
}) {
  const mobileNavigationLayout = useMobileNavigationLayout();
  usePageHeaderBack({
    label: mobileNavigationLayout ? i18n.t("nav.library") : detailReturnTarget("library").label,
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
          directory={directory}
        />
      ) : (
        <>
          <DetailHero {...presentation} actions={actions} />
          {directory}
        </>
      )}
      {children}
    </div>
  );
}

function DetailHero({
  coverUrl,
  fallbackCode,
  code,
  dlsiteUrl,
  title,
  circle,
  circleExternalId,
  ratingLabel,
  rating,
  ratingCount,
  sales,
  series,
  seriesTitleId,
  seriesCircleExternalId,
  baseCode,
  metadataLanguage,
  metadataPresentation,
  metadataSync,
  canSyncMetadata = false,
  metadataSyncBusy = false,
  onSyncMetadata,
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
  tags,
  personalTags,
  loading = false,
  actions,
}: {
  coverUrl: string;
  fallbackCode: string;
  code: string;
  dlsiteUrl: string;
  title: string;
  circle: string;
  circleExternalId: string;
  ratingLabel: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  baseCode?: string;
  metadataLanguage?: string;
  metadataPresentation?: WorkMetadataPresentation;
  metadataSync?: WorkMetadataSyncStatus;
  canSyncMetadata?: boolean;
  metadataSyncBusy?: boolean;
  onSyncMetadata?: () => void;
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
  tags: string[];
  personalTags?: ReactNode;
  loading?: boolean;
  actions?: ReactNode;
}) {
  const entityResolver = useDetailEntityResolver(code);
  const wideLayout = useWideDetailLayout();
  const cover = (
    <div className="overflow-hidden rounded-lg border bg-muted" data-testid="detail-cover">
      <div className="aspect-[4/3]">
        {coverUrl ? (
          <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-contain" />
        ) : (
          <div className="grid h-full place-items-center text-4xl font-bold">{fallbackCode.slice(0, 2)}</div>
        )}
      </div>
    </div>
  );

  return (
    <section className="space-y-4">
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
      />

      <DetailMetadataContent
        layout="matrix"
        matrixCover={cover}
        wideMatrix={wideLayout}
        ratingLabel={ratingLabel}
        rating={rating}
        ratingCount={ratingCount}
        sales={sales}
        releaseDate={releaseDate}
        dlsiteFetchedAt={dlsiteFetchedAt}
        ageRating={ageRating}
        metadataLanguage={metadataLanguage}
        metadataPresentation={metadataPresentation}
        metadataSync={metadataSync}
        canSyncMetadata={canSyncMetadata}
        metadataSyncBusy={metadataSyncBusy}
        onSyncMetadata={onSyncMetadata}
        activeMetadataVariantKey={activeMetadataVariantKey}
        onMetadataVariantSelect={onMetadataVariantSelect}
        baseCode={baseCode}
        translations={translations}
        activeVersionCode={activeVersionCode}
        onVersionSelect={onVersionSelect}
        remoteVersions={remoteVersions}
        sourceInfo={sourceInfo}
        voiceActors={voiceActors}
        voiceCredits={voiceCredits}
        tags={tags}
        code={code}
        entityResolver={entityResolver}
        supplementary={personalTags}
        matrixFooter={actions}
      />
    </section>
  );
}

function MobileWorkDetailLayout({
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
      <div className="overflow-hidden rounded-lg border bg-muted">
        <div className="aspect-[4/3] max-h-[58vh]">
          {coverUrl ? (
            <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-contain" />
          ) : (
            <div className="grid h-full place-items-center text-4xl font-bold">{fallbackCode.slice(0, 2)}</div>
          )}
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
      />

      <MobileVoiceSummary
        voiceActors={voiceActors}
        voiceCredits={voiceCredits}
        entityResolver={entityResolver}
        onShowAll={() => onActiveTabChange("info")}
      />

      <div data-testid="hero-actions" className="flex flex-wrap gap-2 rounded-lg border bg-card p-3">
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
          <DetailMetadataContent
            ratingLabel={ratingLabel}
            rating={rating}
            ratingCount={ratingCount}
            sales={sales}
            releaseDate={releaseDate}
            dlsiteFetchedAt={dlsiteFetchedAt}
            ageRating={ageRating}
            metadataLanguage={metadataLanguage}
            metadataPresentation={metadataPresentation}
            metadataSync={metadataSync}
            canSyncMetadata={canSyncMetadata}
            metadataSyncBusy={metadataSyncBusy}
            onSyncMetadata={onSyncMetadata}
            activeMetadataVariantKey={activeMetadataVariantKey}
            onMetadataVariantSelect={onMetadataVariantSelect}
            baseCode={baseCode}
            translations={translations}
            activeVersionCode={activeVersionCode}
            onVersionSelect={onVersionSelect}
            remoteVersions={remoteVersions}
            sourceInfo={sourceInfo}
            voiceActors={voiceActors}
            voiceCredits={voiceCredits}
            tags={tags}
            code={code}
            entityResolver={entityResolver}
            supplementary={personalTags}
          />
        </div>
      ) : (
        directory
      )}
    </section>
  );
}

function MobileVoiceSummary({
  voiceActors,
  voiceCredits,
  entityResolver,
  onShowAll,
}: {
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  entityResolver: DetailEntityResolver;
  onShowAll: () => void;
}) {
  const credits =
    voiceCredits.length > 0 ? voiceCredits : voiceActors.map((displayName) => ({ personId: 0, displayName }));
  if (credits.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-2" aria-label={i18n.t("libraryDetail.voiceActors")}>
      <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {credits.slice(0, 2).map((credit) => (
          <button
            key={`${credit.personId}:${credit.displayName}`}
            className="min-w-0 truncate rounded-md border bg-card px-2 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary"
            onClick={() =>
              credit.personId > 0
                ? openVoiceRoute(credit.personId)
                : entityResolver.resolveEntity("voice", credit.displayName)
            }
          >
            {credit.displayName}
          </button>
        ))}
        {credits.length > 2 && (
          <button className="shrink-0 text-xs font-medium text-muted-foreground hover:text-primary" onClick={onShowAll}>
            +{credits.length - 2}
          </button>
        )}
      </div>
    </div>
  );
}

type DetailEntityKind = "circle" | "series" | "voice";

type DetailEntityResolver = {
  resolvingEntity: DetailEntityKind | null;
  resolveEntity: (kind: DetailEntityKind, name: string) => void;
};

function useDetailEntityResolver(code: string): DetailEntityResolver {
  const toast = useToast();
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
      const result = await api.resolveWorkEntityLink(code, kind, name);
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
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label={i18n.t("libraryDetail.workCodeActions")}
        >
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
        <h2 className="min-w-0 text-2xl font-semibold leading-tight lg:text-3xl">{title}</h2>
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

function DetailMetadataContent({
  layout = "stacked",
  matrixCover,
  wideMatrix = false,
  ratingLabel,
  rating,
  ratingCount,
  sales,
  releaseDate,
  dlsiteFetchedAt,
  ageRating,
  metadataLanguage,
  metadataPresentation,
  metadataSync,
  canSyncMetadata,
  metadataSyncBusy,
  onSyncMetadata,
  activeMetadataVariantKey,
  onMetadataVariantSelect,
  baseCode,
  translations = [],
  activeVersionCode,
  onVersionSelect,
  remoteVersions,
  sourceInfo,
  voiceActors,
  voiceCredits,
  tags,
  code,
  entityResolver,
  supplementary,
  matrixFooter,
}: {
  layout?: "stacked" | "matrix";
  matrixCover?: ReactNode;
  wideMatrix?: boolean;
  ratingLabel: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  releaseDate: string;
  dlsiteFetchedAt: string;
  ageRating: string;
  metadataLanguage?: string;
  metadataPresentation?: WorkMetadataPresentation;
  metadataSync?: WorkMetadataSyncStatus;
  canSyncMetadata?: boolean;
  metadataSyncBusy?: boolean;
  onSyncMetadata?: () => void;
  activeMetadataVariantKey?: string;
  onMetadataVariantSelect?: (key: string) => void;
  baseCode?: string;
  translations?: WorkDetail["translations"];
  activeVersionCode?: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  remoteVersions?: boolean;
  sourceInfo: ActiveSourceInfoModel;
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  tags: string[];
  code: string;
  entityResolver: DetailEntityResolver;
  supplementary?: ReactNode;
  matrixFooter?: ReactNode;
}) {
  const displayVoiceCredits =
    voiceCredits.length > 0 ? voiceCredits : voiceActors.map((name) => ({ personId: 0, displayName: name }));
  const baseTranslation = translations.find(
    (translation) => translation.primaryCode.toUpperCase() === (baseCode ?? "").toUpperCase(),
  );
  const availabilityScope: WorkVersionAvailabilityScope = remoteVersions ? "source" : "local";
  const versionSelector =
    metadataLanguage || (metadataPresentation?.variants.length ?? 0) > 0 || baseCode || translations.length > 0 ? (
      <WorkVersionSelector
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
    ) : null;
  const metadataNotice = (
    <MetadataSyncNotice
      status={metadataSync?.status}
      checkedAt={metadataSync?.checkedAt ?? ""}
      canSync={Boolean(canSyncMetadata && onSyncMetadata)}
      busy={metadataSyncBusy ?? false}
      onSync={onSyncMetadata}
    />
  );
  const showMetadataNotice = metadataSync?.status === "not_synced" || metadataSync?.status === "not_found";
  const voiceCard = (
    <div className="rounded-lg border bg-card p-3">
      <DetailChipRow
        icon={<UserRound className="h-4 w-4" />}
        label={i18n.t("libraryDetail.voiceActors")}
        emptyLabel={i18n.t("libraryDetail.noVoiceActorMetadata")}
        items={displayVoiceCredits.map((credit) => ({
          key: `${credit.personId}:${credit.displayName}`,
          label: credit.displayName,
          onClick:
            credit.personId > 0
              ? () => openVoiceRoute(credit.personId)
              : () => entityResolver.resolveEntity("voice", credit.displayName),
        }))}
      />
    </div>
  );
  const tagsCard = (
    <div className="rounded-lg border bg-card p-3">
      <DetailChipRow
        icon={<Tags className="h-4 w-4" />}
        label={i18n.t("libraryDetail.tags")}
        emptyLabel={i18n.t("libraryDetail.noTagMetadata")}
        items={tags.map((tag) => ({ key: tag, label: tag, onClick: () => openDetailTagSearch(tag) }))}
      />
    </div>
  );
  const dlsiteCard = (
    <DlsiteMetrics
      ratingLabel={ratingLabel}
      rating={rating}
      ratingCount={ratingCount}
      sales={sales}
      releaseDate={releaseDate}
      dlsiteFetchedAt={dlsiteFetchedAt}
      ageRating={ageRating}
    />
  );
  const identityMetadata = (
    <div className="min-w-0 space-y-3" data-testid="detail-identity-metadata">
      {voiceCard}
      {tagsCard}
      {supplementary}
    </div>
  );
  const sourceMetadata = (
    <div className="min-w-0 space-y-3" data-testid="detail-source-metadata">
      {dlsiteCard}
      <ActiveSourceInfo info={sourceInfo} />
    </div>
  );
  const matrixTrailing =
    showMetadataNotice || versionSelector || matrixFooter ? (
      <div className="min-w-0 space-y-3">
        {metadataNotice}
        {versionSelector}
        {matrixFooter && (
          <div data-testid="hero-actions" className="flex min-w-0 flex-wrap gap-2 rounded-lg border bg-card p-3">
            {matrixFooter}
          </div>
        )}
      </div>
    ) : null;
  if (layout === "matrix") {
    if (wideMatrix) {
      return (
        <div className="grid grid-cols-[minmax(18rem,1.15fr)_minmax(0,2fr)] items-start gap-5">
          {matrixCover}
          <div className="min-w-0 space-y-3">
            <div className="grid grid-cols-[minmax(15rem,1fr)_minmax(15rem,1fr)] items-start gap-3">
              {identityMetadata}
              {sourceMetadata}
            </div>
            {matrixTrailing}
          </div>
        </div>
      );
    }
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-5">
        <div className="min-w-0 space-y-5">
          {matrixCover}
          {identityMetadata}
        </div>
        <div className="min-w-0 space-y-3">
          {sourceMetadata}
          {matrixTrailing}
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="space-y-3">
        {voiceCard}
        {tagsCard}
      </div>
      {supplementary}
      {metadataNotice}
      {versionSelector}
      {dlsiteCard}
      <ActiveSourceInfo info={sourceInfo} />
    </>
  );
}

function MetadataSyncNotice({
  status,
  checkedAt,
  canSync,
  busy,
  onSync,
}: {
  status?: string;
  checkedAt: string;
  canSync: boolean;
  busy: boolean;
  onSync?: () => void;
}) {
  if (status !== "not_synced" && status !== "not_found") return null;
  const unavailable = status === "not_found";
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
            {unavailable ? i18n.t("metadata.sourceUnavailable") : i18n.t("libraryDetail.metadataNotSynced")}
          </div>
          <p className="mt-1 text-xs opacity-80">
            {unavailable ? i18n.t("libraryDetail.metadataNotRecorded") : i18n.t("libraryDetail.metadataNotSynced")}
          </p>
          {checkedAt && (
            <div className="mt-1 text-xs opacity-70">
              {i18n.t("common.checking")} {formatDateTime(checkedAt)}
            </div>
          )}
        </div>
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
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return compact;
}

function useWideDetailLayout() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1280px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return wide;
}

function WorkVersionSelector({
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
  const availabilityScope: WorkVersionAvailabilityScope = remoteVersions ? "source" : "local";
  const [showAllEditions, setShowAllEditions] = useState(false);
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
  const metadataVariants = orderedMetadataVariants(metadataPresentation?.variants ?? []);
  const activeMetadataVariant = resolveMetadataVariant(metadataPresentation, activeMetadataVariantKey);
  const hasEditionControls = Boolean(baseCode || translations.length > 0);

  return (
    <div className="rounded-lg border bg-card text-xs">
      {(activeMetadataVariant || metadataLanguage) && (
        <div className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Languages className="h-3.5 w-3.5" />
            <span className="font-medium text-foreground">{i18n.t("libraryDetail.metadataLanguage")}</span>
          </div>
          {metadataVariants.length > 1 ? (
            <FloatingSelect
              value={activeMetadataVariant?.key ?? ""}
              onValueChange={(value) => onMetadataVariantSelect?.(value)}
              ariaLabel={i18n.t("libraryDetail.metadataLanguage")}
              className="w-auto min-w-40 max-w-full px-2 text-xs font-medium"
              options={metadataVariants.map((variant) => ({
                value: variant.key,
                label: metadataVariantLabel(variant, metadataVariants),
              }))}
            />
          ) : (
            <span className="font-semibold text-foreground">
              {activeMetadataVariant
                ? metadataVariantLabel(activeMetadataVariant, metadataVariants)
                : languageLabel(metadataLanguage)}
            </span>
          )}
        </div>
      )}
      {hasEditionControls && (
        <div className="space-y-2 border-t px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              <FolderTree className="h-3.5 w-3.5" />
              <span className="font-medium text-foreground">{i18n.t("libraryDetail.directoryEdition")}</span>
              {baseCode &&
                (baseAvailable ? (
                  <button
                    className="font-semibold text-primary hover:underline"
                    onClick={() => openWorkCodeRoute(baseCode)}
                  >
                    {i18n.t("libraryDetail.baseCode", { code: baseCode })}
                  </button>
                ) : (
                  <span className="font-semibold text-foreground">
                    {i18n.t("libraryDetail.baseCode", { code: baseCode })}
                  </span>
                ))}
            </div>
            {hiddenEditionCount > 0 && (
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                aria-expanded={showAllEditions}
                onClick={() => setShowAllEditions((shown) => !shown)}
              >
                {showAllEditions
                  ? i18n.t("libraryDetail.hideAllEditions")
                  : i18n.t("libraryDetail.showAllEditions", { count: hiddenEditionCount })}
              </button>
            )}
          </div>
          {groups.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {groups.map((group) => (
                <WorkLanguageVersionPicker
                  key={group.key}
                  group={group}
                  activeVersionCode={activeVersionCode}
                  onVersionSelect={onVersionSelect}
                  availabilityScope={availabilityScope}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function metadataVariantLabel(
  variant: WorkMetadataPresentation["variants"][number],
  variants: WorkMetadataPresentation["variants"],
) {
  const language = languageLabel(variant.language);
  const sameLanguageCount = variants.filter(
    (candidate) => candidate.language.trim().toLowerCase() === variant.language.trim().toLowerCase(),
  ).length;
  const prefix = variant.origin ? `${i18n.t("libraryDetail.original")} · ${language}` : language;
  return sameLanguageCount > 1 ? `${prefix} · ${variant.key}` : prefix;
}

function WorkLanguageVersionPicker({
  group,
  activeVersionCode,
  onVersionSelect,
  availabilityScope,
}: {
  group: WorkVersionGroup;
  activeVersionCode: string;
  onVersionSelect?: (translation: WorkDetail["translations"][number]) => void;
  availabilityScope: WorkVersionAvailabilityScope;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const language = group.language ? languageLabel(group.language) : i18n.t("libraryDetail.unknownLanguage");
  const preferred = preferredWorkVersion(group.versions, activeVersionCode, availabilityScope);
  const activeCode = activeVersionCode.trim().toUpperCase();
  const groupActive = group.versions.some((version) => version.primaryCode.trim().toUpperCase() === activeCode);
  const preferredActive = preferred?.primaryCode.trim().toUpperCase() === activeCode;
  const preferredAvailable = Boolean(preferred && workVersionAvailableForScope(preferred, availabilityScope));
  const selectVersion = (translation: WorkDetail["translations"][number]) => {
    const active = translation.primaryCode.trim().toUpperCase() === activeCode;
    if (active || !workVersionAvailableForScope(translation, availabilityScope)) return;
    setOpen(false);
    if (onVersionSelect) {
      onVersionSelect(translation);
    } else {
      openWorkCodeRoute(translation.primaryCode);
    }
  };

  return (
    <div ref={anchorRef} role="group" aria-label={i18n.t("libraryDetail.languageVersions", { language })}>
      <div
        className={`inline-flex overflow-hidden rounded-md border ${
          groupActive
            ? "border-primary bg-primary text-primary-foreground"
            : preferredAvailable
              ? "border-primary/30 text-primary"
              : "border-muted bg-muted text-muted-foreground"
        }`}
      >
        <button
          type="button"
          className={`px-2.5 py-1 font-semibold ${!groupActive && preferredAvailable ? "hover:bg-primary/10" : ""}`}
          disabled={!preferredAvailable || preferredActive}
          onClick={() => {
            if (preferred) selectVersion(preferred);
          }}
        >
          {language}
        </button>
        <button
          type="button"
          className={`border-l px-1.5 ${groupActive ? "border-primary-foreground/30" : "border-current/20"} hover:bg-black/10`}
          aria-label={i18n.t("libraryDetail.chooseLanguageCode", { language })}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        align="start"
        className="w-[min(19rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="menu" aria-label={i18n.t("libraryDetail.languageCodes", { language })} className="space-y-1">
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
                disabled={active || !available}
                className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : available
                      ? "hover:bg-accent hover:text-accent-foreground"
                      : "text-muted-foreground"
                }`}
                onClick={() => selectVersion(translation)}
              >
                <span>
                  <span className="font-semibold">{translation.primaryCode}</span>
                  <span className="ml-2 text-xs">{workVersionKindLabel(translation)}</span>
                </span>
                <span className="shrink-0 text-xs opacity-80">{stateLabel}</span>
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </div>
  );
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

function DlsiteMetrics({
  ratingLabel,
  rating,
  ratingCount,
  sales,
  releaseDate,
  dlsiteFetchedAt,
  ageRating,
}: {
  ratingLabel: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  releaseDate: string;
  dlsiteFetchedAt: string;
  ageRating: string;
}) {
  const normalizedRatingLabel = ratingLabel.toLowerCase().includes("dl") ? i18n.t("workCard.ratingShort") : ratingLabel;
  const rateValue =
    rating === null ? "—" : `${rating.toFixed(2)}${ratingCount ? ` (${ratingCount.toLocaleString()})` : ""}`;
  const age = ageRatingPresentation(ageRating);
  const ageValue = age.label === "Unknown" ? "—" : age.label;
  const dateValue = dlsiteFetchedAt ? `${releaseDate} / ${dlsiteFetchedAt}` : releaseDate;
  return (
    <div data-testid="dlsite-info" className="w-full rounded-lg border bg-card p-3 text-sm">
      <div className="mb-2 text-xs font-medium text-muted-foreground">{i18n.t("libraryDetail.dlsiteInfo")}</div>
      <div className="space-y-2">
        <div
          data-testid="dlsite-primary-metrics"
          className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-2xs leading-4"
        >
          <InlineDlsiteMetric label={normalizedRatingLabel} value={rateValue} />
          <InlineDlsiteMetric
            label={i18n.t("library.searchClauseKinds.age")}
            value={ageValue}
            valueClassName={age.textClassName}
          />
          <InlineDlsiteMetric
            label={i18n.t("library.sortOptions.sales")}
            value={sales === null ? "—" : sales.toLocaleString()}
          />
        </div>
        <MetricLine
          icon={<Clock3 className="h-3.5 w-3.5" />}
          label={dlsiteFetchedAt ? i18n.t("libraryDetail.releasedUpdated") : i18n.t("libraryDetail.released")}
          value={dateValue}
        />
      </div>
    </div>
  );
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
    <div data-testid="active-source-info" className="w-full rounded-lg border bg-card p-3 text-sm">
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

function InlineDlsiteMetric({
  label,
  value,
  valueClassName = "",
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-baseline gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold ${valueClassName || "text-foreground"}`}>{value}</span>
    </span>
  );
}

function MetricLine({
  icon,
  label,
  value,
  valueClassName = "",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={`min-w-0 truncate text-xs font-semibold ${valueClassName || "text-foreground"}`}>{value}</span>
    </div>
  );
}

function DetailChipRow({
  icon,
  label,
  emptyLabel,
  items,
}: {
  icon: ReactNode;
  label: string;
  emptyLabel: string;
  items: { key: string; label: string; onClick?: () => void }[];
}) {
  return (
    <div className="flex gap-2 text-sm">
      <div className="mt-1 text-muted-foreground">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        {items.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {items.map((item) =>
              item.onClick ? (
                <button
                  key={item.key}
                  className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary"
                  onClick={item.onClick}
                >
                  {item.label}
                </button>
              ) : (
                <span
                  key={item.key}
                  className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground"
                >
                  {item.label}
                </span>
              ),
            )}
          </div>
        ) : (
          <div className="mt-1 text-muted-foreground">{emptyLabel}</div>
        )}
      </div>
    </div>
  );
}

function openDetailTagSearch(tag: string) {
  const value = tag.trim();
  if (!value) return;
  const state = window.history.state as { returnTo?: unknown } | null;
  const returnTo = typeof state?.returnTo === "string" && isInternalReturnPath(state.returnTo) ? state.returnTo : "/";
  const target = new URL(returnTo, window.location.origin);
  const browseState = libraryBrowseStateFromSearch(target.search, defaultLibraryBrowseState);
  const clauses = parseSearchClauses(browseState.query).filter(
    (clause) => !(clause.kind === "tag" && clause.value.toLowerCase() === value.toLowerCase()),
  );
  const query = [...clauses, { kind: "tag" as const, value }].map(formatSearchClause).join(" ");
  target.search = libraryBrowseSearch({ ...browseState, query, page: 1, scrollY: 0 });
  window.history.pushState({}, "", `${target.pathname}${target.search}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function openResolvedEntityRoute(route: string) {
  if (!route.startsWith("/")) return;
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.history.pushState(historyStateWithReturn(returnTo, i18n.t("detailActions.back")), "", route);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}
