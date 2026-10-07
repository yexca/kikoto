import { ArrowDown, ArrowUp, Loader2, Save } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  defaultRemoteMetadataFallback,
  moveRemoteMetadataSource,
  normalizedRemoteMetadataFallback,
  remoteMetadataFallbackRows,
  sameRemoteMetadataFallback,
  toggleRemoteMetadataSource,
} from "@/features/workflows/remoteMetadataFallbackModel";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { SkeletonLine } from "@/features/workflows/WorkflowPanelParts";
import { api, type FileSource, type RemoteMetadataFallbackSettings } from "@/lib/api";

const fallbackCopy = (key: string, options?: Record<string, unknown>) =>
  workflowCopy(`remoteMetadataFallback.${key}`, options);
const bonusCopy = (key: string) => workflowCopy(`purchaseBonus.${key}`);

/**
 * Metadata sync configuration: the opt-in remote metadata fallback, its switch
 * and the ordered metadata-capable sources, and purchase bonus linking. It
 * reads the instance settings when opened and saves only the values changed
 * here.
 */
export function RemoteMetadataFallbackPopover({
  anchorRef,
  readOnly,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  readOnly: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [sources, setSources] = useState<FileSource[] | null>(null);
  const [saved, setSaved] = useState<RemoteMetadataFallbackSettings>(defaultRemoteMetadataFallback);
  const [value, setValue] = useState<RemoteMetadataFallbackSettings>(defaultRemoteMetadataFallback);
  const [savedBonusAutoLink, setSavedBonusAutoLink] = useState(true);
  const [bonusAutoLink, setBonusAutoLink] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    api
      .getSettings()
      .then((settings) => {
        if (!active) return;
        const current = normalizedRemoteMetadataFallback(
          settings.fileSources,
          settings.remoteMetadataFallback ?? defaultRemoteMetadataFallback,
        );
        setSources(settings.fileSources);
        setSaved(current);
        setValue(current);
        const autoLink = settings.purchaseBonusAutoLink ?? true;
        setSavedBonusAutoLink(autoLink);
        setBonusAutoLink(autoLink);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  const next = sources ? normalizedRemoteMetadataFallback(sources, value) : value;
  const fallbackDirty = sources !== null && !sameRemoteMetadataFallback(next, saved);
  const bonusDirty = sources !== null && bonusAutoLink !== savedBonusAutoLink;
  const dirty = fallbackDirty || bonusDirty;
  const disabled = readOnly || saving;

  const save = async () => {
    if (!dirty || disabled) return;
    setSaving(true);
    try {
      // Only changed values are sent, so this form never overwrites other settings.
      await api.updateSettings({
        ...(fallbackDirty ? { remoteMetadataFallback: next } : {}),
        ...(bonusDirty ? { purchaseBonusAutoLink: bonusAutoLink } : {}),
      });
      toast.success(fallbackDirty ? fallbackCopy("saved") : bonusCopy("saved"));
      onClose();
    } catch (cause) {
      toast.notify(toastFromError(cause, fallbackCopy("saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnchoredPopover
      open
      anchorRef={anchorRef}
      onOpenChange={(open) => !open && onClose()}
      ariaLabel={workflowCopy("configuration")}
      className="w-[min(26rem,calc(100vw-1.5rem))] p-4"
    >
      <div className="grid gap-4">
        <h4 className="text-sm font-semibold">{workflowCopy("configuration")}</h4>
        <section className="grid gap-2" aria-labelledby="remote-metadata-fallback-title">
          <div>
            <h5 id="remote-metadata-fallback-title" className="text-sm font-medium">
              {fallbackCopy("title")}
            </h5>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{fallbackCopy("description")}</p>
          </div>
          {loadFailed ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground"
            >
              {fallbackCopy("loadFailed")}
              <Button size="sm" variant="outline" onClick={() => setRevision((current) => current + 1)}>
                {workflowCopy("retry")}
              </Button>
            </div>
          ) : !sources ? (
            <div role="status" aria-label={fallbackCopy("loading")} aria-busy="true" className="grid gap-2">
              <SkeletonLine className="h-8 w-full" />
              <SkeletonLine className="h-20 w-full" />
            </div>
          ) : (
            <RemoteMetadataFallbackFields sources={sources} value={value} disabled={disabled} onChange={setValue} />
          )}
        </section>
        {sources && (
          <section className="grid gap-2 border-t pt-3" aria-labelledby="purchase-bonus-title">
            <div>
              <h5 id="purchase-bonus-title" className="text-sm font-medium">
                {bonusCopy("title")}
              </h5>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{bonusCopy("description")}</p>
            </div>
            <div className="flex min-h-[var(--control-height-sm)] items-center justify-between gap-3 text-sm">
              <span id="purchase-bonus-auto-link" className="min-w-0">
                {bonusCopy("autoLink")}
              </span>
              <Switch
                checked={bonusAutoLink}
                disabled={disabled}
                aria-labelledby="purchase-bonus-auto-link"
                onCheckedChange={setBonusAutoLink}
              />
            </div>
          </section>
        )}
        <div className="flex justify-end gap-2 border-t pt-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {workflowCopy("cancel")}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={disabled || !dirty}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {workflowCopy("save")}
          </Button>
        </div>
      </div>
    </AnchoredPopover>
  );
}

function RemoteMetadataFallbackFields({
  sources,
  value,
  disabled,
  onChange,
}: {
  sources: FileSource[];
  value: RemoteMetadataFallbackSettings;
  disabled: boolean;
  onChange: (value: RemoteMetadataFallbackSettings) => void;
}) {
  const rows = remoteMetadataFallbackRows(sources, value);
  const lastSelected = rows.filter((row) => row.selected).length - 1;
  return (
    <>
      <div className="flex min-h-[var(--control-height-sm)] items-center justify-between gap-3 text-sm">
        <span id="remote-metadata-fallback-enabled" className="min-w-0">
          {fallbackCopy("enabled")}
        </span>
        <Switch
          checked={value.enabled}
          disabled={disabled}
          aria-labelledby="remote-metadata-fallback-enabled"
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        />
      </div>
      {rows.length === 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">{fallbackCopy("noSources")}</p>
      ) : (
        <ol aria-label={fallbackCopy("order")} className="divide-y overflow-hidden rounded-lg border bg-card">
          {rows.map((row) => {
            const name = row.source.displayName;
            return (
              <li key={row.source.id} className="flex min-h-10 items-center gap-2 px-2.5 py-1 text-sm">
                <Checkbox
                  checked={row.selected}
                  disabled={disabled}
                  aria-label={fallbackCopy("use", { name })}
                  onCheckedChange={(selected) => onChange(toggleRemoteMetadataSource(value, row.source.id, selected))}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                {row.selected && (
                  <span className="flex shrink-0 items-center">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={fallbackCopy("earlier", { name })}
                      title={fallbackCopy("earlier", { name })}
                      disabled={disabled || row.position === 0}
                      onClick={() => onChange(moveRemoteMetadataSource(value, row.source.id, -1))}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={fallbackCopy("later", { name })}
                      title={fallbackCopy("later", { name })}
                      disabled={disabled || row.position === lastSelected}
                      onClick={() => onChange(moveRemoteMetadataSource(value, row.source.id, 1))}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
