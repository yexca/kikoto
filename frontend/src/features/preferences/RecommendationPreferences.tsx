import { Save, RotateCcw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/SettingsSection";
import type { RecommendationConfig } from "@/lib/api";
import i18n from "@/i18n";
import {
  RecommendationDimensionRow,
  RecommendationLaneMix,
  RecommendationOrderingBand,
  RecommendationPreviewPanel,
  RecommendationScoreRange,
  RecommendationSliderField,
} from "./RecommendationTuningControls";
import {
  defaultRecommendationExample,
  recommendationExampleBreakdown,
  type RecommendationExample,
} from "./recommendationTuningModel";
const maintenanceCopy = (key: string, options?: Record<string, unknown>) => i18n.t(`maintenance.${key}`, options);

type RecommendationConfigKey = keyof RecommendationConfig;

type RecommendationDimension = {
  title: string;
  weightKey: RecommendationConfigKey;
  capKey: RecommendationConfigKey;
  weightLabel: string;
  capLabel: string;
  tone: string;
};

const positiveDimensions: RecommendationDimension[] = [
  {
    title: "libraryDetail.componentTags",
    weightKey: "tagWeight",
    capKey: "tagCap",
    weightLabel: "recommendation.positiveTagWeight",
    capLabel: "recommendation.positiveTagCap",
    tone: "bg-primary",
  },
  {
    title: "libraryDetail.componentVoices",
    weightKey: "voiceWeight",
    capKey: "voiceCap",
    weightLabel: "recommendation.positiveVoiceWeight",
    capLabel: "recommendation.positiveVoiceCap",
    tone: "bg-primary/70",
  },
  {
    title: "libraryDetail.componentCircles",
    weightKey: "circleWeight",
    capKey: "circleCap",
    weightLabel: "recommendation.positiveCircleWeight",
    capLabel: "recommendation.positiveCircleCap",
    tone: "bg-primary/45",
  },
];

const shelvedTone = "bg-foreground/10 text-foreground/50";

const shelvedDimensions: RecommendationDimension[] = [
  {
    title: "libraryDetail.componentTags",
    weightKey: "negativeTagWeight",
    capKey: "negativeTagCap",
    weightLabel: "recommendation.shelvedTagWeight",
    capLabel: "recommendation.shelvedTagCap",
    tone: shelvedTone,
  },
  {
    title: "libraryDetail.componentVoices",
    weightKey: "negativeVoiceWeight",
    capKey: "negativeVoiceCap",
    weightLabel: "recommendation.shelvedVoiceWeight",
    capLabel: "recommendation.shelvedVoiceCap",
    tone: shelvedTone,
  },
  {
    title: "libraryDetail.componentCircles",
    weightKey: "negativeCircleWeight",
    capKey: "negativeCircleCap",
    weightLabel: "recommendation.shelvedCircleWeight",
    capLabel: "recommendation.shelvedCircleCap",
    tone: shelvedTone,
  },
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
  const [example, setExample] = useState<RecommendationExample>(defaultRecommendationExample);
  const updateField = (key: RecommendationConfigKey, value: number) => {
    onConfigChange({ ...config, [key]: value });
  };
  const activePreset = defaults
    ? (recommendationPresetOptions.find((preset) =>
        recommendationConfigsEqual(config, recommendationPresetConfig(defaults, preset.key)),
      )?.key ?? "custom")
    : "custom";
  const exampleScore = recommendationExampleBreakdown(config, example).score;
  const positiveScale = Math.max(50, ...positiveDimensions.map((dimension) => config[dimension.capKey]));
  const shelvedScale = Math.max(20, ...shelvedDimensions.map((dimension) => config[dimension.capKey]));
  const dimensionRows = (dimensions: RecommendationDimension[], scaleMax: number, deduction: boolean) =>
    dimensions.map((dimension) => (
      <RecommendationDimensionRow
        key={dimension.weightKey}
        title={i18n.t(dimension.title)}
        weightKey={dimension.weightKey}
        capKey={dimension.capKey}
        weightLabel={maintenanceCopy(dimension.weightLabel)}
        capLabel={maintenanceCopy(dimension.capLabel)}
        config={config}
        defaults={defaults}
        scaleMax={scaleMax}
        maxWeight={50}
        maxCap={100}
        tone={dimension.tone}
        deduction={deduction}
        onChange={updateField}
      />
    ));

  return (
    <SettingsSection
      title={maintenanceCopy("recommendation.tuning")}
      action={
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
      }
      footer={
        <Button size="sm" onClick={() => void onSave()}>
          <Save className="h-4 w-4" />
          {maintenanceCopy("recommendation.save")}
        </Button>
      }
    >
      <div className="space-y-6 p-4">
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

        <RecommendationPreviewPanel
          config={config}
          threshold={threshold}
          example={example}
          onThresholdChange={onThresholdChange}
          onExampleChange={setExample}
        />

        <section className="rounded-md border bg-background p-4">
          <h3 className="mb-4 text-sm font-semibold">{maintenanceCopy("recommendation.ordering")}</h3>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
            <div className="space-y-4">
              <RecommendationSliderField
                label={maintenanceCopy("recommendation.resultVariation")}
                value={config.jitterAmplitude}
                min={0}
                max={10}
                defaultValue={defaults?.jitterAmplitude}
                onChange={(value) => updateField("jitterAmplitude", value)}
              />
              <RecommendationSliderField
                label={maintenanceCopy("recommendation.discoveryBoost")}
                value={config.explorationAmplitude}
                min={0}
                max={40}
                defaultValue={defaults?.explorationAmplitude}
                onChange={(value) => updateField("explorationAmplitude", value)}
              />
            </div>
            <RecommendationOrderingBand config={config} score={exampleScore} />
          </div>
        </section>

        <details className="rounded-md border bg-background">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
            {maintenanceCopy("recommendation.advancedScoring")}
          </summary>
          <div className="space-y-6 border-t p-4">
            <RecommendationGroup title={maintenanceCopy("recommendation.mixSlots")}>
              <RecommendationLaneMix config={config} onChange={updateField} />
            </RecommendationGroup>

            <RecommendationGroup title={maintenanceCopy("recommendation.positiveAffinity")}>
              <RecommendationScoreRange config={config} threshold={threshold} />
              <div className="grid gap-4 sm:grid-cols-2">
                <RecommendationSliderField
                  label={maintenanceCopy("recommendation.affinityBaseline")}
                  value={config.affinityBase}
                  min={0}
                  max={100}
                  defaultValue={defaults?.affinityBase}
                  onChange={(value) => updateField("affinityBase", value)}
                />
                <RecommendationSliderField
                  label={maintenanceCopy("recommendation.favoriteBonus")}
                  value={config.favoriteBonus}
                  min={0}
                  max={50}
                  defaultValue={defaults?.favoriteBonus}
                  onChange={(value) => updateField("favoriteBonus", value)}
                />
              </div>
              {dimensionRows(positiveDimensions, positiveScale, false)}
            </RecommendationGroup>

            <RecommendationGroup title={maintenanceCopy("recommendation.shelvedPenalty")}>
              <div className="grid gap-4 sm:grid-cols-2">
                <RecommendationSliderField
                  label={maintenanceCopy("recommendation.shelvedEvidenceWorks")}
                  value={config.negativeMinEvidence}
                  min={1}
                  max={10}
                  defaultValue={defaults?.negativeMinEvidence}
                  onChange={(value) => updateField("negativeMinEvidence", value)}
                />
                <RecommendationSliderField
                  label={maintenanceCopy("recommendation.shelvedTotalCap")}
                  value={config.negativeTotalCap}
                  min={0}
                  max={100}
                  defaultValue={defaults?.negativeTotalCap}
                  onChange={(value) => updateField("negativeTotalCap", value)}
                />
              </div>
              {dimensionRows(shelvedDimensions, shelvedScale, true)}
            </RecommendationGroup>
          </div>
        </details>
      </div>
    </SettingsSection>
  );
}

function RecommendationGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
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
