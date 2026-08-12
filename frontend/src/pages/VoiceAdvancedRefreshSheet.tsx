import { Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import type { VoiceCatalogRefreshState, VoiceRemoteSourceSet } from "@/lib/api";

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
  aliasesPanel,
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
  aliasesPanel?: ReactNode;
  onClose: () => void;
  onRefreshCatalog: (mode: VoiceCatalogRefreshMode, sourceIds: number[]) => void;
  onRefreshMetadata: (mode: VoiceCatalogRefreshMode) => void;
}) {
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

  const content = (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="voice-advanced-refresh-title" className="text-base font-semibold">
            Advanced refresh
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Run a targeted catalog, metadata, or source workflow.</p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close advanced refresh actions" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-4 space-y-3">
        <VoiceRefreshActionRow
          title="Catalog"
          description="Refresh the selected remote-source catalog."
          disabled={catalogDisabled}
          active={catalogActive}
          ariaLabel="Catalog refresh"
          onRun={(mode) => onRefreshCatalog(mode, selectedSourceIds)}
        />
        <VoiceRefreshActionRow
          title="Metadata"
          description="Refresh metadata for known catalog works."
          disabled={metadataDisabled}
          active={metadataActive}
          ariaLabel="Metadata refresh"
          onRun={onRefreshMetadata}
        />

        {mobile && aliasesPanel && (
          <details className="rounded-md border bg-background px-3 py-2">
            <summary className="min-h-8 cursor-pointer py-1 text-sm font-medium">Aliases</summary>
            <div className="mt-2 border-t pt-3">{aliasesPanel}</div>
          </details>
        )}

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Sources</legend>
          <p className="text-xs text-muted-foreground">Choose the remote sources used by Catalog refresh.</p>
          {loading && sources.length === 0 ? (
            <div className="flex min-h-11 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading source status
            </div>
          ) : sources.length === 0 ? (
            <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
              No Kikoeru-compatible sources are configured.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Remote sources to refresh">
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
                      aria-label={`Refresh ${source.displayName}`}
                      onCheckedChange={(nextChecked) => toggleSource(source.sourceId, nextChecked)}
                    />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">{source.displayName}</span>
                        <Badge variant={source.status === "ok" ? "outline" : "warning"} className="shrink-0">
                          {source.status}
                        </Badge>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {source.total || source.works.length} matches
                        {source.error ? ` · ${source.error}` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </fieldset>
      </div>

      {refreshing && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {activeScope === "metadata"
            ? "Refreshing voice metadata"
            : activeScope === "all"
              ? "Refreshing voice catalog and metadata"
              : "Refreshing voice catalog"}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
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
        className="p-4"
      >
        {content}
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
          Incremental
        </Button>
        <Button className="h-8" variant="outline" size="sm" disabled={disabled} onClick={() => onRun("full")}>
          Full
        </Button>
      </div>
    </div>
  );
}

export function isVoiceCatalogSourceSelectable(source: VoiceRemoteSourceSet) {
  return !["disabled", "unsupported", "misconfigured"].includes(source.status);
}
