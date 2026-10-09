import { RefreshCw } from "lucide-react";

import { useAuth } from "@/auth/AuthProvider";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import i18n from "@/i18n";
import type { RecommendationAffinityBreakdown, RecommendationBreakdown, Work } from "@/lib/api";
import {
  RecommendationAdjustment,
  RecommendationComposition,
  RecommendationScoreGauge,
} from "@/components/recommendation/RecommendationScoreVisuals";

export function RecommendationExplanationDialog({
  state,
  onClose,
}: {
  state: { work: Work; breakdown: RecommendationBreakdown | null; loading: boolean; error: string };
  onClose: () => void;
}) {
  const { recommendationThreshold } = useAuth();
  const affinity = state.breakdown?.scoreKind !== "demo_random" ? state.breakdown : null;
  const scoreLabel = i18n.t(affinity ? "libraryDetail.affinityScore" : "libraryDetail.demoRandomScore");
  return (
    <Dialog onClose={onClose} layer="overlay-top" size="md">
      <DialogHeader
        title={<span className="block truncate">{state.work.title}</span>}
        description={state.work.primaryCode}
        onClose={onClose}
        closeLabel={i18n.t("content.close")}
      />
      <DialogBody className="space-y-5">
        {state.loading ? (
          <div className="flex min-h-36 items-center justify-center text-sm text-muted-foreground">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> {i18n.t("libraryDetail.loadingScore")}
          </div>
        ) : state.error ? (
          <div className="text-sm text-destructive">{state.error}</div>
        ) : state.breakdown ? (
          <>
            <div className="flex items-center gap-4">
              <RecommendationScoreGauge
                score={state.breakdown.score}
                threshold={affinity ? recommendationThreshold : undefined}
                label={scoreLabel}
              />
              <div className="min-w-0 space-y-2">
                <div className="text-sm font-medium">{scoreLabel}</div>
                {affinity && (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="secondary">{recommendationLaneLabel(affinity.lane)}</Badge>
                      <Badge variant="outline">
                        {i18n.t("libraryDetail.highlightThreshold", { value: recommendationThreshold })}
                      </Badge>
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground">{affinity.algorithmVersion}</div>
                  </>
                )}
              </div>
            </div>
            {affinity && (
              <RecommendationComposition
                components={affinity.components}
                score={affinity.score}
                threshold={recommendationThreshold}
                rankingScore={affinity.ordering?.rankingScore}
              />
            )}
            {affinity && affinity.rawScore !== affinity.score && (
              <p className="text-xs text-muted-foreground">
                {i18n.t("libraryDetail.rawScoreBounded", { raw: affinity.rawScore, score: affinity.score })}
              </p>
            )}
            {affinity?.ordering && <RecommendationAdjustment ordering={affinity.ordering} />}
            {affinity && (
              <p className="border-t pt-4 text-xs leading-relaxed text-muted-foreground">
                {i18n.t("libraryDetail.recommendationExplanation")}
              </p>
            )}
          </>
        ) : null}
      </DialogBody>
    </Dialog>
  );
}

function recommendationLaneLabel(lane: RecommendationAffinityBreakdown["lane"]) {
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
