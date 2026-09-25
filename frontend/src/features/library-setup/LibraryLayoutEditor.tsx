import { HardDrive, Layers, Loader2, PlugZap, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FloatingSelect } from "@/components/ui/floating-select";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type LibraryLayout, type LibraryMode } from "@/lib/api";

type Draft = { mode: LibraryMode; pools: string[]; fetchPool: string };

function draftFromLayout(layout: LibraryLayout): Draft {
  return {
    mode: layout.mode === "pools" ? "pools" : "standard",
    pools: layout.mode === "pools" ? layout.pools.map((pool) => pool.path) : [],
    fetchPool: layout.fetchPool,
  };
}

/**
 * Library mode, storage pools, and the Fetch pool. Shared by Settings and
 * onboarding; the mode locks once the library holds local works.
 */
export function LibraryLayoutEditor({
  layout,
  readOnly,
  saveLabel,
  onSaved,
}: {
  layout: LibraryLayout;
  readOnly: boolean;
  saveLabel?: string;
  onSaved: (layout: LibraryLayout) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftFromLayout(layout));
  const [saving, setSaving] = useState(false);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const saved = useMemo(() => draftFromLayout(layout), [layout]);

  const registered = layout.mode === "pools" ? layout.pools : [];
  const folders = useMemo(
    () => [...new Set([...registered.map((pool) => pool.path), ...layout.candidates])].sort(),
    [layout.candidates, registered],
  );
  const dirty =
    !layout.configured ||
    draft.mode !== saved.mode ||
    draft.fetchPool !== saved.fetchPool ||
    draft.pools.join("\n") !== saved.pools.join("\n");
  const poolsInvalid = draft.mode === "pools" && draft.pools.length === 0;

  const setMode = (mode: LibraryMode) => setDraft((current) => ({ ...current, mode }));
  const togglePool = (path: string, checked: boolean) =>
    setDraft((current) => {
      const pools = checked ? [...current.pools, path].sort() : current.pools.filter((item) => item !== path);
      return { ...current, pools, fetchPool: pools.includes(current.fetchPool) ? current.fetchPool : "" };
    });

  const save = async () => {
    setSaving(true);
    try {
      const next = await api.updateLibraryLayout(
        draft.mode === "pools"
          ? { mode: "pools", pools: draft.pools, fetchPool: draft.fetchPool }
          : { mode: "standard" },
      );
      setDraft(draftFromLayout(next));
      onSaved(next);
      toast.success(t("librarySetup.saved"));
    } catch (error) {
      toast.notify(toastFromError(error, t("librarySetup.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const reconnect = async (path: string) => {
    setReconnecting(path);
    try {
      const next = await api.reconnectLibraryPool(path);
      onSaved(next);
      toast.success(t("librarySetup.reconnected"));
    } catch (error) {
      toast.notify(toastFromError(error, t("librarySetup.reconnectFailed")));
    } finally {
      setReconnecting(null);
    }
  };

  const statusBadge = (path: string) => {
    const pool = layout.pools.find((item) => item.path === path);
    if (!pool || !layout.configured) return null;
    return pool.online ? (
      <Badge variant="success">{t("librarySetup.online")}</Badge>
    ) : (
      <Badge variant="warning">{t("librarySetup.offline")}</Badge>
    );
  };

  const reconnectButton = (path: string) => {
    const pool = layout.pools.find((item) => item.path === path);
    if (!pool?.canReconnect) return null;
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={readOnly || reconnecting !== null}
        onClick={() => void reconnect(path)}
      >
        {reconnecting === path ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
        {t("librarySetup.reconnect")}
      </Button>
    );
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div role="radiogroup" aria-label={t("librarySetup.mode")} className={segmentedListClassName()}>
          {(["standard", "pools"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={draft.mode === mode}
              disabled={readOnly || (layout.locked && layout.mode !== mode)}
              className={segmentedItemClassName(draft.mode === mode)}
              onClick={() => setMode(mode)}
            >
              {mode === "standard" ? <HardDrive className="h-4 w-4" /> : <Layers className="h-4 w-4" />}
              {t(`librarySetup.modes.${mode}.name`)}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{t(`librarySetup.modes.${draft.mode}.description`)}</p>
        {layout.locked && <p className="text-xs text-muted-foreground">{t("librarySetup.locked")}</p>}
      </div>

      {draft.mode === "standard" && layout.mode === "standard" && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
          <span className="text-sm font-medium">{t("librarySetup.dataFolder")}</span>
          {statusBadge("")}
          {reconnectButton("")}
          {layout.pools[0] && !layout.pools[0].online && (
            <p className="basis-full text-xs text-muted-foreground">{t("librarySetup.offlineHelp")}</p>
          )}
        </div>
      )}

      {draft.mode === "pools" && (
        <div className="space-y-3">
          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm font-medium">{t("librarySetup.pools")}</legend>
            {folders.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("librarySetup.noFolders")}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {folders.map((path) => {
                  const checked = draft.pools.includes(path);
                  const id = `library-pool-${path}`;
                  return (
                    <li key={path} className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
                      <Checkbox
                        id={id}
                        checked={checked}
                        disabled={readOnly}
                        aria-label={t("librarySetup.usePool", { pool: path })}
                        onCheckedChange={(next) => togglePool(path, next)}
                      />
                      <label htmlFor={id} className="min-w-0 flex-1 truncate font-mono text-sm">
                        /data/{path}
                      </label>
                      {statusBadge(path)}
                      {reconnectButton(path)}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{t("librarySetup.poolsHelp")}</p>
          </fieldset>
          <div className="space-y-1">
            <span className="text-sm font-medium">{t("librarySetup.fetchPool")}</span>
            <FloatingSelect
              ariaLabel={t("librarySetup.fetchPool")}
              disabled={readOnly || draft.pools.length === 0}
              value={draft.fetchPool}
              options={[
                { value: "", label: t("librarySetup.fetchPoolNone") },
                ...draft.pools.map((path) => ({ value: path, label: `/data/${path}` })),
              ]}
              onValueChange={(fetchPool) => setDraft((current) => ({ ...current, fetchPool }))}
            />
            <p className="text-xs text-muted-foreground">{t("librarySetup.fetchPoolHelp")}</p>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button size="sm" disabled={readOnly || saving || !dirty || poolsInvalid} onClick={() => void save()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saveLabel ?? t("librarySetup.save")}
        </Button>
      </div>
    </div>
  );
}
