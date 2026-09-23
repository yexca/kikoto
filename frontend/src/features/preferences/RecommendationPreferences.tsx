import { Save, RotateCcw, Sparkles } from "lucide-react";
import { type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { RecommendationConfig } from "@/lib/api";
import i18n from "@/i18n";
const maintenanceCopy = (key: string, options?: Record<string, unknown>) => i18n.t(`maintenance.${key}`, options);

type RecommendationConfigKey = keyof RecommendationConfig;

const recommendationLaneFields: Array<{ key: RecommendationConfigKey; label: string; min: number }> = [
  { key: "unmarkedSlots", label: "recommendation.unmarked", min: 1 },
  { key: "listeningSlots", label: "recommendation.listening", min: 0 },
  { key: "wantSlots", label: "recommendation.want", min: 0 },
  { key: "relistenSlots", label: "recommendation.relisten", min: 0 },
  { key: "finishedSlots", label: "recommendation.finished", min: 0 },
  { key: "shelvedSlots", label: "recommendation.shelved", min: 0 },
];

const recommendationPositiveFields: Array<{ key: RecommendationConfigKey; label: string; max: number }> = [
  { key: "tagWeight", label: "recommendation.positiveTagWeight", max: 50 },
  { key: "tagCap", label: "recommendation.positiveTagCap", max: 100 },
  { key: "voiceWeight", label: "recommendation.positiveVoiceWeight", max: 50 },
  { key: "voiceCap", label: "recommendation.positiveVoiceCap", max: 100 },
  { key: "circleWeight", label: "recommendation.positiveCircleWeight", max: 50 },
  { key: "circleCap", label: "recommendation.positiveCircleCap", max: 100 },
  { key: "favoriteBonus", label: "recommendation.favoriteBonus", max: 50 },
];

const recommendationNegativeFields: Array<{ key: RecommendationConfigKey; label: string; min?: number; max: number }> =
  [
    { key: "negativeMinEvidence", label: "recommendation.shelvedEvidenceWorks", min: 1, max: 10 },
    { key: "negativeTagWeight", label: "recommendation.shelvedTagWeight", max: 50 },
    { key: "negativeTagCap", label: "recommendation.shelvedTagCap", max: 100 },
    { key: "negativeVoiceWeight", label: "recommendation.shelvedVoiceWeight", max: 50 },
    { key: "negativeVoiceCap", label: "recommendation.shelvedVoiceCap", max: 100 },
    { key: "negativeCircleWeight", label: "recommendation.shelvedCircleWeight", max: 50 },
    { key: "negativeCircleCap", label: "recommendation.shelvedCircleCap", max: 100 },
    { key: "negativeTotalCap", label: "recommendation.shelvedTotalCap", max: 100 },
  ];

type RecommendationPreset = "balanced" | "familiar" | "exploratory" | "avoid_shelved";

const recommendationPresetOptions: Array<{ key: RecommendationPreset; label: string; description: string }> = [
  { key: "balanced", label: "recommendation.balanced", description: "recommendation.balancedDescription" },
  { key: "familiar", label: "recommendation.familiar", description: "recommendation.familiarDescription" },
  { key: "exploratory", label: "recommendation.exploratory", description: "recommendation.exploratoryDescription" },
  { key: "avoid_shelved", label: "recommendation.avoidShelved", description: "recommendation.avoidShelvedDescription" },
];

export function RecommendationPreferences({
  config,
  defaults,
  threshold,
  onConfigChange,
  onThresholdChange,
  onSave,
}: {
  config: RecommendationConfig;
  defaults: RecommendationConfig | null;
  threshold: number;
  onConfigChange: (value: RecommendationConfig) => void;
  onThresholdChange: (value: number) => void;
  onSave: () => Promise<void>;
}) {
  const updateField = (key: RecommendationConfigKey, value: number) => {
    onConfigChange({ ...config, [key]: value });
  };
  const activePreset = defaults
    ? (recommendationPresetOptions.find((preset) =>
        recommendationConfigsEqual(config, recommendationPresetConfig(defaults, preset.key)),
      )?.key ?? "custom")
    : "custom";
  const exampleScore = Math.max(
    0,
    Math.min(
      100,
      config.affinityBase +
        Math.min(config.tagCap, config.tagWeight) +
        Math.min(config.voiceCap, config.voiceWeight) +
        Math.min(config.circleCap, config.circleWeight),
    ),
  );

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
                <Sparkles className="h-4 w-4" />
              </span>
              {maintenanceCopy("recommendation.tuning")}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!defaults}
              onClick={() => {
                if (!defaults) return;
                onConfigChange({ ...defaults });
                onThresholdChange(50);
              }}
            >
              <RotateCcw className="h-4 w-4" />
              {maintenanceCopy("recommendation.restoreDefaults")}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">{maintenanceCopy("recommendation.profile")}</h3>
              {activePreset === "custom" && <Badge variant="outline">{maintenanceCopy("recommendation.custom")}</Badge>}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {recommendationPresetOptions.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={`min-h-16 rounded-md border px-3 py-2 text-left transition-colors ${activePreset === preset.key ? "border-primary bg-primary/8" : "bg-background hover:bg-muted/40"}`}
                  aria-pressed={activePreset === preset.key}
                  disabled={!defaults}
                  onClick={() => defaults && onConfigChange(recommendationPresetConfig(defaults, preset.key))}
                >
                  <span className="block text-sm font-semibold">{maintenanceCopy(preset.label)}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {maintenanceCopy(preset.description)}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_220px]">
            <RecommendationRangeField
              label={maintenanceCopy("recommendation.badgeThreshold")}
              value={threshold}
              min={1}
              max={100}
              onChange={onThresholdChange}
            />
            <RecommendationRangeField
              label={maintenanceCopy("recommendation.resultVariation")}
              value={config.jitterAmplitude}
              min={0}
              max={10}
              onChange={(value) => updateField("jitterAmplitude", value)}
            />
            <RecommendationRangeField
              label={maintenanceCopy("recommendation.discoveryBoost")}
              value={config.explorationAmplitude}
              min={0}
              max={40}
              onChange={(value) => updateField("explorationAmplitude", value)}
            />
            <div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
              <div>
                <div className="text-xs text-muted-foreground">{maintenanceCopy("recommendation.exampleScore")}</div>
                <div className="text-2xl font-semibold tabular-nums">{exampleScore}</div>
              </div>
              <Badge variant={exampleScore >= threshold ? "secondary" : "outline"}>
                {exampleScore >= threshold
                  ? maintenanceCopy("recommendation.badgeShown")
                  : maintenanceCopy("recommendation.belowThreshold")}
              </Badge>
            </div>
          </div>

          <details className="rounded-md border bg-background">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
              {maintenanceCopy("recommendation.advancedScoring")}
            </summary>
            <div className="space-y-5 border-t p-4">
              <RecommendationFieldGroup title={maintenanceCopy("recommendation.mixSlots")}>
                {recommendationLaneFields.map((field) => (
                  <RecommendationNumberField
                    key={field.key}
                    label={maintenanceCopy(field.label)}
                    value={config[field.key]}
                    defaultValue={defaults?.[field.key]}
                    min={field.min}
                    max={100}
                    onChange={(value) => updateField(field.key, value)}
                  />
                ))}
                <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">
                  Listening and Want receive the leading slots, Unmarked remains the discovery pool, and zero-slot
                  states wait until scheduled states are exhausted. Explicit status filters still show every matching
                  work.
                </p>
              </RecommendationFieldGroup>

              <RecommendationFieldGroup title={maintenanceCopy("recommendation.positiveAffinity")}>
                <RecommendationNumberField
                  label={maintenanceCopy("recommendation.affinityBaseline")}
                  value={config.affinityBase}
                  defaultValue={defaults?.affinityBase}
                  min={0}
                  max={100}
                  onChange={(value) => updateField("affinityBase", value)}
                />
                {recommendationPositiveFields.map((field) => (
                  <RecommendationNumberField
                    key={field.key}
                    label={maintenanceCopy(field.label)}
                    value={config[field.key]}
                    defaultValue={defaults?.[field.key]}
                    min={0}
                    max={field.max}
                    onChange={(value) => updateField(field.key, value)}
                  />
                ))}
              </RecommendationFieldGroup>

              <RecommendationFieldGroup title={maintenanceCopy("recommendation.shelvedPenalty")}>
                {recommendationNegativeFields.map((field) => (
                  <RecommendationNumberField
                    key={field.key}
                    label={maintenanceCopy(field.label)}
                    value={config[field.key]}
                    defaultValue={defaults?.[field.key]}
                    min={field.min ?? 0}
                    max={field.max}
                    onChange={(value) => updateField(field.key, value)}
                  />
                ))}
              </RecommendationFieldGroup>
            </div>
          </details>

          <div className="flex justify-end">
            <Button size="sm" onClick={() => void onSave()}>
              <Save className="h-4 w-4" />
              {maintenanceCopy("recommendation.save")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RecommendationFieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </section>
  );
}

function RecommendationNumberField({
  label,
  value,
  defaultValue,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  defaultValue?: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="flex items-center justify-between gap-2 font-medium">
        <span>{label}</span>
        {defaultValue !== undefined && value !== defaultValue && (
          <span className="text-3xs font-normal text-muted-foreground">
            {maintenanceCopy("recommendation.defaultValue", { value: defaultValue })}
          </span>
        )}
      </span>
      <Input
        className="min-w-0 tabular-nums"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function RecommendationRangeField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-2 rounded-md border bg-background px-3 py-2 text-sm">
      <span className="flex items-center justify-between gap-3 font-medium">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function recommendationPresetConfig(
  defaults: RecommendationConfig,
  preset: RecommendationPreset,
): RecommendationConfig {
  switch (preset) {
    case "familiar":
      return {
        ...defaults,
        tagWeight: 7,
        tagCap: 35,
        voiceWeight: 13,
        voiceCap: 30,
        circleWeight: 20,
        circleCap: 25,
        jitterAmplitude: 1,
        explorationAmplitude: 4,
      };
    case "exploratory":
      return {
        ...defaults,
        unmarkedSlots: 16,
        listeningSlots: 3,
        wantSlots: 3,
        relistenSlots: 1,
        finishedSlots: 1,
        tagWeight: 3,
        tagCap: 15,
        voiceWeight: 6,
        voiceCap: 15,
        circleWeight: 8,
        circleCap: 10,
        jitterAmplitude: 8,
        explorationAmplitude: 30,
      };
    case "avoid_shelved":
      return {
        ...defaults,
        shelvedSlots: 0,
        negativeTagWeight: 4,
        negativeTagCap: 10,
        negativeVoiceWeight: 5,
        negativeVoiceCap: 10,
        negativeCircleWeight: 8,
        negativeCircleCap: 10,
        negativeTotalCap: 25,
      };
    default:
      return { ...defaults };
  }
}

function recommendationConfigsEqual(left: RecommendationConfig, right: RecommendationConfig) {
  return (Object.keys(left) as RecommendationConfigKey[]).every((key) => left[key] === right[key]);
}
