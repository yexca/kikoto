import { AlertTriangle, CheckCircle2, Loader2, Plus, Save, Wand2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SettingsDisclosure } from "@/components/settings/SettingsSection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, type FileSource, type FileSourceDetectResult } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import {
  applyDetectResult,
  configuredSourceOrigins,
  LEGACY_NUMBER178_SOURCE_TYPE,
  storagePathPreview,
} from "./remoteSourceModel";

type DetectState =
  | { status: "idle" }
  | { status: "detecting" }
  | { status: "detected"; apiUrl: string }
  | { status: "failed"; tried: string[] }
  | { status: "error" };

/**
 * Adding a source starts from a single address and lets the server look for a
 * compatible API. Every endpoint field stays reachable under collapsed groups,
 * and they open on their own when detection cannot finish the job.
 */
export function RemoteSourceDialog({
  source,
  defaultSaveTemplate,
  editing,
  saving,
  onChange,
  onSave,
  onClose,
}: {
  source: FileSource;
  defaultSaveTemplate: string;
  editing: boolean;
  saving: boolean;
  onChange: (source: FileSource) => void;
  onSave: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [detect, setDetect] = useState<DetectState>({ status: "idle" });
  const [showDetails, setShowDetails] = useState(editing);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const detectAbort = useRef<AbortController | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const apiInput = useRef<HTMLInputElement>(null);
  const patch = (next: Partial<FileSource>) => onChange({ ...source, ...next });
  const patchEndpoint = (next: Partial<FileSource["endpoint"]>) =>
    onChange({ ...source, endpoint: { ...source.endpoint, ...next } });
  const legacyNumber178 = source.sourceType === LEGACY_NUMBER178_SOURCE_TYPE;
  const configuredOrigins = configuredSourceOrigins(source.endpoint);
  const savePreview = storagePathPreview(
    source.config.saveRootTemplate?.trim() || defaultSaveTemplate,
    source.code.trim() || "source",
  );
  const canSave = Boolean(source.displayName.trim() && source.endpoint.apiUrl.trim()) && !saving;

  useEffect(() => () => detectAbort.current?.abort(), []);

  const runDetect = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = address.trim();
    if (!value || detect.status === "detecting") return;
    detectAbort.current?.abort();
    const controller = new AbortController();
    detectAbort.current = controller;
    setDetect({ status: "detecting" });
    try {
      const result: FileSourceDetectResult = await api.detectFileSource(value, controller.signal);
      if (controller.signal.aborted) return;
      onChange(applyDetectResult(source, result));
      setShowDetails(true);
      if (result.detected) {
        setDetect({ status: "detected", apiUrl: result.apiUrl });
        window.requestAnimationFrame(() => nameInput.current?.focus());
      } else {
        setDetect({ status: "failed", tried: result.tried });
        setConnectionOpen(true);
        window.requestAnimationFrame(() => apiInput.current?.focus());
      }
    } catch {
      if (controller.signal.aborted) return;
      setDetect({ status: "error" });
    }
  };

  const enterManually = () => {
    setShowDetails(true);
    setConnectionOpen(true);
    window.requestAnimationFrame(() => nameInput.current?.focus());
  };

  return (
    <Dialog onClose={onClose} size="lg" dismissible={!saving}>
      <DialogHeader
        title={editing ? t("maintenance.library.editRemoteSource") : t("maintenance.library.addRemoteSource")}
        description={editing ? undefined : t("sourceSetup.addDescription")}
        onClose={onClose}
        closeLabel={t("maintenance.close")}
      />
      <DialogBody className="space-y-4">
        {!editing && (
          <form className="space-y-2" onSubmit={(event) => void runDetect(event)}>
            <label className="block text-sm font-medium" htmlFor="remote-source-address">
              {t("sourceSetup.address")}
            </label>
            <div className="flex gap-2">
              <Input
                id="remote-source-address"
                className="min-w-0 flex-1"
                value={address}
                inputMode="url"
                autoComplete="url"
                autoFocus
                spellCheck={false}
                placeholder="https://kikoeru.example.invalid"
                onChange={(event) => {
                  setAddress(event.target.value);
                  if (detect.status !== "detecting") setDetect({ status: "idle" });
                }}
              />
              <Button type="submit" disabled={!address.trim() || detect.status === "detecting"}>
                {detect.status === "detecting" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wand2 className="h-4 w-4" />
                )}
                {detect.status === "detecting" ? t("sourceSetup.detecting") : t("sourceSetup.detect")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("sourceSetup.addressHint")}</p>
            {detect.status === "detected" && (
              <DetectNotice tone="success" title={t("sourceSetup.detectedTitle")}>
                <span className="break-all font-mono">{detect.apiUrl}</span>
              </DetectNotice>
            )}
            {(detect.status === "failed" || detect.status === "error") && (
              <DetectNotice tone="warning" title={t("sourceSetup.notDetectedTitle")}>
                {detect.status === "failed" ? t("sourceSetup.notDetectedDescription") : t("sourceSetup.detectError")}
              </DetectNotice>
            )}
            {!showDetails && (
              <button
                type="button"
                className="text-xs font-medium text-primary hover:underline"
                onClick={enterManually}
              >
                {t("sourceSetup.enterManually")}
              </button>
            )}
          </form>
        )}

        {showDetails && (
          <div className="space-y-4">
            <label className="grid gap-1.5 text-sm" htmlFor="remote-source-name">
              <span className="font-medium">{t("maintenance.library.name")}</span>
              <Input
                id="remote-source-name"
                ref={nameInput}
                value={source.displayName}
                onChange={(event) => patch({ displayName: event.target.value })}
              />
            </label>

            <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t("maintenance.library.enableSource")}</div>
                <div className="text-xs text-muted-foreground">{t("sourceSetup.enableDescription")}</div>
              </div>
              <Switch
                checked={source.enabled}
                onCheckedChange={(enabled) => patch({ enabled })}
                aria-label={t("maintenance.library.enableSource")}
              />
            </div>

            <div className="overflow-hidden rounded-lg border">
              <SettingsDisclosure
                title={t("sourceSetup.connection")}
                description={source.endpoint.apiUrl.trim() || t("sourceSetup.connectionDescription")}
                open={connectionOpen}
                onToggle={setConnectionOpen}
              >
                <div className="grid gap-3 px-4 py-3">
                  {legacyNumber178 && (
                    <label className="grid gap-1 text-sm">
                      <span className="font-medium">{t("maintenance.library.sourceType")}</span>
                      <NativeSelect value={source.sourceType} disabled>
                        <option value={LEGACY_NUMBER178_SOURCE_TYPE}>{LEGACY_NUMBER178_SOURCE_TYPE}</option>
                      </NativeSelect>
                      <span className="text-xs text-muted-foreground">{t("maintenance.library.legacyAdapter")}</span>
                    </label>
                  )}
                  <Field label={t("maintenance.library.apiUrl")} hint={t("sourceSetup.apiUrlHint")}>
                    <Input
                      ref={apiInput}
                      value={source.endpoint.apiUrl}
                      spellCheck={false}
                      placeholder="https://api.kikoeru.example.invalid"
                      onChange={(event) => patchEndpoint({ apiUrl: event.target.value })}
                    />
                  </Field>
                  <Field label={t("maintenance.library.publicSiteUrl")}>
                    <Input
                      value={source.endpoint.baseUrl}
                      spellCheck={false}
                      onChange={(event) => patchEndpoint({ baseUrl: event.target.value })}
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                    <Field label={t("maintenance.library.workUrlTemplate")}>
                      <Input
                        value={source.endpoint.workUrlTemplate}
                        spellCheck={false}
                        onChange={(event) => patchEndpoint({ workUrlTemplate: event.target.value })}
                      />
                    </Field>
                    <Field label={t("maintenance.library.priority")}>
                      <Input
                        type="number"
                        min={1}
                        value={source.priority}
                        onChange={(event) => patch({ priority: Number(event.target.value) })}
                      />
                    </Field>
                  </div>
                  <Field label={t("maintenance.library.fallbackUrl")}>
                    <Input
                      value={source.endpoint.fallbackUrl}
                      spellCheck={false}
                      onChange={(event) => patchEndpoint({ fallbackUrl: event.target.value })}
                    />
                  </Field>
                </div>
              </SettingsDisclosure>
              <div className="border-t">
                <SettingsDisclosure
                  title={t("sourceSetup.networkStorage")}
                  description={t("sourceSetup.networkStorageDescription")}
                >
                  <div className="grid gap-3 px-4 py-3 text-sm">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="font-medium">{t("maintenance.library.restrictOutboundHosts")}</div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("maintenance.library.restrictOutboundDescription")}
                        </p>
                      </div>
                      <Switch
                        checked={source.endpoint.restrictOutboundHosts ?? false}
                        onCheckedChange={(restrictOutboundHosts) => patchEndpoint({ restrictOutboundHosts })}
                        aria-label={t("maintenance.library.restrictOutboundHosts")}
                      />
                    </div>
                    {source.endpoint.restrictOutboundHosts && (
                      <div className="grid gap-3 rounded-md bg-muted/30 p-3">
                        <div>
                          <div className="text-xs font-medium">{t("maintenance.library.allowedConfiguredOrigins")}</div>
                          {configuredOrigins.length > 0 ? (
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {configuredOrigins.map((origin) => (
                                <Badge
                                  key={origin}
                                  variant="outline"
                                  className="max-w-full break-all font-mono text-2xs"
                                >
                                  {origin}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {t("maintenance.library.addValidOrigin")}
                            </p>
                          )}
                        </div>
                        <label className="grid gap-1.5">
                          <span className="text-xs font-medium">{t("maintenance.library.additionalAllowedHosts")}</span>
                          <Textarea
                            className="min-h-24 resize-y font-mono text-xs"
                            value={(source.endpoint.allowedHostPatterns ?? []).join("\n")}
                            onChange={(event) =>
                              patchEndpoint({ allowedHostPatterns: event.target.value.split(/\r?\n/u) })
                            }
                            placeholder={"cdn.example.invalid\n*.media.example.invalid"}
                            aria-label={t("maintenance.library.additionalAllowedHosts")}
                          />
                          <span className="text-xs text-muted-foreground">
                            {t("maintenance.library.additionalAllowedDescription")}
                          </span>
                        </label>
                      </div>
                    )}
                    <label className="grid gap-1 border-t pt-3">
                      <span className="text-xs font-medium">{t("maintenance.library.savePathPreview")}</span>
                      <input
                        className="h-[var(--control-height)] rounded-[var(--control-radius)] border bg-muted px-3 font-mono text-xs text-muted-foreground outline-none"
                        value={savePreview}
                        readOnly
                      />
                      <span className="text-xs text-muted-foreground">
                        {t("maintenance.library.savePathDescription")}
                      </span>
                    </label>
                  </div>
                </SettingsDisclosure>
              </div>
            </div>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
          {t("maintenance.cancel")}
        </Button>
        {(editing || showDetails) && (
          <Button size="sm" disabled={!canSave} onClick={() => void onSave()}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : editing ? (
              <Save className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {editing ? t("maintenance.save") : t("maintenance.library.addSource")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function DetectNotice({ tone, title, children }: { tone: "success" | "warning"; title: string; children: ReactNode }) {
  const Icon = tone === "success" ? CheckCircle2 : AlertTriangle;
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs",
        tone === "success"
          ? "border-success-border bg-success-surface text-success-foreground"
          : "border-warning-border bg-warning-surface text-warning-foreground",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 space-y-0.5">
        <div className="font-semibold">{title}</div>
        <div>{children}</div>
      </div>
    </div>
  );
}
