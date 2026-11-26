import {
  Globe,
  HardDrive,
  Layers,
  ListChecks,
  Loader2,
  PlugZap,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SettingsSection } from "@/components/settings/SettingsSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { FileSource, LibraryLayout, LibraryPool } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { remoteSourceHealth, remoteSourceHost } from "./remoteSourceModel";

const healthDotClassNames = {
  healthy: "bg-success",
  unavailable: "bg-error",
  unknown: "bg-muted-foreground/40",
  disabled: "bg-muted-foreground/20",
} as const;

const localDotClassNames = {
  online: "bg-success",
  offline: "bg-warning",
  unknown: "bg-muted-foreground/40",
} as const;

/**
 * Every library the server reads: the local library as one card (its pools
 * as rows in Storage pools mode), followed by remote sources as cards. Each
 * card opens its own dialog; Add source sits with the remote group.
 */
export function LibrarySourceList({
  localName,
  layout,
  layoutFailed,
  reconnectingPool,
  onConfigureStorage,
  onReconnectPool,
  sources,
  checkingSourceId,
  togglingSourceId,
  readOnly,
  onCreate,
  onEdit,
  onDelete,
  onCheck,
  onToggleEnabled,
  renderSourceCheck,
  onOpenSourceCheck,
  legacyWorkflowReview,
}: {
  localName: string;
  layout: LibraryLayout | null;
  layoutFailed: boolean;
  reconnectingPool: string | null;
  onConfigureStorage: () => void;
  onReconnectPool: (path: string) => Promise<void>;
  sources: FileSource[];
  checkingSourceId: number | null;
  togglingSourceId: number | null;
  readOnly: boolean;
  onCreate: () => void;
  onEdit: (source: FileSource) => void;
  onDelete: (source: FileSource) => void;
  onCheck: (id: number) => Promise<void>;
  onToggleEnabled: (source: FileSource, enabled: boolean) => Promise<void>;
  /** A source's library work check line, or nothing for a source that does not answer work checks. */
  renderSourceCheck?: (source: FileSource) => ReactNode;
  /** Opens a source's library work check; omitted for a viewer who cannot run it. */
  onOpenSourceCheck?: (source: FileSource) => void;
  /** Optional inline review for earlier custom workflows when present. */
  legacyWorkflowReview?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("maintenance.library.libraries")}>
      <div className="!border-t-0 pb-2">
        <GroupLabel>{t("maintenance.library.localGroup")}</GroupLabel>
        <LocalStorageCards
          localName={localName}
          layout={layout}
          layoutFailed={layoutFailed}
          readOnly={readOnly}
          reconnectingPool={reconnectingPool}
          onConfigureStorage={onConfigureStorage}
          onReconnectPool={onReconnectPool}
        />
      </div>

      <div className="!border-t-0">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <GroupLabel id="remote-sources">{t("maintenance.library.remoteGroup")}</GroupLabel>
          {/* An empty list offers Add source in its own placeholder. */}
          {sources.length > 0 && (
            <Button variant="ghost" size="sm" onClick={onCreate} disabled={readOnly}>
              <Plus className="h-4 w-4" />
              {t("maintenance.library.addSource")}
            </Button>
          )}
        </div>
        {sources.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {sources.map((source) => {
              const health = remoteSourceHealth(source);
              const host = remoteSourceHost(source) || t("maintenance.noEndpointConfigured");
              const checking = checkingSourceId === source.id;
              const sourceCheck = renderSourceCheck?.(source);
              return (
                <Card key={source.id} className="flex min-w-0 flex-col justify-between gap-3 p-3.5">
                  <div className="space-y-1.5">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-start gap-2.5">
                        <span
                          className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", healthDotClassNames[health])}
                          aria-hidden="true"
                        />
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onEdit(source)}>
                          <span
                            className={cn(
                              "flex min-w-0 items-center gap-1.5 text-sm font-medium",
                              !source.enabled && "text-muted-foreground",
                            )}
                          >
                            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                            <span className="truncate">{source.displayName}</span>
                          </span>
                          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <span className={cn("shrink-0", health === "unavailable" && "text-error-foreground")}>
                              {t(`sourceSetup.health.${health}`)}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="truncate" title={host}>
                              {host}
                            </span>
                          </span>
                        </button>
                      </div>
                      <Switch
                        checked={source.enabled}
                        disabled={readOnly || togglingSourceId === source.id}
                        onCheckedChange={(enabled) => void onToggleEnabled(source, enabled)}
                        aria-label={t("sourceSetup.enableNamed", { name: source.displayName })}
                      />
                    </div>
                    {sourceCheck && <div className="min-w-0 pl-5 text-xs">{sourceCheck}</div>}
                  </div>
                  <div className="flex items-center justify-end gap-0.5 border-t pt-2">
                    {onOpenSourceCheck && sourceCheck && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={t("maintenance.library.checkLibraryWorks")}
                        title={t("maintenance.library.checkLibraryWorks")}
                        onClick={() => onOpenSourceCheck(source)}
                      >
                        <ListChecks className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={t("maintenance.library.checkHealth")}
                      title={t("maintenance.library.checkHealth")}
                      onClick={() => void onCheck(source.id)}
                      disabled={readOnly || !source.enabled || checkingSourceId !== null}
                    >
                      <RefreshCw className={cn("h-4 w-4", checking && "animate-spin")} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={t("maintenance.library.configure")}
                      title={t("maintenance.library.configure")}
                      onClick={() => onEdit(source)}
                    >
                      <Settings2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={t("maintenance.library.deleteSource")}
                      title={t("maintenance.library.deleteSource")}
                      onClick={() => onDelete(source)}
                      disabled={readOnly}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-8 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
              <Globe className="h-5 w-5" />
            </span>
            <p className="max-w-sm text-sm text-muted-foreground">{t("sourceSetup.empty")}</p>
            <Button size="sm" onClick={onCreate} disabled={readOnly}>
              <Plus className="h-4 w-4" />
              {t("maintenance.library.addSource")}
            </Button>
          </div>
        )}
      </div>

      {legacyWorkflowReview && <div className="!border-t-0 mt-5 border-t pt-4">{legacyWorkflowReview}</div>}
    </SettingsSection>
  );
}

function LocalStorageCards({
  localName,
  layout,
  layoutFailed,
  readOnly,
  reconnectingPool,
  onConfigureStorage,
  onReconnectPool,
}: {
  localName: string;
  layout: LibraryLayout | null;
  layoutFailed: boolean;
  readOnly: boolean;
  reconnectingPool: string | null;
  onConfigureStorage: () => void;
  onReconnectPool: (path: string) => Promise<void>;
}) {
  const { t } = useTranslation();

  if (!layout) {
    return (
      <LocalCardGrid>
        <LocalLibraryCard
          status="unknown"
          icon={<HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          title={localName}
          subtitle={layoutFailed ? t("librarySetup.loadFailed") : t("common.loading")}
          onConfigureStorage={onConfigureStorage}
        />
      </LocalCardGrid>
    );
  }

  if (layout.mode !== "pools") {
    const pool = layout.pools[0];
    const status = !pool ? "unknown" : pool.online ? "online" : "offline";
    const stateLabel = pool ? t(pool.online ? "librarySetup.online" : "librarySetup.offline") : t("common.loading");
    return (
      <LocalCardGrid>
        <LocalLibraryCard
          status={status}
          icon={<HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          title={localName}
          subtitle={`${t("librarySetup.modes.standard.name")} · ${stateLabel}`}
          subtitleWarning={status === "offline"}
          onConfigureStorage={onConfigureStorage}
          footer={
            pool && !pool.online ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2.5">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("librarySetup.offlineHelp")}</p>
                {pool.canReconnect && (
                  <ReconnectPoolButton
                    pool={pool}
                    readOnly={readOnly}
                    reconnectingPool={reconnectingPool}
                    onReconnect={onReconnectPool}
                  />
                )}
              </div>
            ) : undefined
          }
        />
      </LocalCardGrid>
    );
  }

  // Storage pools are one library: one card that names how many pools are
  // online, with a row per pool for its state, the Fetch pool, and Reconnect.
  const online = layout.pools.filter((pool) => pool.online).length;
  const status = layout.pools.length === 0 ? "unknown" : online === layout.pools.length ? "online" : "offline";
  return (
    <LocalLibraryCard
      status={status}
      icon={<Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      title={localName}
      subtitle={`${t("librarySetup.modes.pools.name")} · ${t("maintenance.library.poolsOnline", { online, total: layout.pools.length })}`}
      subtitleWarning={status === "offline"}
      onConfigureStorage={onConfigureStorage}
      footer={
        layout.pools.length > 0 ? (
          <ul className="divide-y border-t" aria-label={t("librarySetup.pools")}>
            {layout.pools.map((pool) => (
              <li key={pool.path} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    localDotClassNames[pool.online ? "online" : "offline"],
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-sm" title={`/data/${pool.path}`}>
                  /data/{pool.path}
                </span>
                {layout.fetchPool === pool.path && <Badge variant="secondary">{t("librarySetup.fetchPool")}</Badge>}
                <span className={cn("text-xs", pool.online ? "text-muted-foreground" : "text-warning-foreground")}>
                  {t(pool.online ? "librarySetup.online" : "librarySetup.offline")}
                </span>
                {pool.canReconnect && (
                  <ReconnectPoolButton
                    pool={pool}
                    readOnly={readOnly}
                    reconnectingPool={reconnectingPool}
                    onReconnect={onReconnectPool}
                  />
                )}
              </li>
            ))}
          </ul>
        ) : undefined
      }
    />
  );
}

function LocalCardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>;
}

function LocalLibraryCard({
  status,
  icon,
  title,
  titleMono = false,
  subtitle,
  subtitleWarning = false,
  onConfigureStorage,
  footer,
}: {
  status: keyof typeof localDotClassNames;
  icon: ReactNode;
  title: string;
  titleMono?: boolean;
  subtitle: string;
  subtitleWarning?: boolean;
  onConfigureStorage: () => void;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Card className="flex min-w-0 flex-col justify-between gap-3 p-3.5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <span
            className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", localDotClassNames[status])}
            aria-hidden="true"
          />
          <button type="button" className="min-w-0 flex-1 text-left" onClick={onConfigureStorage}>
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
              {icon}
              <span className={cn("truncate", titleMono && "font-mono")} title={title}>
                {title}
              </span>
            </span>
            <span
              className={cn(
                "mt-0.5 block truncate text-xs text-muted-foreground",
                subtitleWarning && "text-warning-foreground",
              )}
            >
              {subtitle}
            </span>
          </button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={t("maintenance.library.storageSettings")}
          title={t("maintenance.library.storageSettings")}
          onClick={onConfigureStorage}
        >
          <Settings2 className="h-4 w-4" />
        </Button>
      </div>
      {footer}
    </Card>
  );
}

function ReconnectPoolButton({
  pool,
  readOnly,
  reconnectingPool,
  onReconnect,
}: {
  pool: LibraryPool;
  readOnly: boolean;
  reconnectingPool: string | null;
  onReconnect: (path: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const reconnecting = reconnectingPool === pool.path;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={readOnly || reconnectingPool !== null}
      onClick={() => void onReconnect(pool.path)}
    >
      {reconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
      {t("librarySetup.reconnect")}
    </Button>
  );
}

/** A loading placeholder with the footprint of the Libraries section: its heading and two card groups. */
export function LibrarySourceListSkeleton() {
  const card = (footer: boolean, key: number) => (
    <Card key={key} className="flex min-w-0 flex-col gap-3 p-3.5">
      <div className="flex min-w-0 items-start gap-2.5">
        <Skeleton className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
      {footer && (
        <div className="flex items-center justify-end gap-0.5 border-t pt-2">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-8 w-8 rounded-md" />
          ))}
        </div>
      )}
    </Card>
  );
  return (
    <div className="skeleton-reveal min-w-0" aria-hidden="true">
      <div className="border-b pb-2.5">
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="pb-2">
        <div className="pb-2 pt-3">
          <Skeleton className="h-3 w-16" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{card(false, 0)}</div>
      </div>
      <div>
        <div className="pb-2 pt-3">
          <Skeleton className="h-3 w-20" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{[1, 2].map((key) => card(true, key))}</div>
      </div>
    </div>
  );
}

function GroupLabel({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="scroll-mt-24 pb-2 pt-3 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}
