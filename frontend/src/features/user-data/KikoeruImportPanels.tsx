import { AlertTriangle, Database, Loader2, LogIn, ShieldAlert, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { cn } from "@/lib/tailwindClassNames";

import { userDataApi, type KikoeruAuth, type KikoeruImportOptions, type KikoeruImportResponse } from "./userDataApi";
import { classifyKikoeruDatabaseError, classifyKikoeruReadError, type KikoeruReadError } from "./userDataImportModel";

export const KIKOERU_DATABASE_MAX_BYTES = 512 * 1024 * 1024;

type AuthMode = KikoeruAuth["mode"];
/** Each sign-in mode and the key of its label and hint. */
const authModes: readonly (readonly [AuthMode, string])[] = [
  ["none", "none"],
  ["token", "bearer"],
  ["password", "signIn"],
];
const manualServer = "manual";

type PanelProps = { disabled: boolean; onLoaded: (response: KikoeruImportResponse) => void };

/**
 * Reads the signed-in user's reviews and playlists from a Kikoeru server. A
 * token, a password, or a manually entered address is only accepted after the
 * user confirms the risk notice; secrets are cleared once a read finishes.
 */
export function KikoeruAccountPanel({ disabled, onLoaded }: PanelProps) {
  const { t } = useTranslation();
  const ids = useId();
  const [options, setOptions] = useState<KikoeruImportOptions | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [server, setServer] = useState<string>("");
  const [url, setURL] = useState("");
  const [mode, setMode] = useState<AuthMode>("none");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pendingRisk, setPendingRisk] = useState<(() => void) | null>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "running" } | { kind: "error"; error: KikoeruReadError }>({
    kind: "idle",
  });
  const running = status.kind === "running";
  const locked = disabled || running;

  useEffect(() => {
    const controller = new AbortController();
    userDataApi
      .kikoeruOptions(controller.signal)
      .then((next) => {
        setOptions(next);
        setServer((current) => current || (next.sources[0] ? String(next.sources[0].id) : manualServer));
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setOptionsFailed(true);
          setServer(manualServer);
        }
      });
    return () => controller.abort();
  }, []);

  /** Runs a change that needs consent now, or after the user confirms the notice. */
  const withConsent = (change: () => void) => {
    if (acknowledged) change();
    else setPendingRisk(() => change);
  };

  const manual = server === manualServer;
  const auth: KikoeruAuth =
    mode === "token" ? { mode, token } : mode === "password" ? { mode, name, password } : { mode: "none" };
  const complete =
    Boolean(server) &&
    (!manual || url.trim() !== "") &&
    (mode !== "token" || token.trim() !== "") &&
    (mode !== "password" || (name.trim() !== "" && password !== ""));

  const needsConsent = manual || mode !== "none";
  const read = async (consented: boolean) => {
    if (!complete || locked) return;
    setStatus({ kind: "running" });
    try {
      const response = await userDataApi.readKikoeruAccount({
        ...(manual ? { url: url.trim() } : { sourceId: Number(server) }),
        auth,
        acknowledgedRisk: consented,
        playlistNames: {
          liked: t("personal.userData.kikoeru.playlistNames.liked"),
          marked: t("personal.userData.kikoeru.playlistNames.marked"),
        },
      });
      setToken("");
      setPassword("");
      setStatus({ kind: "idle" });
      onLoaded(response);
    } catch (error) {
      setPassword("");
      setStatus({ kind: "error", error: classifyKikoeruReadError(error) });
    }
  };

  return (
    <>
      <SettingsRow title={t("personal.userData.kikoeru.server")} htmlFor={`${ids}-server`}>
        <NativeSelect
          id={`${ids}-server`}
          className="w-full sm:w-64"
          value={server}
          disabled={locked || (!options && !optionsFailed)}
          onChange={(event) => {
            const next = event.target.value;
            if (next === manualServer) withConsent(() => setServer(next));
            else setServer(next);
          }}
        >
          {!options && !optionsFailed && <option value="">{t("personal.userData.kikoeru.loadingOptions")}</option>}
          {options?.sources.map((source) => (
            <option key={source.id} value={String(source.id)}>
              {source.displayName}
            </option>
          ))}
          <option value={manualServer}>{t("personal.userData.kikoeru.manual")}</option>
        </NativeSelect>
      </SettingsRow>
      {manual && (
        <SettingsRow
          title={t("personal.userData.kikoeru.url")}
          description={t("personal.userData.kikoeru.urlHint")}
          htmlFor={`${ids}-url`}
          stack
        >
          <div className="w-full min-w-0 space-y-1.5">
            <Input
              id={`${ids}-url`}
              className="w-full"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://api.example.com"
              value={url}
              disabled={locked}
              onChange={(event) => setURL(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {options?.privateAddressesAllowed
                ? t("personal.userData.kikoeru.privateAllowed")
                : t("personal.userData.kikoeru.privateBlocked")}
            </p>
          </div>
        </SettingsRow>
      )}
      <fieldset className="px-4 py-3" disabled={locked}>
        <legend className="float-left mb-2 w-full text-sm font-medium">{t("personal.userData.kikoeru.auth")}</legend>
        <div className="clear-both grid gap-2 sm:grid-cols-3">
          {authModes.map(([option, labelKey]) => (
            <label
              key={option}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-muted/50",
                mode === option && "border-primary/60 bg-primary/5",
              )}
            >
              <input
                type="radio"
                name={`${ids}-auth`}
                className="h-4 w-4 accent-[hsl(var(--primary))]"
                checked={mode === option}
                onChange={() => (option === "none" ? setMode(option) : withConsent(() => setMode(option)))}
              />
              {t(`personal.userData.kikoeru.authModes.${labelKey}`)}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t(`personal.userData.kikoeru.authHints.${authModes.find(([option]) => option === mode)?.[1] ?? "none"}`)}
        </p>
        {mode === "token" && (
          <div className="mt-3 space-y-1.5">
            <label htmlFor={`${ids}-token`} className="block text-sm font-medium">
              {t("personal.userData.kikoeru.fields.bearer")}
            </label>
            <Input
              id={`${ids}-token`}
              className="w-full"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
        )}
        {mode === "password" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-name`} className="block text-sm font-medium">
                {t("personal.userData.kikoeru.fields.user")}
              </label>
              <Input
                id={`${ids}-name`}
                className="w-full"
                autoComplete="off"
                spellCheck={false}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-password`} className="block text-sm font-medium">
                {t("personal.userData.kikoeru.fields.passphrase")}
              </label>
              <Input
                id={`${ids}-password`}
                className="w-full"
                type="password"
                autoComplete="off"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </div>
        )}
      </fieldset>
      <ReadRow
        busy={running}
        disabled={locked || !complete}
        icon={<LogIn className="h-4 w-4" aria-hidden="true" />}
        label={running ? t("personal.userData.kikoeru.reading") : t("personal.userData.kikoeru.read")}
        error={status.kind === "error" ? status.error : null}
        // With no configured source the address field starts selected, so the
        // notice may still be unconfirmed when the user first reads.
        onRead={() => (needsConsent ? withConsent(() => void read(true)) : void read(acknowledged))}
      />
      {pendingRisk && (
        <KikoeruRiskDialog
          kind="account"
          onCancel={() => setPendingRisk(null)}
          onConfirm={() => {
            setAcknowledged(true);
            pendingRisk();
            setPendingRisk(null);
          }}
        />
      )}
    </>
  );
}

/** Uploads an open-source Kikoeru SQLite database and reads one account from it. */
export function KikoeruDatabasePanel({ disabled, onLoaded }: PanelProps) {
  const { t } = useTranslation();
  const ids = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [userName, setUserName] = useState("admin");
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<
    { kind: "idle" | "running" } | { kind: "error"; error: KikoeruReadError | "file_too_large" }
  >({ kind: "idle" });
  const running = status.kind === "running";
  const locked = disabled || running;

  const choose = () => {
    if (acknowledged) inputRef.current?.click();
    else setConfirming(true);
  };

  const read = async () => {
    if (!file || !userName.trim() || locked) return;
    setStatus({ kind: "running" });
    try {
      const response = await userDataApi.readKikoeruDatabase(file, userName.trim());
      setStatus({ kind: "idle" });
      onLoaded(response);
    } catch (error) {
      setStatus({ kind: "error", error: classifyKikoeruDatabaseError(error) });
    }
  };

  const errorText =
    status.kind === "error"
      ? status.error === "file_too_large"
        ? t("personal.userData.kikoeru.databaseTooLarge")
        : t(`personal.userData.kikoeru.readErrors.${status.error}`)
      : null;

  return (
    <>
      <SettingsRow
        title={t("personal.userData.kikoeru.databaseUser")}
        description={t("personal.userData.kikoeru.databaseUserHint")}
        htmlFor={`${ids}-user`}
      >
        <Input
          id={`${ids}-user`}
          className="w-full sm:w-56"
          autoComplete="off"
          spellCheck={false}
          value={userName}
          disabled={locked}
          onChange={(event) => setUserName(event.target.value)}
        />
      </SettingsRow>
      <SettingsRow
        title={t("personal.userData.kikoeru.databaseFile")}
        description={t("personal.userData.kikoeru.databaseFileHint")}
        stack
      >
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".sqlite,.sqlite3,.db,application/vnd.sqlite3,application/x-sqlite3"
            className="sr-only"
            aria-label={t("personal.userData.kikoeru.databaseFile")}
            disabled={locked}
            onChange={(event) => {
              const next = event.target.files?.[0];
              event.target.value = "";
              if (!next) return;
              if (next.size > KIKOERU_DATABASE_MAX_BYTES) {
                setFile(null);
                setStatus({ kind: "error", error: "file_too_large" });
                return;
              }
              setFile(next);
              setStatus({ kind: "idle" });
            }}
          />
          <Button variant="outline" disabled={locked} onClick={choose}>
            <Database className="h-4 w-4" aria-hidden="true" />
            {t("personal.userData.kikoeru.chooseDatabase")}
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {file ? file.name : t("personal.userData.noFile")}
          </span>
          {file && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("personal.userData.clearFile")}
              title={t("personal.userData.clearFile")}
              disabled={running}
              onClick={() => setFile(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </SettingsRow>
      <ReadRow
        busy={running}
        disabled={locked || !file || !userName.trim()}
        icon={<Database className="h-4 w-4" aria-hidden="true" />}
        label={running ? t("personal.userData.kikoeru.uploading") : t("personal.userData.kikoeru.readDatabase")}
        errorText={errorText}
        onRead={() => void read()}
      />
      {confirming && (
        <KikoeruRiskDialog
          kind="database"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setAcknowledged(true);
            setConfirming(false);
            // The confirm click is the user gesture that opens the file picker.
            inputRef.current?.click();
          }}
        />
      )}
    </>
  );
}

function ReadRow({
  busy,
  disabled,
  icon,
  label,
  error,
  errorText,
  onRead,
}: {
  busy: boolean;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  error?: KikoeruReadError | null;
  errorText?: string | null;
  onRead: () => void;
}) {
  const { t } = useTranslation();
  const message = errorText ?? (error ? t(`personal.userData.kikoeru.readErrors.${error}`) : null);
  return (
    <div className="space-y-2 px-4 py-3">
      <Button variant="outline" disabled={disabled} onClick={onRead}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : icon}
        {label}
      </Button>
      {message && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-error-foreground">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {message}
        </p>
      )}
    </div>
  );
}

const riskPoints = {
  account: ["credentials", "serverSeesKikoto", "longLived", "manualAddress", "readOnly"],
  database: ["allAccounts", "temporary", "administrator", "openSourceOnly"],
} as const;

/** The notice a user must confirm before credentials, a manual address, or a database leave the browser. */
export function KikoeruRiskDialog({
  kind,
  onCancel,
  onConfirm,
}: {
  kind: "account" | "database";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [understood, setUnderstood] = useState(false);
  const checkboxId = useId();
  return (
    <Dialog onClose={onCancel} layer="sheet" size="lg" role="alertdialog">
      <DialogHeader
        icon={<ShieldAlert />}
        title={t(`personal.userData.kikoeru.risk.${kind}Title`)}
        description={t("personal.userData.kikoeru.risk.description")}
        onClose={onCancel}
      />
      <DialogBody>
        <ul className="list-disc space-y-2 pl-5 text-sm">
          {riskPoints[kind].map((point) => (
            <li key={point}>{t(`personal.userData.kikoeru.risk.${kind}Points.${point}`)}</li>
          ))}
        </ul>
        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-surface px-3 py-2.5 text-sm text-warning-foreground">
          <Checkbox id={checkboxId} checked={understood} onCheckedChange={setUnderstood} className="mt-0.5" />
          <label htmlFor={checkboxId} className="cursor-pointer">
            {t("personal.userData.kikoeru.risk.acknowledge")}
          </label>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button disabled={!understood} onClick={onConfirm}>
          {t("personal.userData.kikoeru.risk.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
