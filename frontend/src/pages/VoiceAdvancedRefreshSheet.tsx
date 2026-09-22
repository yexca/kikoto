import { ArrowUpRight, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState, type RefObject } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MobileSheet, MobileSheetBody, MobileSheetHeader } from "@/components/ui/mobile-sheet";
import type { VoiceCatalogRefreshState, VoiceRemoteSourceSet } from "@/lib/api";
import { useTranslation } from "react-i18next";

export type VoiceCatalogRefreshMode = "incremental" | "full";

export function VoiceAdvancedRefreshSheet({
  open,
  mobile,
  anchorRef,
  sources,
  loading,
  refreshing,
  activeScope,
  error,
  canRefresh,
  onManageAliases,
  onClose,
  onRefreshCatalog,
  onRefreshMetadata,
}: {
  open: boolean;
  mobile: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  sources: VoiceRemoteSourceSet[];
  loading: boolean;
  refreshing: boolean;
  activeScope?: VoiceCatalogRefreshState["scope"] | null;
  error: string;
  canRefresh: boolean;
  /** Present when the viewer may review aliases; opens the Metadata voice alias view. */
  onManageAliases?: () => void;
  onClose: () => void;
  onRefreshCatalog: (mode: VoiceCatalogRefreshMode, sourceIds: number[]) => void;
  onRefreshMetadata: (mode: VoiceCatalogRefreshMode) => void;
}) {
  const { t } = useTranslation();
  const selectableSourceIds = useMemo(
    () => sources.filter(isVoiceCatalogSourceSelectable).map((source) => source.sourceId),
    [sources],
  );
  const [selectedSourceIds, setSelectedSourceIds] = useState<number[]>([]);
  const [selectionInitialized, setSelectionInitialized] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelectionInitialized(false);
      return;
    }
    if (selectionInitialized || sources.length === 0) return;
    setSelectedSourceIds(selectableSourceIds);
    setSelectionInitialized(true);
  }, [open, selectableSourceIds, selectionInitialized, sources.length]);

  const selectedSourceSet = new Set(selectedSourceIds);
  const busy = loading || refreshing;
  const catalogDisabled = !canRefresh || busy || selectedSourceIds.length === 0;
  const metadataDisabled = !canRefresh || busy;
  const catalogActive = refreshing && (activeScope === "remote" || activeScope === "all");
  const metadataActive = refreshing && (activeScope === "metadata" || activeScope === "all");

  const toggleSource = (sourceId: number, checked: boolean) => {
    setSelectedSourceIds((current) => {
      const next = new Set(current);
      if (checked) next.add(sourceId);
      else next.delete(sourceId);
      return Array.from(next).sort((left, right) => left - right);
    });
  };

  const headerContent = (
    <div className="min-w-0">
      <h2 id="voice-advanced-refresh-title" className="text-base font-semibold">
        {t("sheets.advancedRefresh")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("sheets.advancedRefreshDescription")}</p>
    </div>
  );
  const actionContent = (
    <>
      <VoiceRefreshActionRow
        title={t("sheets.catalog")}
        description={t("sheets.chooseRemoteSources")}
        disabled={catalogDisabled}
        active={catalogActive}
        ariaLabel={t("sheets.catalogRefresh")}
        onRun={(mode) => onRefreshCatalog(mode, selectedSourceIds)}
      />
      <VoiceRefreshActionRow
        title={t("detailActions.metadata")}
        description={t("sheets.metadataRefresh")}
        disabled={metadataDisabled}
        active={metadataActive}
        ariaLabel={t("sheets.metadataRefresh")}
        onRun={onRefreshMetadata}
      />

      {onManageAliases && (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{t("detailActions.aliases")}</div>
            <div className="truncate text-xs text-muted-foreground">{t("sheets.manageAliasesDescription")}</div>
          </div>
          <Button className="h-8 shrink-0" variant="outline" size="sm" onClick={onManageAliases}>
            <ArrowUpRight className="h-4 w-4" />
            {t("sheets.openMetadata")}
          </Button>
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("sheets.sources")}</legend>
        <p className="text-xs text-muted-foreground">{t("sheets.chooseRemoteSources")}</p>
        {loading && sources.length === 0 ? (
          <div className="flex min-h-11 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("sheets.loadingSourceStatus")}
          </div>
        ) : sources.length === 0 ? (
          <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
            {t("sheets.noCompatibleSources")}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("sheets.remoteSourcesToRefresh")}>
            {sources.map((source) => {
              const selectable = isVoiceCatalogSourceSelectable(source);
              const checked = selectedSourceSet.has(source.sourceId);
              return (
                <div
                  key={source.sourceId}
                  className="flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-sm"
                >
                  <Checkbox
                    checked={checked}
                    disabled={!selectable || busy || !canRefresh}
                    aria-label={t("sheets.refreshSource", { name: source.displayName })}
                    onCheckedChange={(nextChecked) => toggleSource(source.sourceId, nextChecked)}
                  />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium">{source.displayName}</span>
                      <Badge variant={source.status === "ok" ? "outline" : "warning"} className="shrink-0">
                        {voiceSourceStatusLabel(source.status, t)}
                      </Badge>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t("sheets.matches", { count: source.total || source.works.length })}
                      {source.error ? ` · ${source.error}` : ""}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </fieldset>
    </>
  );
  const feedbackContent = (
    <>
      {refreshing && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {activeScope === "metadata"
            ? t("sheets.refreshingVoiceMetadata")
            : activeScope === "all"
              ? t("sheets.refreshingVoiceCatalogAndMetadata")
              : t("sheets.refreshingVoiceCatalog")}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
    </>
  );
  const content = (
    <div>
      <div className="flex items-start justify-between gap-3">
        {headerContent}
        {!mobile && (
          <Button variant="ghost" size="icon" aria-label={t("sheets.closeAdvancedRefresh")} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="mt-4 space-y-3">{actionContent}</div>
      {feedbackContent}
    </div>
  );

  if (mobile) {
    return (
      <MobileSheet
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose();
        }}
        ariaLabelledby="voice-advanced-refresh-title"
        className="flex flex-col overflow-hidden p-0"
      >
        <MobileSheetHeader>{headerContent}</MobileSheetHeader>
        <MobileSheetBody>
          <div className="space-y-3">{actionContent}</div>
          {feedbackContent}
        </MobileSheetBody>
      </MobileSheet>
    );
  }

  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      className="w-[min(34rem,calc(100vw-1.5rem))] p-4"
      bottomCollisionPadding={96}
      zIndex={70}
    >
      <div role="dialog" aria-labelledby="voice-advanced-refresh-title" data-android-back-close>
        {content}
      </div>
    </AnchoredPopover>
  );
}

function VoiceRefreshActionRow({
  title,
  description,
  disabled,
  active,
  ariaLabel,
  onRun,
}: {
  title: string;
  description: string;
  disabled?: boolean;
  active?: boolean;
  ariaLabel: string;
  onRun: (mode: VoiceCatalogRefreshMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="mb-1.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{description}</div>
        </div>
        {active && <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />}
      </div>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label={ariaLabel}>
        <Button className="h-8" variant="outline" size="sm" disabled={disabled} onClick={() => onRun("incremental")}>
          {t("sheets.incremental")}
        </Button>
        <Button className="h-8" variant="outline" size="sm" disabled={disabled} onClick={() => onRun("full")}>
          {t("sheets.full")}
        </Button>
      </div>
    </div>
  );
}

export function isVoiceCatalogSourceSelectable(source: VoiceRemoteSourceSet) {
  return !["disabled", "unsupported", "misconfigured"].includes(source.status);
}

function voiceSourceStatusLabel(status: string, t: (key: string) => string) {
  switch (status) {
    case "ok":
      return t("content.available");
    case "disabled":
      return t("sources.disabled");
    case "unsupported":
      return t("sources.unsupported");
    case "misconfigured":
      return t("sources.misconfigured");
    case "refreshing":
      return t("sources.refreshing");
    case "pending":
      return t("sources.pending");
    case "timeout":
      return t("sources.timeout");
    default:
      return status;
  }
}
