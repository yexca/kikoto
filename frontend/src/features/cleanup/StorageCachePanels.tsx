import { ChevronDown, Film, HardDrive, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SettingsSection } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type CacheOverview } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import {
  cacheCleanupGroups,
  cacheCleanupRows,
  formatByteSize,
  usagePercent,
  type CacheCleanupMode,
  type CacheCleanupRow,
} from "./cacheCleanupModel";

const CACHE_GROUP_PAGE_SIZE = 50;

export function UsageBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div
        className={cn("h-full rounded-full transition-[width]", percent >= 90 ? "bg-warning" : "bg-primary")}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export function TranscodeCacheSection({
  overview,
  scanning,
  readOnly,
  onChanged,
}: {
  overview: CacheOverview | null;
  scanning: boolean;
  readOnly: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [status, setStatus] = useState("");
  const transcode = overview?.transcode;
  const percent = transcode ? usagePercent(transcode.bytes, transcode.limitBytes) : 0;

  const clear = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setClearing(true);
    try {
      const result = await api.clearTranscodeCache();
      setConfirming(false);
      setStatus(
        result.deletedFiles > 0
          ? t("maintenance.cache.transcodeRemoved", {
              count: result.deletedFiles,
              size: formatByteSize(result.freedBytes),
            })
          : t("maintenance.cache.transcodeEmpty"),
      );
      toast.success(
        result.deletedFiles > 0 ? t("maintenance.cache.transcodeCleared") : t("maintenance.cache.transcodeEmpty"),
      );
      await onChanged();
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.cache.transcodeClearFailed")));
    } finally {
      setClearing(false);
    }
  };

  return (
    <SettingsSection
      title={t("maintenance.cache.transcodeCache")}
      description={t("cleanup.transcodeDescription")}
      icon={<Film />}
    >
      <div className="space-y-3 px-4 py-4">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <span className="text-2xl font-semibold tabular-nums">
              {transcode ? formatByteSize(transcode.bytes) : "--"}
            </span>
            <span className="ml-2 text-sm text-muted-foreground">
              {transcode
                ? t("cleanup.ofLimit", { limit: formatByteSize(transcode.limitBytes) })
                : t("maintenance.cache.scanning")}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {transcode ? t("maintenance.cache.segments", { count: transcode.files }) : ""}
          </span>
        </div>
        <UsageBar percent={percent} label={t("cleanup.transcodeUsage")} />
        <p className="text-xs text-muted-foreground">{t("cleanup.transcodeLru")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 bg-muted/25 px-4 py-2.5">
        {status && <span className="mr-auto text-xs text-muted-foreground">{status}</span>}
        {confirming && (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            {t("maintenance.cancel")}
          </Button>
        )}
        <Button
          variant="destructive"
          size="sm"
          onClick={() => void clear()}
          disabled={readOnly || clearing || scanning || !overview || (!confirming && (transcode?.files ?? 0) === 0)}
        >
          {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          {clearing
            ? t("maintenance.cache.clearing")
            : confirming
              ? t("maintenance.cache.confirmClear", { count: transcode?.files ?? 0 })
              : t("maintenance.cache.clearTranscode")}
        </Button>
      </div>
    </SettingsSection>
  );
}

export function ManagedMediaCacheSection({
  overview,
  scanning,
  readOnly,
  onRefresh,
}: {
  overview: CacheOverview | null;
  scanning: boolean;
  readOnly: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [mode, setMode] = useState<CacheCleanupMode>("orphans");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [groupLimits, setGroupLimits] = useState<Map<string, number>>(new Map());
  const [confirming, setConfirming] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [status, setStatus] = useState("");
  const labels = useMemo(
    () => ({
      unknownSource: t("maintenance.unknownSource"),
      multipleSources: t("maintenance.multipleSources"),
      sourcesCount: (count: number) => t("maintenance.sourcesCount", { count }),
    }),
    [t],
  );
  const rows = useMemo(() => cacheCleanupRows(overview, mode, labels), [labels, mode, overview]);
  const groups = useMemo(() => cacheCleanupGroups(rows), [rows]);
  const selectedRows = rows.filter((row) => selectedKeys.has(row.key));
  const orphanMode = mode === "orphans";

  const resetSelection = () => {
    setSelectedKeys(new Set());
    setConfirming(false);
  };

  const switchMode = (next: CacheCleanupMode) => {
    setMode(next);
    setExpandedGroups(new Set());
    setGroupLimits(new Map());
    resetSelection();
  };

  const setRowsSelected = (targetRows: CacheCleanupRow[], checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const row of targetRows) {
        if (checked) next.add(row.key);
        else next.delete(row.key);
      }
      return next;
    });
    setConfirming(false);
  };

  const toggleGroup = (groupKey: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
    setGroupLimits((current) =>
      current.has(groupKey) ? current : new Map(current).set(groupKey, CACHE_GROUP_PAGE_SIZE),
    );
  };

  const refresh = async () => {
    resetSelection();
    await onRefresh();
  };

  const cleanup = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setCleaning(true);
    try {
      const result = orphanMode
        ? await api.cleanupCache({ mode: "orphans", groupKeys: selectedRows.map((row) => row.key) })
        : await api.cleanupCache({ mode: "works", workIds: selectedRows.map((row) => row.workId) });
      resetSelection();
      setStatus(
        result.status === "succeeded"
          ? t("maintenance.cache.noEligibleOrphans")
          : t("maintenance.cache.cleanupQueued", { runId: result.runId, count: result.queued }),
      );
      toast.success(
        result.status === "succeeded" ? t("maintenance.cache.alreadyClean") : t("maintenance.cache.cleanupQueuedToast"),
      );
      await onRefresh();
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.cache.cleanupFailed")));
    } finally {
      setCleaning(false);
    }
  };

  return (
    <SettingsSection
      title={t("maintenance.cache.managedCache")}
      description={t("cleanup.managedDescription")}
      icon={<HardDrive />}
      action={
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => void refresh()}
          disabled={scanning}
          aria-label={t("maintenance.cache.refreshOverview")}
          title={t("maintenance.cache.refreshOverview")}
        >
          <RefreshCw className={cn("h-4 w-4", scanning && "animate-spin")} />
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-4">
        <InlineMetric
          label={t("maintenance.cache.onDisk")}
          value={overview ? formatByteSize(overview.mediaBytes) : "--"}
          detail={
            overview ? t("maintenance.cache.files", { count: overview.mediaFiles }) : t("maintenance.cache.scanning")
          }
        />
        <InlineMetric
          label={t("maintenance.cache.referenced")}
          value={overview ? formatByteSize(overview.referencedBytes) : "--"}
          detail={
            overview
              ? t("maintenance.cache.files", { count: overview.referencedFiles })
              : t("maintenance.cache.scanning")
          }
        />
        <InlineMetric
          label={t("maintenance.cache.eligibleCleanup")}
          value={overview ? formatByteSize(overview.orphanBytes) : "--"}
          detail={
            overview ? t("maintenance.cache.files", { count: overview.orphanFiles }) : t("maintenance.cache.scanning")
          }
          warning={Boolean(overview?.orphanFiles)}
        />
        <InlineMetric
          label={t("maintenance.cache.protected")}
          value={overview ? String(overview.protectedFiles) : "--"}
          detail={t("maintenance.cache.protectedDescription")}
        />
      </div>

      {overview && (overview.missingReferences > 0 || overview.emptyDirectories > 0) && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 bg-muted/25 px-4 py-2 text-xs text-muted-foreground">
          <span>{t("maintenance.cache.missingReferences", { count: overview.missingReferences })}</span>
          <span>{t("maintenance.cache.emptyDirectories", { count: overview.emptyDirectories })}</span>
        </div>
      )}

      <div className="space-y-3 px-4 py-3">
        <div className={segmentedListClassName()} aria-label={t("maintenance.cache.cleanupMode")}>
          <button
            type="button"
            className={segmentedItemClassName(orphanMode)}
            aria-pressed={orphanMode}
            onClick={() => switchMode("orphans")}
          >
            {t("maintenance.cache.orphanCache")}
          </button>
          <button
            type="button"
            className={segmentedItemClassName(!orphanMode)}
            aria-pressed={!orphanMode}
            onClick={() => switchMode("works")}
          >
            {t("maintenance.cache.workCache")}
          </button>
        </div>

        {rows.length > 0 && (
          <div className="overflow-hidden rounded-lg border">
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
              <Checkbox
                checked={selectedKeys.size === rows.length}
                indeterminate={selectedKeys.size > 0 && selectedKeys.size < rows.length}
                onCheckedChange={(checked) => setRowsSelected(rows, checked)}
                aria-label={t("maintenance.cache.selectAll", {
                  target: orphanMode ? t("maintenance.cache.orphanGroups") : t("maintenance.cache.workCaches"),
                })}
              />
              <span>{t("maintenance.cache.groupSummary", { groups: groups.length, works: rows.length })}</span>
              <span>{t("maintenance.cache.filesLabel")}</span>
              <span>{t("maintenance.cache.size")}</span>
            </div>
            <div className="app-scroll max-h-[28rem] overflow-y-auto">
              {groups.map((group) => {
                const selectedInGroup = group.rows.filter((row) => selectedKeys.has(row.key)).length;
                const expanded = expandedGroups.has(group.key);
                const visibleRows = group.rows.slice(0, groupLimits.get(group.key) ?? CACHE_GROUP_PAGE_SIZE);
                const remainingRows = group.rows.length - visibleRows.length;
                return (
                  <section key={group.key} className="border-b last:border-b-0">
                    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-2.5">
                      <Checkbox
                        checked={selectedInGroup === group.rows.length}
                        indeterminate={selectedInGroup > 0 && selectedInGroup < group.rows.length}
                        onCheckedChange={(checked) => setRowsSelected(group.rows, checked)}
                        aria-label={t("maintenance.cache.selectGroup", { group: group.label })}
                      />
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-2 text-left"
                        aria-expanded={expanded}
                        aria-label={t(expanded ? "maintenance.cache.collapseGroup" : "maintenance.cache.expandGroup", {
                          group: group.label,
                        })}
                        onClick={() => toggleGroup(group.key)}
                      >
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                            !expanded && "-rotate-90",
                          )}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{group.label}</span>
                          <span className="block text-xs text-muted-foreground">
                            {t("maintenance.cache.workCount", { count: group.rows.length })}
                          </span>
                        </span>
                      </button>
                      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                        {group.files}
                      </span>
                      <span
                        className={cn(
                          "whitespace-nowrap text-xs font-semibold tabular-nums",
                          orphanMode && "text-destructive",
                        )}
                      >
                        {formatByteSize(group.bytes)}
                      </span>
                    </div>
                    {expanded &&
                      visibleRows.map((row) => (
                        <div
                          key={row.key}
                          className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-t bg-muted/15 px-3 py-2 pl-9 text-sm"
                        >
                          <Checkbox
                            checked={selectedKeys.has(row.key)}
                            onCheckedChange={(checked) => setRowsSelected([row], checked)}
                            aria-label={t("maintenance.cache.selectWork", { code: row.workCode })}
                          />
                          <div className="min-w-0">
                            <div className="truncate font-medium">{row.workCode}</div>
                            <div className="truncate text-xs text-muted-foreground">{row.sourceLabel}</div>
                          </div>
                          <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                            {row.files}
                          </span>
                          <span
                            className={cn(
                              "whitespace-nowrap text-xs font-medium tabular-nums",
                              orphanMode && "text-destructive",
                            )}
                          >
                            {formatByteSize(row.bytes)}
                          </span>
                        </div>
                      ))}
                    {expanded && remainingRows > 0 && (
                      <button
                        type="button"
                        className="w-full border-t px-3 py-2 text-xs font-medium text-primary hover:bg-muted/40"
                        onClick={() =>
                          setGroupLimits((current) =>
                            new Map(current).set(
                              group.key,
                              (current.get(group.key) ?? CACHE_GROUP_PAGE_SIZE) + CACHE_GROUP_PAGE_SIZE,
                            ),
                          )
                        }
                      >
                        {t("maintenance.cache.showMore", {
                          count: Math.min(CACHE_GROUP_PAGE_SIZE, remainingRows),
                          group: group.label,
                        })}
                      </button>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
        )}

        {overview && rows.length === 0 && (
          <div className="rounded-lg border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
            {orphanMode ? t("maintenance.cache.noEligibleGroups") : t("maintenance.cache.noReferencedCache")}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 bg-muted/25 px-4 py-2.5">
        {status && <span className="mr-auto text-xs text-muted-foreground">{status}</span>}
        {confirming && (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            {t("maintenance.cancel")}
          </Button>
        )}
        <Button
          variant="destructive"
          size="sm"
          onClick={() => void cleanup()}
          disabled={readOnly || cleaning || scanning || selectedRows.length === 0}
        >
          {cleaning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          {cleaning
            ? t("maintenance.cache.queueingCleanup")
            : confirming
              ? t("maintenance.cache.confirmCleanup", {
                  count: selectedRows.reduce((total, row) => total + row.files, 0),
                })
              : t("maintenance.cache.cleanSelected", {
                  target: orphanMode ? t("maintenance.cache.orphans") : t("maintenance.cache.works"),
                })}
        </Button>
      </div>
    </SettingsSection>
  );
}

function InlineMetric({
  label,
  value,
  detail,
  warning = false,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  warning?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 truncate text-base font-semibold tabular-nums", warning && "text-destructive")}>
        {value}
      </div>
      <div className="truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}
