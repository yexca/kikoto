import { Globe, Laptop, Loader2, Save } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import type { OutboundProxy, ProxyScheme } from "@/lib/api";

import { DEFAULT_PROXY_PORTS, PROXY_SCHEMES, proxyDraftValid, type ProxyDraft } from "./proxyModel";

const schemeLabels: Record<ProxyScheme, string> = {
  http: "HTTP",
  https: "HTTPS",
  socks5: "SOCKS5",
  socks5h: "SOCKS5h",
};

/**
 * Adds or edits one proxy. A local-machine proxy shows the runtime address
 * the server reaches its host at and does not let it be edited; any other
 * proxy takes an address.
 */
export function ProxyDialog({
  proxy,
  hostAddress,
  editing,
  saving,
  readOnly,
  onSave,
  onClose,
}: {
  proxy: ProxyDraft;
  hostAddress: string;
  editing: boolean;
  saving: boolean;
  readOnly: boolean;
  onSave: (proxy: ProxyDraft) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ProxyDraft>(proxy);
  const [showErrors, setShowErrors] = useState(false);
  const hostAddressHintId = useId();
  const patch = (next: Partial<ProxyDraft>) => setDraft((current) => ({ ...current, ...next }));
  const valid = proxyDraftValid(draft);

  const setScheme = (scheme: ProxyScheme) =>
    // Follow the protocol's usual port until the administrator enters one.
    patch({
      scheme,
      port: draft.port === DEFAULT_PROXY_PORTS[draft.scheme] ? DEFAULT_PROXY_PORTS[scheme] : draft.port,
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || saving) return;
    if (!valid) {
      setShowErrors(true);
      return;
    }
    void onSave(draft);
  };

  const kinds: Array<{ kind: OutboundProxy["kind"]; icon: ReactNode }> = [
    { kind: "host", icon: <Laptop className="h-4 w-4" /> },
    { kind: "custom", icon: <Globe className="h-4 w-4" /> },
  ];

  return (
    <Dialog onClose={onClose} size="md" dismissible={!saving}>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit} noValidate>
        <DialogHeader
          title={editing ? t("maintenance.proxy.dialog.editTitle") : t("maintenance.proxy.dialog.addTitle")}
          onClose={onClose}
          closeLabel={t("maintenance.close")}
        />
        <DialogBody className="space-y-4">
          <fieldset disabled={readOnly || saving} className="min-w-0 space-y-4 border-0 p-0">
            <div className="space-y-2">
              <div
                role="radiogroup"
                aria-label={t("maintenance.proxy.dialog.location")}
                className={segmentedListClassName()}
              >
                {kinds.map(({ kind, icon }) => (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={draft.kind === kind}
                    className={segmentedItemClassName(draft.kind === kind)}
                    onClick={() => patch({ kind })}
                  >
                    {icon}
                    {kind === "host" ? t("maintenance.proxy.localMachine") : t("maintenance.proxy.otherAddress")}
                  </button>
                ))}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {draft.kind === "host"
                  ? t("maintenance.proxy.dialog.localMachineDescription")
                  : t("maintenance.proxy.dialog.otherAddressDescription")}
              </p>
            </div>

            <Field label={t("maintenance.proxy.dialog.name")}>
              <Input
                value={draft.name}
                maxLength={64}
                autoComplete="off"
                placeholder={t("maintenance.proxy.dialog.optional")}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </Field>

            {draft.kind === "host" ? (
              <div className="grid min-w-0 gap-1.5">
                <Field label={t("maintenance.proxy.dialog.address")}>
                  <Input
                    value={hostAddress}
                    readOnly
                    aria-describedby={hostAddressHintId}
                    className="bg-muted/40 font-mono"
                  />
                </Field>
                <p id={hostAddressHintId} className="text-xs leading-5 text-muted-foreground">
                  {t("maintenance.proxy.dialog.hostAddressHint")}
                </p>
              </div>
            ) : (
              <Field label={t("maintenance.proxy.dialog.address")}>
                <Input
                  value={draft.host}
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  placeholder="192.0.2.10"
                  aria-invalid={showErrors && !/^[^\s/@?#]+$/.test(draft.host.trim())}
                  onChange={(event) => patch({ host: event.target.value })}
                />
              </Field>
            )}

            <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
              <Field label={t("maintenance.proxy.dialog.protocol")}>
                <NativeSelect value={draft.scheme} onChange={(event) => setScheme(event.target.value as ProxyScheme)}>
                  {PROXY_SCHEMES.map((scheme) => (
                    <option key={scheme} value={scheme}>
                      {schemeLabels[scheme]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label={t("maintenance.proxy.dialog.port")}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={65535}
                  className="text-right tabular-nums"
                  value={Number.isFinite(draft.port) ? draft.port : ""}
                  aria-invalid={showErrors && !(Number.isInteger(draft.port) && draft.port >= 1 && draft.port <= 65535)}
                  onChange={(event) =>
                    patch({ port: event.target.value === "" ? Number.NaN : Number(event.target.value) })
                  }
                />
              </Field>
            </div>

            <div className="space-y-3 border-t pt-4">
              <div>
                <h3 className="text-sm font-medium">{t("maintenance.proxy.dialog.authentication")}</h3>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {t("maintenance.proxy.dialog.authenticationDescription")}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("maintenance.proxy.dialog.username")}>
                  <Input
                    value={draft.username}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={255}
                    onChange={(event) => patch({ username: event.target.value })}
                  />
                </Field>
                <Field label={t("maintenance.proxy.dialog.password")}>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    maxLength={255}
                    value={draft.password ?? ""}
                    placeholder={draft.hasPassword ? t("maintenance.proxy.dialog.passwordSaved") : undefined}
                    aria-invalid={showErrors && Boolean(draft.password) && !draft.username.trim()}
                    onChange={(event) => patch({ password: event.target.value || undefined })}
                  />
                </Field>
              </div>
            </div>

            {showErrors && !valid && (
              <p role="alert" className="text-xs text-error-foreground">
                {t("maintenance.proxy.dialog.invalid")}
              </p>
            )}
          </fieldset>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onClose}>
            {t("maintenance.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={readOnly || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t("maintenance.proxy.dialog.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
