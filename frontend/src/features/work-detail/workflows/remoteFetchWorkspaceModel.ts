import {
  type RemoteFetchFileDecision,
  type RemoteFetchPreparation,
  type RemoteWorkDetail,
  type RemoteWorkSavePlan,
} from "../../../lib/api";
import { formatRemoteFetchPlanConflict, hasRemoteFetchConflicts } from "../../../lib/remoteFetchPlan";

export type FetchIntent = {
  sourceId: number;
  remoteCode: string;
  sourceDisplayName?: string;
  canonicalCode?: string;
  detail?: RemoteWorkDetail;
};

export type RemoteFetchDraft = {
  intent: FetchIntent;
  detail: RemoteWorkDetail;
  selectedPaths: Set<string>;
  selectedLocalPaths: Set<string>;
  targetRoot: string;
  plan: RemoteWorkSavePlan | null;
  preparation: RemoteFetchPreparation;
  decisions: Record<string, RemoteFetchFileDecision>;
  planDirty: boolean;
  message: string;
  requestId: string;
};

export function createRemoteFetchRequestId(randomUUID?: () => string) {
  const uuid =
    randomUUID ??
    (typeof globalThis.crypto?.randomUUID === "function" ? () => globalThis.crypto.randomUUID() : undefined);
  const random = uuid ? uuid() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `fetch:${random}`;
}

export function createRemoteFetchDraft({
  intent,
  detail,
  paths,
  plan,
  requestId = createRemoteFetchRequestId(),
}: {
  intent: FetchIntent;
  detail: RemoteWorkDetail;
  paths: string[];
  plan: RemoteWorkSavePlan;
  requestId?: string;
}): RemoteFetchDraft {
  return {
    intent: { ...intent, remoteCode: remoteDetailActionCode(detail), detail },
    detail,
    selectedPaths: new Set(paths),
    selectedLocalPaths: new Set(),
    targetRoot: "",
    plan,
    preparation: plan.preparation,
    decisions: {},
    planDirty: false,
    message: formatRemoteFetchPreparation(plan),
    requestId,
  };
}

export function selectRemoteFetchEdition({
  draft,
  detail,
  paths,
  requestId = createRemoteFetchRequestId(),
}: {
  draft: RemoteFetchDraft;
  detail: RemoteWorkDetail;
  paths: string[];
  requestId?: string;
}): RemoteFetchDraft {
  return {
    ...draft,
    intent: { ...draft.intent, remoteCode: remoteDetailActionCode(detail), detail },
    detail,
    selectedPaths: new Set(paths),
    selectedLocalPaths: new Set(),
    targetRoot: "",
    plan: null,
    decisions: {},
    planDirty: false,
    message: "",
    requestId,
  };
}

export function remoteDetailActionCode(detail: RemoteWorkDetail) {
  return detail.remoteCode || detail.primaryCode || detail.remoteId;
}

export function formatRemoteFetchPreparation(plan: RemoteWorkSavePlan) {
  if (hasRemoteFetchConflicts(plan)) return formatRemoteFetchPlanConflict(plan);
  const editions = plan.preparation?.editions.length ?? 0;
  const local = plan.localFiles.length;
  const warning = plan.preparation?.warnings[0];
  const summary = `Review ${editions || 1} language ${editions === 1 ? "edition" : "editions"}, ${local} local files, and the planned result before fetching.`;
  return warning ? `${summary} Metadata is ${plan.preparation.metadataStatus}: ${warning}` : summary;
}
