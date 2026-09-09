import { AlertCircle, CheckCircle2, Loader2, Play, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { parseWorkflowDefinition, type WorkflowInputDefinition } from "@/features/workflows/definitionModel";
import { workflowRunInputPayload } from "@/features/workflows/workflowCommands";
import { parseWorkCodes, WorkCodesField } from "@/features/workflows/WorkCodesField";
import { api, type WorkflowDefinition, type WorkflowDefinitionRunPreview, type WorkflowPreviewLimit } from "@/lib/api";

export function WorkflowRunDialog({
  definition,
  initialInputs = {},
  autoPreview = false,
  autoConfirmWhenAllowed = false,
  onClose,
  onQueued,
  onBusyChange,
}: {
  definition: WorkflowDefinition;
  initialInputs?: Record<string, unknown>;
  autoPreview?: boolean;
  autoConfirmWhenAllowed?: boolean;
  onClose: () => void;
  onQueued: (runId: number) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const parsed = parseWorkflowDefinition(definition.definitionJson);
  const document = parsed.kind === "v2" ? parsed.document : null;
  const [inputs, setInputs] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      (document?.inputs ?? []).map((input) => [input.key, initialInputs[input.key] ?? input.defaultValue ?? ""]),
    ),
  );
  const [preview, setPreview] = useState<WorkflowDefinitionRunPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const autoStarted = useRef(false);
  const active = useRef(true);
  const requestController = useRef<AbortController | null>(null);
  const onBusyChangeRef = useRef(onBusyChange);

  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  }, [onBusyChange]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const controller = requestController.current;
      queueMicrotask(() => {
        // React Strict Mode immediately re-runs effects without unmounting the dialog.
        if (active.current) return;
        controller?.abort();
        if (requestController.current === controller) requestController.current = null;
        onBusyChangeRef.current?.(false);
      });
    };
  }, []);

  const setRequestBusy = (nextBusy: boolean) => {
    if (active.current) setBusy(nextBusy);
    onBusyChangeRef.current?.(nextBusy);
  };

  const beginRequest = () => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setRequestBusy(true);
    setError("");
    return controller;
  };

  const finishRequest = (controller: AbortController) => {
    if (requestController.current !== controller) return;
    requestController.current = null;
    setRequestBusy(false);
  };

  const confirmPreview = async (nextPreview: WorkflowDefinitionRunPreview, signal: AbortSignal) => {
    const requestInputs = workflowRunInputPayload(document?.inputs ?? [], inputs);
    const result = await api.runWorkflowDefinition(
      definition.id,
      { mode: "confirm", inputs: requestInputs, previewToken: nextPreview.previewToken },
      signal,
    );
    if (result.mode !== "confirm")
      throw new Error(
        t("workflowRun.previewFailed", { defaultValue: "Workflow confirmation returned an unexpected response." }),
      );
    if (!active.current || signal.aborted) return;
    onQueued(result.runId);
  };

  const requestPreview = async (allowAutoConfirm = false) => {
    const controller = beginRequest();
    try {
      const requestInputs = workflowRunInputPayload(document?.inputs ?? [], inputs);
      const result = await api.runWorkflowDefinition(
        definition.id,
        { mode: "preview", inputs: requestInputs },
        controller.signal,
      );
      if (result.mode !== "preview")
        throw new Error(
          t("workflowRun.previewFailed", { defaultValue: "Workflow preview returned an unexpected response." }),
        );
      if (!active.current || controller.signal.aborted) return;
      setPreview(result);
      if (allowAutoConfirm && document && !document.policy.requirePreview)
        await confirmPreview(result, controller.signal);
    } catch (cause) {
      if (active.current && !isAbortError(cause))
        setError(t("workflowRun.previewFailed", { defaultValue: "Workflow preview failed." }));
    } finally {
      finishRequest(controller);
    }
  };

  useEffect(() => {
    if (!autoPreview || autoStarted.current || !document) return;
    autoStarted.current = true;
    void requestPreview(autoConfirmWhenAllowed);
  }, [autoConfirmWhenAllowed, autoPreview, document]);

  if (!document) return null;

  const queue = async () => {
    if (!preview) return;
    const controller = beginRequest();
    try {
      await confirmPreview(preview, controller.signal);
    } catch (cause) {
      if (active.current && !isAbortError(cause))
        setError(t("workflowRun.queueFailed", { defaultValue: "Workflow could not be queued." }));
    } finally {
      finishRequest(controller);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-background/70 p-3 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t("workflowRun.run", { name: definition.displayName })}
    >
      <div className="app-scroll max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-md border bg-card shadow-xl">
        <header className="sticky top-0 z-10 flex min-h-14 items-center gap-3 border-b bg-card px-4">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">
              {preview ? t("workflowRun.previewTitle") : definition.displayName}
            </h2>
            <p className="truncate text-xs text-muted-foreground">{definition.code}</p>
          </div>
          <Button variant="ghost" size="icon" aria-label={t("workflowRun.close")} onClick={onClose} disabled={busy}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="space-y-5 p-4">
          {!preview ? (
            <>
              {document.inputs.length > 0 && (
                <section className="grid gap-3 sm:grid-cols-2">
                  {document.inputs.map((input) => (
                    <RunInput
                      key={input.key}
                      input={input}
                      value={inputs[input.key]}
                      onChange={(value) => setInputs((current) => ({ ...current, [input.key]: value }))}
                    />
                  ))}
                </section>
              )}
              {document.inputs.length === 0 && (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  {t("workflowRun.noLaunchInputs")}
                </div>
              )}
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {t("workflowRun.validationNotice")}
              </div>
            </>
          ) : (
            <PreviewPlan preview={preview} onEdit={() => setPreview(null)} />
          )}

          {busy && autoPreview && !preview && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("workflowRun.computingPreview")}
            </div>
          )}
          {error && (
            <div className="flex gap-2 rounded-md border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              {t("workflowRun.cancel")}
            </Button>
            {!preview ? (
              <Button
                onClick={() => void requestPreview(false)}
                disabled={
                  busy ||
                  hasMissingRequiredInputs(document.inputs, inputs) ||
                  hasInvalidWorkCodeInputs(document.inputs, inputs)
                }
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {t("workflowRun.preview")}
              </Button>
            ) : (
              <Button onClick={() => void queue()} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {t("workflowRun.queueRun")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunInput({
  input,
  value,
  onChange,
}: {
  input: WorkflowInputDefinition;
  value: unknown;
  onChange: (value: string) => void;
}) {
  const fieldClass = "rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring";
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">
        {input.label}
        {input.required && <span className="text-error-foreground"> *</span>}
      </span>
      {input.type === "work_codes" ? (
        <WorkCodesField value={typeof value === "string" ? value : ""} onChange={onChange} />
      ) : (
        <input
          className={`${fieldClass} h-10`}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder={input.type.replace(/_/g, " ")}
          autoCapitalize="off"
          spellCheck={input.type === "text" || input.type === "voice_name"}
        />
      )}
      <span className="font-mono text-[10px] text-muted-foreground">
        {input.key} · {input.type}
      </span>
    </label>
  );
}

function PreviewPlan({ preview, onEdit }: { preview: WorkflowDefinitionRunPreview; onEdit: () => void }) {
  const { t } = useTranslation();
  const estimates = preview.plan.estimates;
  return (
    <>
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("workflowRun.normalizedInputs")}</h3>
          <Button size="sm" variant="outline" onClick={onEdit}>
            {t("workflowRun.editInputs")}
          </Button>
        </div>
        <pre className="max-h-40 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
          {JSON.stringify(preview.normalizedInputs ?? {}, null, 2)}
        </pre>
      </section>
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <PreviewMetric
          label={t("workflowRun.candidates")}
          value={formatEstimate(estimates?.candidateCount, t("workflowRun.unknown"))}
        />
        <PreviewMetric
          label={t("workflowRun.files")}
          value={formatEstimate(estimates?.fileCount, t("workflowRun.unknown"))}
        />
        <PreviewMetric
          label={t("workflowRun.bytes")}
          value={formatBytes(estimates?.totalBytes, t("workflowRun.unknown"))}
        />
        <PreviewMetric label={t("workflowRun.steps")} value={String(preview.plan.nodeCount)} />
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t("workflowRun.actions")}</h3>
          <span className="text-xs text-muted-foreground">
            {t("workflowRun.connections", { count: preview.plan.edgeCount })}
          </span>
        </div>
        <div className="divide-y rounded-md border">
          {preview.plan.actions.map((action, index) => {
            const item = actionRecord(action);
            return (
              <div key={`${item.nodeId}-${index}`} className="flex items-center gap-3 px-3 py-2.5">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded border bg-muted text-[11px] font-medium">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {item.displayName || item.nodeId || item.nodeType}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{item.phase || item.nodeType}</span>
                </span>
                {item.requiresConfirmation && <Badge variant="warning">{t("workflowRun.writes")}</Badge>}
              </div>
            );
          })}
        </div>
      </section>

      {(preview.plan.limits?.length ?? 0) > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("workflowRun.limits")}</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {preview.plan.limits?.map((limit) => (
              <PreviewLimitRow key={limit.key} limit={limit} />
            ))}
          </div>
        </section>
      )}
      {(preview.requiredPermissions?.length ?? 0) > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("workflowRun.permissions")}</h3>
          <div className="flex flex-wrap gap-2">
            {preview.requiredPermissions?.map((permission) => (
              <Badge key={permission} variant="outline">
                {permission}
              </Badge>
            ))}
          </div>
        </section>
      )}
      {(preview.warnings?.length ?? 0) > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t("workflowRun.review")}</h3>
          {preview.warnings?.map((warning) => (
            <div
              key={warning}
              className="flex gap-2 rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-xs text-warning-foreground"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>{warning}</span>
            </div>
          ))}
        </section>
      )}
      <div className="flex items-center gap-2 rounded-md border border-success-border bg-success-surface px-3 py-2 text-xs text-success-foreground">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
        {t("workflowRun.previewBound")}
      </div>
    </>
  );
}

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function PreviewLimitRow({ limit }: { limit: WorkflowPreviewLimit }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate">{limit.label}</span>
      <span className="font-medium">{formatLimitValue(limit)}</span>
      {limit.satisfied === false && <AlertCircle className="h-4 w-4 text-error" />}
    </div>
  );
}

function actionRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { nodeId: "", nodeType: String(value ?? "Action"), displayName: "", phase: "", requiresConfirmation: false };
  const record = value as Record<string, unknown>;
  return {
    nodeId: stringValue(record.nodeId),
    nodeType: stringValue(record.nodeType),
    displayName: stringValue(record.displayName),
    phase: stringValue(record.phase),
    requiresConfirmation: record.requiresConfirmation === true,
  };
}

function hasMissingRequiredInputs(inputs: WorkflowInputDefinition[], values: Record<string, unknown>) {
  return inputs.some((input) => input.required && !String(values[input.key] ?? "").trim());
}

function hasInvalidWorkCodeInputs(inputs: WorkflowInputDefinition[], values: Record<string, unknown>) {
  return inputs.some(
    (input) => input.type === "work_codes" && parseWorkCodes(String(values[input.key] ?? "")).invalid.length > 0,
  );
}

function formatEstimate(value: number | null | undefined, unknownLabel = "Unknown") {
  return typeof value === "number" && value >= 0 ? value.toLocaleString() : unknownLabel;
}

function formatBytes(value: number | null | undefined, unknownLabel = "Unknown") {
  if (typeof value !== "number" || value < 0) return unknownLabel;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function formatLimitValue(limit: WorkflowPreviewLimit) {
  if (typeof limit.value === "number" && limit.unit === "bytes") return formatBytes(limit.value);
  return `${String(limit.value ?? "-")}${limit.unit ? ` ${limit.unit}` : ""}`;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isAbortError(value: unknown) {
  return value instanceof DOMException
    ? value.name === "AbortError"
    : value instanceof Error && value.name === "AbortError";
}
