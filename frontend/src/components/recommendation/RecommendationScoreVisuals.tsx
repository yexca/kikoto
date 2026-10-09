import type { CSSProperties } from "react";

import i18n from "@/i18n";
import type { RecommendationAffinityBreakdown } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

type AffinityComponent = RecommendationAffinityBreakdown["components"][number];
type AffinityOrdering = NonNullable<RecommendationAffinityBreakdown["ordering"]>;

// Deductions read as a texture rather than a status color: a shelved
// similarity lowers affinity but is not an error.
export const recommendationDeductionStyle: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(135deg, currentColor 0 2px, transparent 2px 5px)",
};

export const recommendationComponentTones: Record<string, string> = {
  base: "bg-muted-foreground/35",
  tags: "bg-primary",
  voices: "bg-primary/70",
  circles: "bg-primary/45",
  favorite: "bg-primary/20 ring-1 ring-inset ring-primary/60",
};

const componentLabelKeys: Record<string, string> = {
  base: "libraryDetail.componentBase",
  tags: "libraryDetail.componentTags",
  voices: "libraryDetail.componentVoices",
  circles: "libraryDetail.componentCircles",
  favorite: "libraryDetail.componentFavorite",
  paused_similarity: "libraryDetail.componentShelved",
};

export function clampRecommendationPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

function componentLabel(component: AffinityComponent) {
  const key = componentLabelKeys[component.key];
  return key ? i18n.t(key) : component.label;
}

export function signedRecommendationValue(value: number, digits = 0) {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(digits)}`;
}

// A 270-degree arc that opens at the bottom, drawn once and filled through a
// normalized path length so the score maps directly onto 0-100.
const GAUGE_CENTER = 60;
const GAUGE_RADIUS = 48;
const GAUGE_START_DEGREES = 135;
const GAUGE_SWEEP_DEGREES = 270;

function gaugePoint(degrees: number, radius: number) {
  const radians = (degrees * Math.PI) / 180;
  return { x: GAUGE_CENTER + radius * Math.cos(radians), y: GAUGE_CENTER + radius * Math.sin(radians) };
}

const gaugeStart = gaugePoint(GAUGE_START_DEGREES, GAUGE_RADIUS);
const gaugeEnd = gaugePoint(GAUGE_START_DEGREES + GAUGE_SWEEP_DEGREES, GAUGE_RADIUS);
const gaugeArc = `M ${gaugeStart.x} ${gaugeStart.y} A ${GAUGE_RADIUS} ${GAUGE_RADIUS} 0 1 1 ${gaugeEnd.x} ${gaugeEnd.y}`;

export function RecommendationScoreGauge({
  score,
  threshold,
  label,
}: {
  score: number;
  threshold?: number;
  label: string;
}) {
  const value = clampRecommendationPercent(score);
  const highlighted = threshold === undefined || score >= threshold;
  const thresholdDegrees =
    GAUGE_START_DEGREES + (GAUGE_SWEEP_DEGREES * clampRecommendationPercent(threshold ?? 0)) / 100;
  const tickInner = gaugePoint(thresholdDegrees, GAUGE_RADIUS - 9);
  const tickOuter = gaugePoint(thresholdDegrees, GAUGE_RADIUS + 9);
  return (
    <svg
      viewBox="0 0 120 112"
      className="h-28 w-28 shrink-0"
      role="img"
      aria-label={i18n.t("libraryDetail.scoreGaugeLabel", { label, score })}
    >
      <path
        d={gaugeArc}
        pathLength={100}
        fill="none"
        strokeWidth={10}
        strokeLinecap="round"
        className="stroke-current text-muted"
      />
      {value > 0 && (
        <path
          d={gaugeArc}
          pathLength={100}
          fill="none"
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${value} 100`}
          className={cn("stroke-current", highlighted ? "text-primary" : "text-muted-foreground/60")}
        />
      )}
      {threshold !== undefined && (
        <line
          x1={tickInner.x}
          y1={tickInner.y}
          x2={tickOuter.x}
          y2={tickOuter.y}
          strokeWidth={2}
          strokeLinecap="round"
          className="stroke-current text-foreground/55"
        />
      )}
      <text
        x={GAUGE_CENTER}
        y={GAUGE_CENTER + 2}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-current text-[30px] font-semibold tabular-nums text-foreground"
      >
        {score}
      </text>
      <text
        x={GAUGE_CENTER}
        y={GAUGE_CENTER + 26}
        textAnchor="middle"
        className="fill-current text-[10px] tabular-nums text-muted-foreground"
      >
        / 100
      </text>
    </svg>
  );
}

type CompositionSegment = { key: string; left: number; width: number; tone: string };

export function RecommendationComposition({
  components,
  score,
  threshold,
  rankingScore,
}: {
  components: AffinityComponent[];
  score: number;
  threshold?: number;
  rankingScore?: number;
}) {
  const positives = components.filter((component) => component.key !== "paused_similarity");
  const deduction = Math.max(
    0,
    -(components.find((component) => component.key === "paused_similarity")?.contribution ?? 0),
  );
  const segments: CompositionSegment[] = [];
  let cursor = 0;
  for (const component of positives) {
    if (component.contribution <= 0) continue;
    const left = cursor;
    cursor += component.contribution;
    if (left >= 100) continue;
    segments.push({
      key: component.key,
      left,
      width: Math.min(component.contribution, 100 - left),
      tone: recommendationComponentTones[component.key] ?? "bg-primary/45",
    });
  }
  const deductionLeft = clampRecommendationPercent(cursor - deduction);
  const deductionWidth = clampRecommendationPercent(cursor) - deductionLeft;
  const legend = components.filter(
    (component) => component.key === "base" || component.contribution !== 0 || component.matchCount > 0,
  );
  const hasEvidence = legend.some((component) => component.key !== "base");
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-medium text-muted-foreground">{i18n.t("libraryDetail.scoreComposition")}</h3>
      <div className="relative pt-2.5">
        {rankingScore !== undefined && (
          <span
            className="absolute top-0 h-0 w-0 -translate-x-1/2 border-x-[5px] border-t-[6px] border-x-transparent border-t-foreground"
            style={{ left: `${clampRecommendationPercent(rankingScore)}%` }}
            title={`${i18n.t("libraryDetail.rankingScore")} ${rankingScore.toFixed(1)}`}
            aria-hidden="true"
          />
        )}
        <div
          className="relative h-4 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={legend
            .map((component) => `${componentLabel(component)} ${signedRecommendationValue(component.contribution)}`)
            .join(", ")}
        >
          {segments.map((segment) => (
            <div
              key={segment.key}
              className="absolute inset-y-0 px-px"
              style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
            >
              <div className={cn("h-full rounded-[3px]", segment.tone)} />
            </div>
          ))}
          {deductionWidth > 0 && (
            <div
              className="absolute inset-y-0 bg-muted/70 text-foreground/45"
              style={{ ...recommendationDeductionStyle, left: `${deductionLeft}%`, width: `${deductionWidth}%` }}
            />
          )}
        </div>
        {threshold !== undefined && (
          <span
            className="absolute bottom-[-3px] top-[7px] w-0 -translate-x-1/2 border-l-2 border-dotted border-foreground/50"
            style={{ left: `${clampRecommendationPercent(threshold)}%` }}
            title={i18n.t("libraryDetail.highlightThreshold", { value: threshold })}
            aria-hidden="true"
          />
        )}
        <span
          className="absolute bottom-[-3px] top-[7px] w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={{ left: `${clampRecommendationPercent(score)}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>0</span>
        <span>100</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {legend.map((component) => (
          <div key={component.key} className="flex min-w-0 items-center gap-1.5">
            {component.key === "paused_similarity" ? (
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm bg-muted text-foreground/45"
                style={recommendationDeductionStyle}
              />
            ) : (
              <span
                className={cn(
                  "h-2.5 w-2.5 shrink-0 rounded-sm",
                  recommendationComponentTones[component.key] ?? "bg-primary/45",
                )}
              />
            )}
            <span className="truncate text-xs text-muted-foreground">{componentLabel(component)}</span>
            <span className="text-xs font-semibold tabular-nums">
              {signedRecommendationValue(component.contribution)}
            </span>
            {component.matchCount > 0 && component.key !== "favorite" && (
              <span
                className="text-[10px] tabular-nums text-muted-foreground"
                title={i18n.t("libraryDetail.matchedSignals", { count: component.matchCount })}
              >
                ×{component.matchCount}
              </span>
            )}
          </div>
        ))}
      </div>
      {!hasEvidence && <p className="text-xs text-muted-foreground">{i18n.t("libraryDetail.noAffinitySignals")}</p>}
    </section>
  );
}

type AdjustmentPart = { key: string; label: string; value: number; tone: string; textured?: boolean };

export function RecommendationAdjustment({ ordering }: { ordering: AffinityOrdering }) {
  const parts: AdjustmentPart[] = [
    {
      key: "discovery",
      label: i18n.t("libraryDetail.discoveryBoost"),
      value: ordering.explorationBoost,
      tone: "bg-primary/60",
    },
    {
      key: "variation",
      label: i18n.t("libraryDetail.resultVariation"),
      value: ordering.jitter,
      tone: "bg-foreground/30",
    },
  ];
  if (ordering.diversityPenalty) {
    parts.push({
      key: "diversity",
      label: i18n.t("libraryDetail.diversityAdjustment"),
      value: -ordering.diversityPenalty,
      tone: "bg-muted text-foreground/45",
      textured: true,
    });
  }
  const positiveTotal = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0);
  const negativeTotal = parts.reduce((sum, part) => sum + Math.max(0, -part.value), 0);
  const range = Math.max(5, Math.ceil(Math.max(positiveTotal, negativeTotal)));
  const toPercent = (value: number) => (value / range) * 50;
  let positiveCursor = 0;
  let negativeCursor = 0;
  const bars = parts
    .filter((part) => Math.abs(part.value) >= 0.05)
    .map((part) => {
      const width = toPercent(Math.abs(part.value));
      let left: number;
      if (part.value > 0) {
        left = 50 + positiveCursor;
        positiveCursor += width;
      } else {
        negativeCursor += width;
        left = 50 - negativeCursor;
      }
      return { ...part, left, width };
    });
  return (
    <section className="space-y-3 border-t pt-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">{i18n.t("libraryDetail.shuffleAdjustment")}</h3>
        <span className="text-sm font-semibold tabular-nums">
          {signedRecommendationValue(ordering.totalAdjustment, 1)}
        </span>
      </div>
      <div className="relative">
        <div className="relative h-2.5 overflow-hidden rounded-full bg-muted">
          {bars.map((bar) => (
            <div
              key={bar.key}
              className={cn("absolute inset-y-0", bar.tone)}
              style={{
                left: `${bar.left}%`,
                width: `${bar.width}%`,
                ...(bar.textured ? recommendationDeductionStyle : undefined),
              }}
            />
          ))}
        </div>
        <span className="absolute -inset-y-1 left-1/2 w-px bg-foreground/40" aria-hidden="true" />
        <span
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-background"
          style={{ left: `${50 + toPercent(ordering.totalAdjustment)}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>{signedRecommendationValue(-range)}</span>
        <span>0</span>
        <span>{signedRecommendationValue(range)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {parts.map((part) => (
          <div key={part.key} className="flex items-center gap-1.5">
            <span
              className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", part.tone)}
              style={part.textured ? recommendationDeductionStyle : undefined}
            />
            <span className="text-xs text-muted-foreground">{part.label}</span>
            <span className="text-xs font-semibold tabular-nums">{signedRecommendationValue(part.value, 1)}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
        <span className="text-sm font-medium">{i18n.t("libraryDetail.rankingScore")}</span>
        <span className="text-lg font-semibold tabular-nums">{ordering.rankingScore.toFixed(1)}</span>
      </div>
    </section>
  );
}
