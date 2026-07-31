import {
  type RemoteFetchFileDecision,
  type RemoteFetchEdition,
  type RemoteFetchPreparation,
  type RemoteLanguageEdition,
  type RemoteWorkDetail,
  type RemoteWorkSavePlan,
  type SourceAvailabilitySource,
} from "../../../lib/api";
import { buildRemoteTree, type TreeNode, type TreeTrack } from "../media/mediaTreeModel";
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

export function createDemoRemoteFetchPlan({
  detail,
  paths,
  targetRoot = "",
}: {
  detail: RemoteWorkDetail;
  paths: string[];
  targetRoot?: string;
}): RemoteWorkSavePlan {
  const requestedCode = remoteDetailActionCode(detail) || detail.remoteId || "demo-work";
  const canonicalCode = detail.primaryCode || requestedCode;
  const saveRoot = normalizeDemoFetchRoot(targetRoot, canonicalCode);
  const tree = buildRemoteTree(detail.tracks);
  const filesByPath = new Map(flattenTreeFiles(tree).map((file) => [file.sourcePath, file]));
  const source = demoSourceAvailability(detail);
  const items = Array.from(new Set(paths))
    .map((path, index) => {
      const file = filesByPath.get(path);
      const normalizedPath = path.replace(/^[\\/]+/, "");
      const targetPath = `${saveRoot}/${normalizedPath}`;
      return {
        itemKey: `demo:${detail.sourceId}:${canonicalCode}:${index + 1}`,
        path,
        kind: file?.kind || "file",
        sizeBytes: file?.sizeBytes ?? null,
        sourceKind: "remote",
        action: "preview",
        status: "preview only",
        sourcePath: path,
        localSourcePath: "",
        cachePath: file?.cachePath || "",
        targetPath,
        mediaItemId: file?.mediaItemId ?? -(index + 1),
        localPaths: [],
        targetExists: false,
        targetConflict: false,
        targetConflictReason: "",
        targetSizeBytes: null,
        originalTargetPath: targetPath,
        resolution: "auto" as const,
        remoteSourceId: detail.sourceId,
        remoteSourceCode: detail.sourceCode,
        remoteSourceName: detail.sourceName,
        remotePath: path,
        sourceOptions: [
          {
            sourceId: source.sourceId,
            sourceCode: source.sourceCode,
            sourceName: source.displayName,
            path,
            sizeBytes: file?.sizeBytes ?? null,
          },
        ],
      };
    });
  const preparation = createDemoFetchPreparation(detail, requestedCode, canonicalCode, source);
  return {
    sourceId: detail.sourceId,
    primaryCode: canonicalCode,
    saveRoot,
    localFiles: [],
    items,
    summary: {
      total: items.length,
      skipExisting: 0,
      cacheHit: 0,
      cacheDownload: 0,
      promote: items.length,
      conflict: 0,
    },
    preparation,
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

function createDemoFetchPreparation(
  detail: RemoteWorkDetail,
  requestedCode: string,
  canonicalCode: string,
  source: SourceAvailabilitySource,
): RemoteFetchPreparation {
  const languageEditions = detail.languageEditions.length > 0
    ? detail.languageEditions
    : [{
        remoteCode: canonicalCode,
        language: "",
        label: "Origin edition",
        displayOrder: 0,
        current: true,
        origin: true,
      } satisfies RemoteLanguageEdition];
  const editions: RemoteFetchEdition[] = languageEditions.map((edition) => ({
    workId: detail.workId ?? 0,
    primaryCode: edition.remoteCode || canonicalCode,
    title: detail.title,
    metadataLanguage: edition.language,
    editionLabel: edition.label || (edition.origin ? "Origin edition" : "Language edition"),
    translationKind: edition.origin ? "origin" : "unknown",
    classificationSource: "demo-preview",
    makerId: "",
    originMakerId: "",
    origin: edition.origin,
    localRoots: [],
    sources: [source],
  }));
  return {
    requestedCode,
    canonicalCode,
    metadataStatus: "complete",
    warnings: ["Demo mode: Fetch is preview-only; no files will be written."],
    editions,
  };
}

function demoSourceAvailability(detail: RemoteWorkDetail): SourceAvailabilitySource {
  return {
    sourceId: detail.sourceId,
    sourceCode: detail.sourceCode,
    displayName: detail.sourceName,
    status: "available",
    remoteId: detail.remoteId,
    primaryCode: detail.primaryCode || detail.remoteCode,
    title: detail.title,
    coverUrl: detail.coverUrl,
    workId: detail.workId,
    hasRemote: true,
    hasCache: false,
    hasLocal: false,
    error: "",
    elapsedMs: 0,
  };
}

function flattenTreeFiles(root: TreeNode) {
  const files: TreeTrack[] = [];
  const visit = (node: TreeNode) => {
    files.push(...node.files);
    for (const child of node.children.values()) visit(child);
  };
  visit(root);
  return files;
}

function normalizeDemoFetchRoot(targetRoot: string, code: string) {
  const trimmed = targetRoot.trim().replace(/[\\/]+$/, "");
  if (trimmed) return trimmed;
  const safeCode = code.replace(/[^A-Za-z0-9._-]+/g, "_") || "work";
  return `/data/demo-preview/${safeCode}`;
}
