import { RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import i18n from "@/i18n";
import type { RecommendationBreakdown, Work } from "@/lib/api";

export function RecommendationExplanationDialog({
  state,
  onClose,
}: {
  state: { work: Work; breakdown: RecommendationBreakdown | null; loading: boolean; error: string };
  onClose: () => void;
}) {
  const components =
    state.breakdown?.components.filter((component) => component.matchCount > 0 || component.contribution !== 0) ?? [];
  return (
    <Dialog onClose={onClose} layer="overlay-top" size="md">
      <DialogHeader
        title={<span className="block truncate">{state.work.title}</span>}
        description={state.work.primaryCode}
        onClose={onClose}
        closeLabel={i18n.t("content.close")}
      />
      <DialogBody className="space-y-4">
        {state.loading ? (
          <div className="flex min-h-36 items-center justify-center text-sm text-muted-foreground">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> {i18n.t("libraryDetail.loadingScore")}
          </div>
        ) : state.error ? (
          <div className="text-sm text-destructive">{state.error}</div>
        ) : state.breakdown ? (
          <>
            <div className="flex items-end justify-between gap-4 border-b pb-3">
              <div>
                <div className="text-xs text-muted-foreground">{i18n.t("libraryDetail.affinityScore")}</div>
                <div className="text-3xl font-semibold">{state.breakdown.score}</div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Badge variant="secondary">{recommendationLaneLabel(state.breakdown.lane)}</Badge>
                <Badge variant="outline">{state.breakdown.algorithmVersion}</Badge>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{i18n.t("libraryDetail.recommendationExplanation")}</p>
            {state.breakdown.ordering && (
              <div className="space-y-2 border-t pt-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{i18n.t("libraryDetail.shuffleAdjustment")}</span>
                  <span className="font-semibold tabular-nums">
                    {formatRecommendationAdjustment(state.breakdown.ordering.totalAdjustment)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{i18n.t("libraryDetail.discoveryBoost")}</span>
                  <span className="font-medium tabular-nums">
                    {formatRecommendationAdjustment(state.breakdown.ordering.explorationBoost)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{i18n.t("libraryDetail.resultVariation")}</span>
                  <span className="font-medium tabular-nums">
                    {formatRecommendationAdjustment(state.breakdown.ordering.jitter)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 border-t pt-2">
                  <span className="font-medium">{i18n.t("libraryDetail.rankingScore")}</span>
                  <span className="font-semibold tabular-nums">{state.breakdown.ordering.rankingScore.toFixed(1)}</span>
                </div>
              </div>
            )}
            <div className="space-y-2">
              {components.map((component) => (
                <div key={component.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">{component.label}</div>
                    {component.matchCount > 0 && component.key !== "state" && (
                      <div className="text-xs text-muted-foreground">
                        {i18n.t("libraryDetail.matchedSignals", { count: component.matchCount })}
                      </div>
                    )}
                  </div>
                  <span
                    className={
                      component.contribution < 0 ? "font-semibold text-destructive" : "font-semibold text-primary"
                    }
                  >
                    {component.contribution > 0 ? "+" : ""}
                    {component.contribution}
                  </span>
                </div>
              ))}
            </div>
            {state.breakdown.rawScore !== state.breakdown.score && (
              <div className="border-t pt-3 text-xs text-muted-foreground">
                {i18n.t("libraryDetail.rawScoreBounded", {
                  raw: state.breakdown.rawScore,
                  score: state.breakdown.score,
                })}
              </div>
            )}
          </>
        ) : null}
      </DialogBody>
    </Dialog>
  );
}

function formatRecommendationAdjustment(value: number) {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(1)}`;
}

function recommendationLaneLabel(lane: RecommendationBreakdown["lane"]) {
  switch (lane) {
    case "listening":
      return i18n.t("libraryDetail.listeningPriority");
    case "want":
      return i18n.t("libraryDetail.wantPriority");
    case "relisten":
      return i18n.t("libraryDetail.relistenMix");
    case "finished":
      return i18n.t("libraryDetail.finishedMix");
    case "shelved":
      return i18n.t("libraryDetail.shelvedFallback");
    default:
      return i18n.t("libraryDetail.unmarkedDiscovery");
  }
}
