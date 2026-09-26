import { useEffect, useMemo, useState } from "react";

import { NativeSelect } from "@/components/ui/input";
import { TagTemplateField } from "@/features/workflows/run-forms/TagTemplateField";
import {
  OptionField,
  RunOptionRows,
  SegmentedControl,
  SwitchControl,
  WorkflowRunButton,
  type RunFormLayout,
} from "@/features/workflows/RunOptionControls";
import {
  REMOTE_POPULAR_TAG_TEMPLATE,
  dlsitePopularDefaultTagTemplate,
  dlsitePopularTagTemplateTokens,
  remotePopularTagTemplateTokens,
  workflowTagTemplateBlockers,
  workflowTagTemplatePreview,
  workflowTagTemplateTokenValues,
} from "@/features/workflows/tagTemplateModel";
import {
  workflowCopy,
  type CurrentTriggerRunOptions,
  type DLsitePopularPeriod,
  type DLsitePopularRunOptions,
  type RemotePopularRunOptions,
} from "@/features/workflows/workflowPageModel";
import { workflowSystemTriggerConfig } from "@/features/workflows/workflowTriggerModel";
import { api, type LibrarySource } from "@/lib/api";

export function RemotePopularRunPanel({
  layout,
  running,
  allowed,
  canFetch,
  onRun,
  onTriggerRunOptionsChange,
}: {
  layout: RunFormLayout;
  running: boolean;
  allowed: boolean;
  canFetch: boolean;
  onRun: (options: RemotePopularRunOptions) => Promise<void>;
  onTriggerRunOptionsChange?: (options: CurrentTriggerRunOptions) => void;
}) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [sourceId, setSourceId] = useState(0);
  const [action, setAction] = useState<"track" | "fetch">("track");
  const [limit, setLimit] = useState(25);
  const [tagEnabled, setTagEnabled] = useState(true);
  const [tagNameTemplate, setTagNameTemplate] = useState(REMOTE_POPULAR_TAG_TEMPLATE);
  const [loadingSources, setLoadingSources] = useState(true);
  const compatibleSources = useMemo(
    () =>
      sources.filter(
        (source) =>
          source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
      ),
    [sources],
  );
  const selectedSource = compatibleSources.find((source) => source.id === sourceId) ?? null;
  const tagTokens = remotePopularTagTemplateTokens(selectedSource, action, new Date());
  const tagPreview = workflowTagTemplatePreview(tagNameTemplate, workflowTagTemplateTokenValues(tagTokens));
  const tagError = workflowTagTemplateBlockers(
    tagNameTemplate,
    tagTokens.map((token) => token.name),
  )[0];

  useEffect(() => {
    let active = true;
    api
      .listLibrarySources()
      .then((items) => {
        if (!active) return;
        setSources(items);
        const first = items.find(
          (source) =>
            source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
        );
        setSourceId((current) => current || first?.id || 0);
      })
      .catch(() => {
        if (active) setSources([]);
      })
      .finally(() => {
        if (active) setLoadingSources(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const tagReady = !tagEnabled || (!tagError && tagPreview.value.length > 0);
  const canSubmit = allowed && sourceId > 0 && tagReady && (action !== "fetch" || canFetch);
  useEffect(() => {
    onTriggerRunOptionsChange?.({
      code: "remote_popular_collection",
      systemConfig: {
        ...workflowSystemTriggerConfig("remote_popular_collection", null),
        sourceId,
        action,
        limit,
        tagNameTemplate,
        skipTag: !tagEnabled,
      },
    });
  }, [sourceId, action, limit, tagNameTemplate, tagEnabled, onTriggerRunOptionsChange]);
  return layout({
    run: (
      <WorkflowRunButton
        running={running}
        disabled={!canSubmit}
        onClick={() =>
          void onRun({
            sourceId,
            action,
            limit,
            tagNameTemplate: tagEnabled ? tagNameTemplate.trim() : "",
            skipTag: !tagEnabled,
          })
        }
      />
    ),
    options: (
      <RunOptionRows>
        <OptionField label={workflowCopy("remoteSource")} htmlFor="remote-popular-source">
          <NativeSelect
            id="remote-popular-source"
            fieldSize="sm"
            className="max-w-sm"
            value={sourceId}
            disabled={loadingSources || compatibleSources.length === 0}
            onChange={(event) => setSourceId(Number(event.target.value))}
          >
            {compatibleSources.length === 0 && (
              <option value={0}>
                {loadingSources ? workflowCopy("loadingSources") : workflowCopy("noCompatibleSource")}
              </option>
            )}
            {compatibleSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.displayName}
              </option>
            ))}
          </NativeSelect>
        </OptionField>
        <OptionField
          label={workflowCopy("action")}
          hint={action === "fetch" && !canFetch ? workflowCopy("fetchPermissionRequired") : undefined}
        >
          <SegmentedControl
            label={workflowCopy("remotePopularAction")}
            value={action}
            onChange={setAction}
            options={[
              { value: "track", label: workflowCopy("track") },
              { value: "fetch", label: workflowCopy("fetch") },
            ]}
          />
        </OptionField>
        <OptionField label={workflowCopy("workLimit")}>
          <SegmentedControl
            label={workflowCopy("workLimit")}
            value={String(limit)}
            onChange={(next) => setLimit(Number(next))}
            options={["10", "25", "50", "100"].map((item) => ({ value: item, label: item }))}
          />
        </OptionField>
        <TagTemplateField
          id="remote-popular-tag-template"
          row
          enabled={tagEnabled}
          onEnabledChange={setTagEnabled}
          value={tagNameTemplate}
          defaultValue={REMOTE_POPULAR_TAG_TEMPLATE}
          tokens={tagTokens}
          preview={tagPreview}
          error={tagError}
          onChange={setTagNameTemplate}
        />
      </RunOptionRows>
    ),
  });
}

export function DLsitePopularRunPanel({
  layout,
  running,
  allowed,
  onRun,
  onTriggerRunOptionsChange,
}: {
  layout: RunFormLayout;
  running: boolean;
  allowed: boolean;
  onRun: (options: DLsitePopularRunOptions) => Promise<void>;
  onTriggerRunOptionsChange?: (options: CurrentTriggerRunOptions) => void;
}) {
  const [period, setPeriod] = useState<DLsitePopularPeriod>("day");
  const [recentOnly, setRecentOnly] = useState(true);
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const releaseWindow: "30d" | "" = period === "year" ? "" : recentOnly ? "30d" : "";
  const defaultTagTemplate = dlsitePopularDefaultTagTemplate(period);
  const [tagEnabled, setTagEnabled] = useState(true);
  const [tagNameTemplate, setTagNameTemplate] = useState(defaultTagTemplate);
  const [tagCustomized, setTagCustomized] = useState(false);
  const tagTokens = dlsitePopularTagTemplateTokens(period, releaseWindow, year, new Date());
  const tagPreview = workflowTagTemplatePreview(tagNameTemplate, workflowTagTemplateTokenValues(tagTokens));
  const tagError = workflowTagTemplateBlockers(
    tagNameTemplate,
    tagTokens.map((token) => token.name),
  )[0];
  const years = Array.from({ length: currentYear - 1999 }, (_, index) => currentYear - index);
  const periodOptions: { value: DLsitePopularPeriod; label: string }[] = [
    { value: "day", label: workflowCopy("period24Hours") },
    { value: "week", label: workflowCopy("period7Days") },
    { value: "month", label: workflowCopy("period30Days") },
    { value: "year", label: workflowCopy("periodAnnual") },
  ];

  useEffect(() => {
    if (!tagCustomized) setTagNameTemplate(defaultTagTemplate);
  }, [defaultTagTemplate, tagCustomized]);

  const tagReady = !tagEnabled || (!tagError && Boolean(tagPreview.value));
  useEffect(() => {
    onTriggerRunOptionsChange?.({
      code: "dlsite_popular_collection",
      systemConfig: {
        ...workflowSystemTriggerConfig("dlsite_popular_collection", null),
        period,
        releaseWindow,
        year: period === "year" ? year : 0,
        tagNameTemplate,
        skipTag: !tagEnabled,
      },
    });
  }, [period, releaseWindow, year, tagNameTemplate, tagEnabled, onTriggerRunOptionsChange]);
  return layout({
    run: (
      <WorkflowRunButton
        running={running}
        disabled={!allowed || !tagReady}
        onClick={() =>
          void onRun({
            period,
            releaseWindow,
            year: period === "year" ? year : 0,
            tagNameTemplate: tagEnabled ? tagNameTemplate.trim() : "",
            skipTag: !tagEnabled,
          })
        }
      />
    ),
    options: (
      <RunOptionRows>
        <OptionField label={workflowCopy("rankingPeriod")}>
          <SegmentedControl
            label={workflowCopy("rankingPeriod")}
            value={period}
            onChange={setPeriod}
            options={periodOptions}
          />
        </OptionField>
        {period === "year" ? (
          <OptionField label={workflowCopy("rankingYear")} htmlFor="dlsite-popular-year">
            <NativeSelect
              id="dlsite-popular-year"
              fieldSize="sm"
              className="max-w-48"
              value={year}
              onChange={(event) => setYear(Number(event.target.value))}
            >
              {years.map((item) => (
                <option key={item} value={item}>
                  {item}
                  {item === currentYear ? ` (${workflowCopy("current")})` : ""}
                </option>
              ))}
            </NativeSelect>
          </OptionField>
        ) : (
          <OptionField label={workflowCopy("recentReleasesOnly")}>
            <SwitchControl
              label={workflowCopy("onlyWorksReleased30Days")}
              description={workflowCopy("recentReleasesDescription")}
              checked={recentOnly}
              onCheckedChange={setRecentOnly}
            />
          </OptionField>
        )}
        <TagTemplateField
          id="dlsite-popular-tag-template"
          row
          enabled={tagEnabled}
          onEnabledChange={setTagEnabled}
          value={tagNameTemplate}
          defaultValue={defaultTagTemplate}
          tokens={tagTokens}
          preview={tagPreview}
          error={tagError}
          onChange={(next) => {
            setTagCustomized(next !== defaultTagTemplate);
            setTagNameTemplate(next);
          }}
        />
      </RunOptionRows>
    ),
  });
}
