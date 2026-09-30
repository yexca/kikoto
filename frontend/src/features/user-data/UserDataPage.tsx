import { AlertTriangle, CheckCircle2, Download, FileJson, Loader2, Upload, X } from "lucide-react";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { toastFromError, useToast } from "@/components/ui/toast";
import { formatNumber } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { cn } from "@/lib/tailwindClassNames";
import { announceUserTagsChanged } from "@/lib/userTagEvents";

import { KikoeruAccountPanel, KikoeruDatabasePanel } from "./KikoeruImportPanels";
import { saveUserDataExport } from "./userDataExportFile";
import { userDataApi, type KikoeruImportResponse, type UserDataConflictPolicy } from "./userDataApi";
import {
  canImport,
  classifyUserDataRequestError,
  importRequest,
  initialUserDataImportState,
  isFileImportSource,
  kikoeruStatusMapping,
  parseUserDataFileText,
  shouldRequestPreview,
  userDataConflictPolicies,
  userDataExportFileName,
  userDataImportReducer,
  userDataImportSources,
  type UserDataImportSource,
  type UserDataImportState,
} from "./userDataImportModel";

export function UserDataPage({ canImportData, demoMode }: { canImportData: boolean; demoMode: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="w-full max-w-4xl space-y-6">
      {!demoMode && !canImportData && <p className="text-sm text-muted-foreground">{t("personal.readOnlyAccount")}</p>}
      <ExportSection />
      <ImportSection enabled={canImportData} />
    </div>
  );
}

function ExportSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");

  const download = async () => {
    if (status === "running") return;
    setStatus("running");
    try {
      const data = await userDataApi.exportData();
      const result = await saveUserDataExport(data, userDataExportFileName());
      setStatus("idle");
      // Cancelling the save picker is a choice, not a failure.
      if (result === "saved") toast.success(t("personal.userData.exported"));
    } catch (error) {
      setStatus("error");
      toast.notify(toastFromError(error, t("personal.userData.exportFailed")));
    }
  };

  return (
    <SettingsSection
      title={t("personal.userData.exportTitle")}
      description={t("personal.userData.exportDescription")}
      icon={<Download />}
    >
      <SettingsRow title={t("personal.userData.exportAction")} description={t("personal.userData.exportExcludes")}>
        <Button variant="outline" onClick={() => void download()} disabled={status === "running"}>
          {status === "running" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="h-4 w-4" aria-hidden="true" />
          )}
          {status === "running" ? t("personal.userData.exporting") : t("personal.userData.exportAction")}
        </Button>
      </SettingsRow>
      {status === "error" && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 bg-error-surface px-4 py-2.5 text-sm text-error-foreground"
        >
          <span>{t("personal.userData.exportFailed")}</span>
          <Button size="sm" variant="outline" onClick={() => void download()}>
            {t("common.retry")}
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}

function ImportSection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const ids = useId();
  const [state, dispatch] = useReducer(userDataImportReducer, undefined, initialUserDataImportState);
  const fileRef = useRef<File | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const importing = state.importing.status === "running";
  const locked = !enabled || importing;
  const fileSource = isFileImportSource(state.source);
  const onRemoteLoaded = (response: KikoeruImportResponse) => dispatch({ type: "remoteLoaded", response });

  // Reads the selected file once per revision; a newer selection wins.
  useEffect(() => {
    if (!state.reading || !fileRef.current) return;
    const revision = state.revision;
    let cancelled = false;
    fileRef.current
      .text()
      .then((text) => {
        if (cancelled) return;
        const parsed = parseUserDataFileText(text);
        dispatch(
          parsed.ok
            ? { type: "fileParsed", revision, value: parsed.value }
            : { type: "fileRejected", revision, error: "invalid_json" },
        );
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "fileRejected", revision, error: "unreadable" });
      });
    return () => {
      cancelled = true;
    };
  }, [state.reading, state.revision]);

  useEffect(() => {
    if (enabled && shouldRequestPreview(state)) dispatch({ type: "previewStarted", revision: state.revision });
  }, [enabled, state]);

  const previewRevision = state.preview.status === "loading" ? state.preview.revision : null;
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (previewRevision === null) return;
    const request = importRequest(stateRef.current);
    if (!request) return;
    const controller = new AbortController();
    userDataApi
      .previewImport(request, controller.signal)
      .then((result) => dispatch({ type: "previewSucceeded", revision: previewRevision, result }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({ type: "previewFailed", revision: previewRevision, error: classifyUserDataRequestError(error) });
      });
    return () => controller.abort();
  }, [previewRevision]);

  const runImport = async () => {
    const request = importRequest(state);
    if (!request || !canImport(state) || !enabled) return;
    const revision = state.revision;
    dispatch({ type: "importStarted", revision });
    try {
      const result = await userDataApi.importData(request);
      dispatch({ type: "importSucceeded", revision, result });
      for (const scope of ["work", "circle", "voice"] as const) announceUserTagsChanged(scope);
      toast.success(t("personal.userData.imported", result));
    } catch (error) {
      dispatch({ type: "importFailed", revision, error: classifyUserDataRequestError(error) });
    }
  };

  return (
    <SettingsSection
      title={t("personal.userData.importTitle")}
      description={t("personal.userData.importDescription")}
      icon={<Upload />}
      footer={
        <Button onClick={() => void runImport()} disabled={!enabled || !canImport(state)}>
          {importing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {importing ? t("personal.userData.importing") : t("personal.userData.importAction")}
        </Button>
      }
    >
      <SettingsRow title={t("personal.userData.source")} htmlFor={`${ids}-source`}>
        <NativeSelect
          id={`${ids}-source`}
          className="w-full sm:w-56"
          value={state.source}
          disabled={locked}
          onChange={(event) => dispatch({ type: "sourceChanged", source: event.target.value as UserDataImportSource })}
        >
          {userDataImportSources.map((source) => (
            <option key={source} value={source}>
              {t(`personal.userData.sources.${source}`)}
            </option>
          ))}
        </NativeSelect>
      </SettingsRow>
      {state.source !== "kikoto" && (
        <div className="px-4 py-3 text-xs text-muted-foreground">
          <p>{t(`personal.userData.sourceHints.${state.source}`)}</p>
          <p className="mt-2">{t("personal.userData.kikoeruMapping")}</p>
          <ul className="mt-1.5 grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {kikoeruStatusMapping.map(([source, target]) => (
              <li key={source}>
                <span className="font-mono">{source}</span> → {t(`library.status.${target}`)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.source === "kikoeruAccount" && <KikoeruAccountPanel disabled={locked} onLoaded={onRemoteLoaded} />}
      {state.source === "kikoeruDatabase" && <KikoeruDatabasePanel disabled={locked} onLoaded={onRemoteLoaded} />}
      {state.remote && (
        <RemoteLoadedSummary remote={state.remote} disabled={importing} onClear={() => dispatch({ type: "cleared" })} />
      )}
      {fileSource && (
        <SettingsRow title={t("personal.userData.file")} description={t("personal.userData.fileHint")} stack>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              id={`${ids}-file`}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              aria-label={t("personal.userData.file")}
              disabled={locked}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                fileRef.current = file;
                dispatch({ type: "fileSelected", file: { name: file.name, size: file.size } });
              }}
            />
            <Button variant="outline" disabled={locked} onClick={() => inputRef.current?.click()}>
              <FileJson className="h-4 w-4" aria-hidden="true" />
              {t("personal.userData.chooseFile")}
            </Button>
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {state.file ? state.file.name : t("personal.userData.noFile")}
            </span>
            {state.file && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("personal.userData.clearFile")}
                title={t("personal.userData.clearFile")}
                disabled={importing}
                onClick={() => {
                  fileRef.current = null;
                  dispatch({ type: "cleared" });
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
          {state.reading && <p className="text-xs text-muted-foreground">{t("personal.userData.reading")}</p>}
          {state.fileError && (
            <p role="alert" className="text-xs text-error-foreground">
              {t(`personal.userData.fileErrors.${state.fileError}`)}
            </p>
          )}
        </SettingsRow>
      )}
      <fieldset className="px-4 py-3" disabled={locked}>
        <legend className="float-left mb-2 w-full text-sm font-medium">{t("personal.userData.conflict")}</legend>
        <div className="clear-both grid gap-2 sm:grid-cols-2">
          {userDataConflictPolicies.map((policy) => (
            <label
              key={policy}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors hover:bg-muted/50",
                state.conflict === policy && "border-primary/60 bg-primary/5",
              )}
            >
              <input
                type="radio"
                name={`${ids}-conflict`}
                className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
                checked={state.conflict === policy}
                onChange={() => dispatch({ type: "conflictChanged", conflict: policy as UserDataConflictPolicy })}
              />
              <span className="min-w-0">
                <span className="block font-medium">{t(`personal.userData.conflicts.${policy}`)}</span>
                <span className="block text-xs text-muted-foreground">
                  {t(`personal.userData.conflictHints.${policy}`)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <ImportPreviewPanel
        state={state}
        onRetry={() => dispatch({ type: "previewStarted", revision: state.revision })}
      />
    </SettingsSection>
  );
}

function RemoteLoadedSummary({
  remote,
  disabled,
  onClear,
}: {
  remote: NonNullable<UserDataImportState["remote"]>;
  disabled: boolean;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const counts = Object.fromEntries(
    Object.entries(remote.summary).map(([key, value]) => [key, formatNumber(value, resolvedLocale)]),
  );
  return (
    <div role="status" className="flex items-start gap-2 px-4 py-3 text-sm">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p>{t("personal.userData.kikoeru.loaded", counts)}</p>
        {(remote.summary.skippedWorks > 0 || remote.summary.skippedPlaylistItems > 0) && (
          <p className="text-xs text-muted-foreground">{t("personal.userData.kikoeru.skipped", counts)}</p>
        )}
        {!remote.playlistsSupported && (
          <p className="text-xs text-muted-foreground">{t("personal.userData.kikoeru.playlistsUnsupported")}</p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("personal.userData.kikoeru.clearLoaded")}
        title={t("personal.userData.kikoeru.clearLoaded")}
        disabled={disabled}
        onClick={onClear}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

function ImportPreviewPanel({ state, onRetry }: { state: UserDataImportState; onRetry: () => void }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const number = (value: number) => formatNumber(value, resolvedLocale);

  if (state.result) {
    return (
      <div
        role="status"
        className="flex items-start gap-2 bg-success-surface px-4 py-3 text-sm text-success-foreground"
      >
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t("personal.userData.imported", state.result)}</span>
      </div>
    );
  }
  if (state.importing.status === "error") {
    return (
      <div role="alert" className="flex items-start gap-2 bg-error-surface px-4 py-3 text-sm text-error-foreground">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-medium">{t("personal.userData.importFailed")}</span>
          {" · "}
          {t(`personal.userData.requestErrors.${state.importing.error}`)}
        </span>
      </div>
    );
  }
  const preview = state.preview;
  if (preview.status === "idle") {
    return state.data ? null : (
      <p className="px-4 py-3 text-xs text-muted-foreground">{t("personal.userData.previewStale")}</p>
    );
  }
  if (preview.status === "loading") {
    return (
      <div role="status" className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {t("personal.userData.previewing")}
      </div>
    );
  }
  if (preview.status === "error") {
    return (
      <div
        role="alert"
        className="flex items-center justify-between gap-3 bg-error-surface px-4 py-3 text-sm text-error-foreground"
      >
        <span>
          <span className="font-medium">{t("personal.userData.previewFailed")}</span>
          {" · "}
          {t(`personal.userData.requestErrors.${preview.error}`)}
        </span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  const result = preview.result;
  const counts = [
    ["works", result.works],
    ["matchedWorks", result.matchedWorks],
    ["playlists", result.playlists],
    ["tags", result.tags],
    ["conflicts", result.conflicts],
    ["unmatchedProgress", result.unmatchedProgress],
  ] as const;
  return (
    <section aria-label={t("personal.userData.preview")} className="space-y-3 px-4 py-3">
      <h3 className="text-sm font-medium">{t("personal.userData.preview")}</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {counts.map(([key, value]) => (
          <div key={key} className="min-w-0">
            <dt className="text-xs text-muted-foreground">{t(`personal.userData.previewCounts.${key}`)}</dt>
            <dd className="text-base font-semibold tabular-nums">{number(value)}</dd>
          </div>
        ))}
      </dl>
      {result.missingCodes.length > 0 && (
        <details className="rounded-lg border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground">
          <summary className="cursor-pointer font-medium">
            {t("personal.userData.missingCodes", { count: result.missingCodes.length })}
          </summary>
          <p className="mt-1 text-xs">{t("personal.userData.missingCodesHint")}</p>
          <ul className="app-scrollbar mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto font-mono text-xs">
            {result.missingCodes.map((code) => (
              <li key={code} className="rounded border border-warning-border px-1.5 py-0.5">
                {code}
              </li>
            ))}
          </ul>
        </details>
      )}
      {result.unmatchedProgress > 0 && (
        <p className="text-xs text-muted-foreground">{t("personal.userData.unmatchedProgressHint")}</p>
      )}
    </section>
  );
}
