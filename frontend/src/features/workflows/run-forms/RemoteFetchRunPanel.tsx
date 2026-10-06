import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, NativeSelect } from "@/components/ui/input";
import {
  OptionField,
  RunBlockerNote,
  WorkflowRunButton,
  type RunFormLayout,
} from "@/features/workflows/RunOptionControls";
import { workflowCopy, type RemoteFetchRunOptions } from "@/features/workflows/workflowPageModel";
import { api, type LibrarySource } from "@/lib/api";
import { parseFetchExtensions } from "@/lib/remoteFetchFilters";
import { isWorkCode } from "@/lib/workCode";

const commonExtensions = ["wav", "flac", "mp3", "m4a", "ogg", "mp4", "jpg", "png", "zip", "pdf", "txt", "lrc"];
const compatibleSourceTypes = new Set(["kikoeru_compatible", "kikoeru_compatible_number178"]);

export function RemoteFetchRunPanel({
  layout,
  running,
  allowed,
  onRun,
}: {
  layout: RunFormLayout;
  running: boolean;
  allowed: boolean;
  onRun: (options: RemoteFetchRunOptions) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [sourceId, setSourceId] = useState(0);
  const [code, setCode] = useState("");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [otherExtensions, setOtherExtensions] = useState("");
  const [loadingSources, setLoadingSources] = useState(true);
  const [sourceError, setSourceError] = useState(false);
  const [sourceRevision, setSourceRevision] = useState(0);
  const [preparationError, setPreparationError] = useState(false);
  const workCode = code.trim().toUpperCase();
  const customExtensions = parseFetchExtensions(otherExtensions);
  const invalidExtensions = customExtensions.some((extension) => !/^[a-z0-9]{1,16}$/.test(extension));
  const selectedSource = sources.find((source) => source.id === sourceId);

  useEffect(() => {
    const controller = new AbortController();
    api.listLibrarySources(controller.signal).then(
      (items) => {
        if (controller.signal.aborted) return;
        const compatible = items.filter((source) => source.enabled && compatibleSourceTypes.has(source.sourceType));
        setSources(compatible);
        setSourceId((current) =>
          compatible.some((source) => source.id === current) ? current : (compatible[0]?.id ?? 0),
        );
        setSourceError(false);
        setLoadingSources(false);
      },
      () => {
        if (controller.signal.aborted) return;
        setSourceError(true);
        setLoadingSources(false);
      },
    );
    return () => controller.abort();
  }, [sourceRevision]);

  const blocker = !allowed
    ? t("permissions.permissionDenied")
    : loadingSources
      ? workflowCopy("loadingSources")
      : sourceError
        ? workflowCopy("fetchRun.sourcesFailed")
        : !selectedSource
          ? workflowCopy("noCompatibleSource")
          : !isWorkCode(workCode)
            ? workflowCopy("fetchRun.codeHint")
            : invalidExtensions
              ? workflowCopy("fetchRun.invalidExtensions")
              : preparationError
                ? workflowCopy("fetchRun.prepareFailed")
                : "";
  const canSubmit =
    allowed && !loadingSources && !sourceError && selectedSource && isWorkCode(workCode) && !invalidExtensions;

  return layout({
    run: (
      <WorkflowRunButton
        running={running}
        disabled={!canSubmit}
        onClick={() => {
          if (!canSubmit) return;
          setPreparationError(false);
          void onRun({
            sourceId,
            sourceDisplayName: selectedSource.displayName,
            workCode,
            excludeExtensions: Array.from(new Set([...excluded, ...customExtensions])),
          }).then((opened) => setPreparationError(!opened));
        }}
      />
    ),
    blocker: blocker ? <RunBlockerNote>{blocker}</RunBlockerNote> : undefined,
    options: (
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <section className="grid min-w-0 content-start gap-4" aria-labelledby="fetch-run-input">
          <h4 id="fetch-run-input" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {workflowCopy("presetGroups.input")}
          </h4>
          <OptionField label={workflowCopy("fetchRun.workCode")} htmlFor="fetch-run-code" stacked>
            <Input
              id="fetch-run-code"
              fieldSize="sm"
              value={code}
              placeholder={workflowCopy("fetchRun.codePlaceholder")}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={code.trim() !== "" && !isWorkCode(workCode)}
              disabled={running}
              onChange={(event) => {
                setCode(event.target.value);
                setPreparationError(false);
              }}
            />
          </OptionField>
          <OptionField label={workflowCopy("remoteSource")} htmlFor="fetch-run-source" stacked>
            <NativeSelect
              id="fetch-run-source"
              fieldSize="sm"
              value={sourceId}
              disabled={running || loadingSources || sourceError || sources.length === 0}
              onChange={(event) => {
                setSourceId(Number(event.target.value));
                setPreparationError(false);
              }}
            >
              {sources.length === 0 && (
                <option value={0}>
                  {loadingSources ? workflowCopy("loadingSources") : workflowCopy("noCompatibleSource")}
                </option>
              )}
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.displayName}
                </option>
              ))}
            </NativeSelect>
            {sourceError && (
              <div role="alert" className="flex items-center gap-2 text-xs text-error-foreground">
                {workflowCopy("fetchRun.sourcesFailed")}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running}
                  onClick={() => {
                    setLoadingSources(true);
                    setSourceRevision((revision) => revision + 1);
                  }}
                >
                  {t("common.retry")}
                </Button>
              </div>
            )}
          </OptionField>
        </section>
        <section className="grid min-w-0 content-start gap-4" aria-labelledby="fetch-run-filter">
          <h4 id="fetch-run-filter" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {workflowCopy("presetGroups.filter")}
          </h4>
          <OptionField
            label={workflowCopy("excludeExtensions")}
            hint={workflowCopy("excludeExtensionsDescription")}
            stacked
          >
            <div
              className="flex flex-wrap gap-x-4 gap-y-2"
              role="group"
              aria-label={workflowCopy("extensionsToExclude")}
            >
              {commonExtensions.map((extension) => (
                <label key={extension} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    aria-label={workflowCopy("fetchRun.excludeType", { extension: extension.toUpperCase() })}
                    checked={excluded.includes(extension)}
                    disabled={running}
                    onCheckedChange={(checked) => {
                      setExcluded((current) =>
                        checked ? [...current, extension] : current.filter((item) => item !== extension),
                      );
                      setPreparationError(false);
                    }}
                  />
                  {extension.toUpperCase()}
                </label>
              ))}
            </div>
          </OptionField>
          <OptionField label={workflowCopy("fetchRun.otherExtensions")} htmlFor="fetch-run-other-extensions" stacked>
            <Input
              id="fetch-run-other-extensions"
              fieldSize="sm"
              value={otherExtensions}
              placeholder={workflowCopy("fetchRun.extensionsPlaceholder")}
              aria-invalid={invalidExtensions}
              disabled={running}
              onChange={(event) => {
                setOtherExtensions(event.target.value);
                setPreparationError(false);
              }}
            />
          </OptionField>
          <p className="text-xs leading-5 text-muted-foreground">{workflowCopy("fetchRun.previewHint")}</p>
        </section>
      </div>
    ),
  });
}
