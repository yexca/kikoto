import { Minus, Plus } from "lucide-react";
import type { CSSProperties } from "react";

import {
  clampRecommendationPercent,
  RecommendationComposition,
  recommendationDeductionStyle,
  RecommendationScoreGauge,
  signedRecommendationValue,
} from "@/components/recommendation/RecommendationScoreVisuals";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import i18n from "@/i18n";
import type { RecommendationConfig } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import {
  recommendationExampleBreakdown,
  type RecommendationExample,
  recommendationMatchesToCap,
  recommendationOrderingRange,
  recommendationScoreRange,
} from "./recommendationTuningModel";

const copy = (key: string, options?: Record<string, unknown>) => i18n.t(`maintenance.recommendation.${key}`, options);

type ConfigKey = keyof RecommendationConfig;

export function RecommendationSliderField({
  label,
  ariaLabel,
  value,
  min,
  max,
  defaultValue,
  onChange,
}: {
  label: string;
  ariaLabel?: string;
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  onChange: (value: number) => void;
}) {
  const changed = defaultValue !== undefined && value !== defaultValue;
  return (
    <label className="grid min-w-0 gap-1.5 text-sm">
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-medium">{label}</span>
        <span className="flex shrink-0 items-baseline gap-2">
          {changed && (
            <span className="text-3xs text-muted-foreground">{copy("defaultValue", { value: defaultValue })}</span>
          )}
          <span className="font-semibold tabular-nums">{value}</span>
        </span>
      </span>
      <input
        type="range"
        className="h-5 w-full cursor-pointer accent-primary"
        aria-label={ariaLabel}
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  decreaseLabel,
  increaseLabel,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  decreaseLabel: string;
  increaseLabel: string;
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, Number.isFinite(next) ? Math.round(next) : min));
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label={decreaseLabel}
        title={decreaseLabel}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <input
        type="number"
        aria-label={label}
        className="h-7 w-10 rounded-md border bg-background text-center text-sm font-semibold tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(clamp(Number(event.target.value)))}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        aria-label={increaseLabel}
        title={increaseLabel}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function RecommendationPreviewPanel({
  config,
  threshold,
  example,
  onThresholdChange,
  onExampleChange,
}: {
  config: RecommendationConfig;
  threshold: number;
  example: RecommendationExample;
  onThresholdChange: (value: number) => void;
  onExampleChange: (value: RecommendationExample) => void;
}) {
  const breakdown = recommendationExampleBreakdown(config, example);
  const highlighted = breakdown.score >= threshold;
  const counters: Array<{ key: "tags" | "voices" | "circles" | "shelvedTags"; label: string; max: number }> = [
    { key: "tags", label: copy("exampleTags"), max: 10 },
    { key: "voices", label: copy("exampleVoices"), max: 5 },
    { key: "circles", label: copy("exampleCircles"), max: 3 },
    { key: "shelvedTags", label: copy("exampleShelvedTags"), max: 10 },
  ];
  return (
    <section className="rounded-md border bg-background p-4">
      <h3 className="mb-4 text-sm font-semibold">{copy("preview")}</h3>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <RecommendationScoreGauge score={breakdown.score} threshold={threshold} label={copy("exampleScore")} />
            <div className="min-w-0 space-y-1.5">
              <div className="text-xs text-muted-foreground">{copy("exampleScore")}</div>
              <Badge variant={highlighted ? "secondary" : "outline"}>
                {highlighted ? copy("badgeShown") : copy("belowThreshold")}
              </Badge>
            </div>
          </div>
          <RecommendationSliderField
            label={copy("badgeThreshold")}
            value={threshold}
            min={1}
            max={100}
            onChange={onThresholdChange}
          />
        </div>
        <div className="min-w-0 space-y-4">
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">{copy("exampleWork")}</div>
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {counters.map((counter) => (
                <div key={counter.key} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 text-sm leading-tight">{counter.label}</span>
                  <Stepper
                    label={counter.label}
                    value={example[counter.key]}
                    min={0}
                    max={counter.max}
                    decreaseLabel={copy("decreaseExample", { name: counter.label })}
                    increaseLabel={copy("increaseExample", { name: counter.label })}
                    onChange={(value) => onExampleChange({ ...example, [counter.key]: value })}
                  />
                </div>
              ))}
              <label className="flex min-h-9 items-center justify-between gap-3 text-sm">
                <span>{copy("exampleFavorite")}</span>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={example.favorite}
                  onChange={(event) => onExampleChange({ ...example, favorite: event.target.checked })}
                />
              </label>
            </div>
          </div>
          <RecommendationComposition components={breakdown.components} score={breakdown.score} threshold={threshold} />
          <p className="text-xs text-muted-foreground">{copy("exampleNote")}</p>
        </div>
      </div>
    </section>
  );
}

/** The band a work's ranking position can move for the example score. */
export function RecommendationOrderingBand({ config, score }: { config: RecommendationConfig; score: number }) {
  const range = recommendationOrderingRange(config, score);
  const extent = Math.max(5, Math.ceil(Math.max(Math.abs(range.min), range.max)));
  const toPercent = (value: number) => 50 + (value / extent) * 50;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{copy("orderingRange", { score })}</span>
        <span className="font-semibold tabular-nums">
          {signedRecommendationValue(range.min, 1)} … {signedRecommendationValue(range.max, 1)}
        </span>
      </div>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-muted">
        <div
          className="absolute inset-y-0 bg-foreground/25"
          style={{ left: `${toPercent(range.min)}%`, width: `${toPercent(range.max) - toPercent(range.min)}%` }}
        />
        <div
          className="absolute inset-y-0 bg-primary/60"
          style={{ left: "50%", width: `${toPercent(range.discovery) - 50}%` }}
        />
        <span className="absolute inset-y-0 left-1/2 w-px bg-foreground/50" aria-hidden="true" />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-primary/60" />
          <span className="text-muted-foreground">{copy("discoveryBoost")}</span>
          <span className="font-semibold tabular-nums">{signedRecommendationValue(range.discovery, 1)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-foreground/25" />
          <span className="text-muted-foreground">{copy("resultVariation")}</span>
          <span className="font-semibold tabular-nums">±{config.jitterAmplitude}</span>
        </span>
      </div>
    </div>
  );
}

const laneOrder: Array<{ key: ConfigKey; label: string; min: number; tone: string }> = [
  { key: "listeningSlots", label: "listening", min: 0, tone: "bg-primary" },
  { key: "wantSlots", label: "want", min: 0, tone: "bg-primary/75" },
  { key: "unmarkedSlots", label: "unmarked", min: 1, tone: "bg-primary/50" },
  { key: "relistenSlots", label: "relisten", min: 0, tone: "bg-primary/30" },
  { key: "finishedSlots", label: "finished", min: 0, tone: "bg-muted-foreground/45" },
  { key: "shelvedSlots", label: "shelved", min: 0, tone: "bg-muted-foreground/20" },
];

export function RecommendationLaneMix({
  config,
  onChange,
}: {
  config: RecommendationConfig;
  onChange: (key: ConfigKey, value: number) => void;
}) {
  const total = laneOrder.reduce((sum, lane) => sum + config[lane.key], 0);
  return (
    <div className="space-y-3">
      <div
        className="flex h-5 overflow-hidden rounded-md bg-muted"
        role="img"
        aria-label={copy("totalSlots", { count: total })}
      >
        {laneOrder.map((lane) =>
          config[lane.key] > 0 ? (
            <div
              key={lane.key}
              className="h-full px-px first:pl-0 last:pr-0"
              style={{ width: `${(config[lane.key] / Math.max(1, total)) * 100}%` }}
              title={`${copy(lane.label)} ${config[lane.key]}`}
            >
              <div className={cn("h-full rounded-[3px]", lane.tone)} />
            </div>
          ) : null,
        )}
      </div>
      <div className="text-xs text-muted-foreground">{copy("totalSlots", { count: total })}</div>
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {laneOrder.map((lane) => {
          const label = copy(lane.label);
          return (
            <div key={lane.key} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", lane.tone)} />
                <span className="truncate">{label}</span>
              </span>
              <Stepper
                label={label}
                value={config[lane.key]}
                min={lane.min}
                max={100}
                decreaseLabel={copy("removeSlot", { lane: label })}
                increaseLabel={copy("addSlot", { lane: label })}
                onChange={(value) => onChange(lane.key, value)}
              />
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{copy("mixSlotsDescription")}</p>
    </div>
  );
}

/** Possible affinity from the lowest deduction to every cap filled. */
export function RecommendationScoreRange({ config, threshold }: { config: RecommendationConfig; threshold: number }) {
  const range = recommendationScoreRange(config);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{copy("scoreRange")}</span>
        <span className="font-semibold tabular-nums">
          {range.min}–{range.max}
        </span>
      </div>
      <div className="relative h-2.5 rounded-full bg-muted">
        <div
          className="absolute inset-y-0 rounded-full bg-primary/30"
          style={{ left: `${range.min}%`, width: `${Math.max(0.5, range.max - range.min)}%` }}
        />
        <span
          className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={{ left: `${clampRecommendationPercent(config.affinityBase)}%` }}
          title={copy("affinityBaseline")}
          aria-hidden="true"
        />
        <span
          className="absolute -inset-y-1 w-0 -translate-x-1/2 border-l-2 border-dotted border-foreground/50"
          style={{ left: `${clampRecommendationPercent(threshold)}%` }}
          aria-hidden="true"
        />
      </div>
      {range.rawMax > 100 && (
        <p className="text-xs text-muted-foreground">{copy("rawMaxCapped", { raw: range.rawMax })}</p>
      )}
    </div>
  );
}

/**
 * One evidence dimension: a meter split into per-match steps up to the cap,
 * with sliders for the step size and the cap.
 */
export function RecommendationDimensionRow({
  title,
  weightKey,
  capKey,
  weightLabel,
  capLabel,
  config,
  defaults,
  scaleMax,
  maxWeight,
  maxCap,
  tone,
  deduction = false,
  onChange,
}: {
  title: string;
  weightKey: ConfigKey;
  capKey: ConfigKey;
  weightLabel: string;
  capLabel: string;
  config: RecommendationConfig;
  defaults: RecommendationConfig | null;
  scaleMax: number;
  maxWeight: number;
  maxCap: number;
  tone: string;
  deduction?: boolean;
  onChange: (key: ConfigKey, value: number) => void;
}) {
  const weight = config[weightKey];
  const cap = config[capKey];
  const steps = recommendationMatchesToCap(weight, cap);
  const stepPercent = cap > 0 ? Math.min(100, (weight / cap) * 100) : 100;
  const fillStyle: CSSProperties = {
    width: `${Math.min(100, (cap / Math.max(1, scaleMax)) * 100)}%`,
    ...(deduction ? recommendationDeductionStyle : undefined),
    // Gaps every per-match step make the meter read as discrete matches.
    ...(steps && steps <= 40
      ? {
          maskImage: `repeating-linear-gradient(90deg, #000 0 calc(${stepPercent}% - 2px), transparent calc(${stepPercent}% - 2px) ${stepPercent}%)`,
        }
      : undefined),
  };
  return (
    <div className="grid gap-3 rounded-md border bg-background p-3 lg:grid-cols-[10rem_minmax(0,1fr)_minmax(0,16rem)] lg:items-center">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">
          {steps === null ? copy("noEffect") : copy("capReachedAfter", { count: steps })}
        </div>
      </div>
      <div className="relative h-4 rounded-full bg-muted" aria-hidden="true">
        <div className={cn("absolute inset-y-0 left-0 rounded-full", tone)} style={fillStyle} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <RecommendationSliderField
          label={copy("perMatch")}
          ariaLabel={weightLabel}
          value={weight}
          min={0}
          max={maxWeight}
          defaultValue={defaults?.[weightKey]}
          onChange={(value) => onChange(weightKey, value)}
        />
        <RecommendationSliderField
          label={copy("cap")}
          ariaLabel={capLabel}
          value={cap}
          min={0}
          max={maxCap}
          defaultValue={defaults?.[capKey]}
          onChange={(value) => onChange(capKey, value)}
        />
      </div>
    </div>
  );
}
