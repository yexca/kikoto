import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import {
  CURRENT_FOLDER_RESOURCE,
  folderEditReadiness,
  folderEditRemoteResource,
  folderEditRequest,
  folderEditResources,
  folderEditResult,
  localFolderFiles,
  remoteEditionFiles,
  type FolderEditFile,
  type FolderEditResource,
  type FolderEditTarget,
} from "@/features/work-detail/folder-edit/folderEditModel";
import {
  ApiError,
  api,
  type MediaItem,
  type RemoteFetchFileDecision,
  type WorkFolderEditPlan,
  type WorkFolderEditResult,
} from "@/lib/api";

export type FolderEditFilesState = {
  status: "loading" | "ready" | "error";
  files: FolderEditFile[];
};

/** The remote edition a Fetch opens the workspace on. */
export type FolderEditInitialRemote = {
  sourceId: number;
  remoteCode: string;
};

const PLAN_DELAY_MS = 500;
const noFiles: FolderEditFile[] = [];
const noSelection: ReadonlySet<string> = new Set();

function createFolderEditRequestId() {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `edit:${random}`;
}

/**
 * The state of one folder edit: where files can come from, what is selected in
 * each place, the server's preview of the additions, and the submission.
 */
export function useFolderEditWorkspace({
  target,
  currentItems,
  initialRemote,
  onApplied,
}: {
  target: FolderEditTarget;
  /** The media of the edited work, which the page has already loaded. */
  currentItems: MediaItem[];
  initialRemote?: FolderEditInitialRemote | null;
  onApplied: (result: WorkFolderEditResult) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const currentFiles = useMemo(() => localFolderFiles(currentItems, target.rootPath), [currentItems, target.rootPath]);
  const currentResource = useMemo<FolderEditResource>(
    () => folderEditResources({ workId: target.workId, primaryCode: "", editions: [], warnings: [] }, target)[0],
    [target],
  );
  const [resources, setResources] = useState<FolderEditResource[]>([currentResource]);
  const [sourcesStatus, setSourcesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [sourcesAttempt, setSourcesAttempt] = useState(0);
  const [files, setFiles] = useState<Record<string, FolderEditFilesState>>({});
  const [selection, setSelection] = useState<Record<string, ReadonlySet<string>>>({});
  const [activeId, setActiveId] = useState(CURRENT_FOLDER_RESOURCE);
  const [decisions, setDecisions] = useState<Record<string, RemoteFetchFileDecision>>({});
  const [plan, setPlan] = useState<WorkFolderEditPlan | null>(null);
  const [plannedRevision, setPlannedRevision] = useState("");
  const [planFailed, setPlanFailed] = useState(false);
  const [planAttempt, setPlanAttempt] = useState(0);
  const [applying, setApplying] = useState(false);
  const requestId = useRef(createFolderEditRequestId());
  const loading = useRef(new Set<string>());
  // Only the first load opens on the remote edition a Fetch asked for.
  const pendingInitialRemote = useRef(initialRemote ?? null);

  // The edited folder's files come from the page; everything in it stays
  // selected until the user clears it.
  useEffect(() => {
    setFiles((current) => ({ ...current, [CURRENT_FOLDER_RESOURCE]: { status: "ready", files: currentFiles } }));
    setSelection((current) => ({
      ...current,
      [CURRENT_FOLDER_RESOURCE]: new Set(currentFiles.map((file) => file.path)),
    }));
  }, [currentFiles]);

  const loadResource = useCallback(async (resource: FolderEditResource) => {
    if (resource.kind === "current" || loading.current.has(resource.id)) return;
    loading.current.add(resource.id);
    setFiles((current) => ({ ...current, [resource.id]: { status: "loading", files: noFiles } }));
    try {
      const loaded =
        resource.kind === "local"
          ? localFolderFiles((await api.getWork(resource.workId)).mediaItems, resource.rootPath)
          : remoteEditionFiles((await api.getRemoteSourceWork(resource.sourceId, resource.editionCode)).tracks);
      setFiles((current) => ({ ...current, [resource.id]: { status: "ready", files: loaded } }));
    } catch {
      setFiles((current) => ({ ...current, [resource.id]: { status: "error", files: noFiles } }));
    } finally {
      loading.current.delete(resource.id);
    }
  }, []);

  const selectResource = useCallback(
    (resource: FolderEditResource) => {
      setActiveId(resource.id);
      if (!files[resource.id] || files[resource.id].status === "error") void loadResource(resource);
    },
    [files, loadResource],
  );

  useEffect(() => {
    const controller = new AbortController();
    setSourcesStatus("loading");
    api.getWorkFolderEditSources(target.workId, controller.signal).then(
      (sources) => {
        const next = folderEditResources(sources, target);
        setResources(next);
        setSourcesStatus("ready");
        const wanted = pendingInitialRemote.current;
        pendingInitialRemote.current = null;
        if (!wanted) return;
        const remote = folderEditRemoteResource(next, wanted.sourceId, wanted.remoteCode);
        if (!remote) return;
        setActiveId(remote.id);
        void loadResource(remote);
      },
      () => {
        if (!controller.signal.aborted) setSourcesStatus("error");
      },
    );
    return () => controller.abort();
  }, [loadResource, sourcesAttempt, target]);

  // A check asks the remote sources again; until then the list shows the
  // availability they reported last.
  const [remoteCheck, setRemoteCheck] = useState<"idle" | "checking">("idle");
  const remoteCheckAbort = useRef<AbortController | null>(null);
  useEffect(() => () => remoteCheckAbort.current?.abort(), []);
  const checkRemote = useCallback(async () => {
    if (remoteCheckAbort.current) return;
    const controller = new AbortController();
    remoteCheckAbort.current = controller;
    setRemoteCheck("checking");
    try {
      const next = folderEditResources(await api.checkWorkFolderEditSources(target.workId, controller.signal), target);
      setResources(next);
      setSourcesStatus("ready");
      const found = next.filter((resource) => resource.kind === "remote").length;
      if (found > 0) toast.success(t("folderEdit.remoteCheckFound", { count: found }));
      else toast.info(t("folderEdit.remoteCheckNone"));
    } catch (error) {
      if (!controller.signal.aborted) toast.notify(toastFromError(error, t("folderEdit.remoteCheckFailed")));
    } finally {
      if (remoteCheckAbort.current === controller) remoteCheckAbort.current = null;
      if (!controller.signal.aborted) setRemoteCheck("idle");
    }
  }, [t, target, toast]);

  const readyFiles = useMemo(() => {
    const ready: Record<string, FolderEditFile[]> = {};
    for (const [id, state] of Object.entries(files)) if (state.status === "ready") ready[id] = state.files;
    return ready;
  }, [files]);
  const request = useMemo(
    () => folderEditRequest({ target, resources, files: readyFiles, selection, decisions }),
    [decisions, readyFiles, resources, selection, target],
  );
  const revision = useMemo(() => JSON.stringify(request), [request]);
  const needsPlan = request.additions.length > 0;

  useEffect(() => {
    if (!needsPlan || applying) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.planWorkFolderEdit(target.workId, request).then(
        (next) => {
          if (cancelled) return;
          setPlan(next);
          setPlannedRevision(revision);
          setPlanFailed(false);
        },
        () => {
          if (!cancelled) setPlanFailed(true);
        },
      );
    }, PLAN_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // The request is identified by its revision.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [applying, needsPlan, planAttempt, revision, target.workId]);

  const currentPlan = needsPlan ? plan : null;
  const planCurrent = needsPlan && plannedRevision === revision;
  const readiness = folderEditReadiness({ request, plan: currentPlan, planCurrent });
  const currentSelection = selection[CURRENT_FOLDER_RESOURCE] ?? noSelection;
  const result = useMemo(
    () => folderEditResult(currentFiles, currentSelection, currentPlan),
    [currentFiles, currentPlan, currentSelection],
  );
  const removedFiles = useMemo(
    () => currentFiles.filter((file) => !currentSelection.has(file.path)),
    [currentFiles, currentSelection],
  );

  const apply = async () => {
    if (readiness !== "ready" || applying) return;
    setApplying(true);
    try {
      onApplied(await api.applyWorkFolderEdit(target.workId, { ...request, requestId: requestId.current }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "folder_edit_conflict") {
        // The folder changed since the preview; show what it holds now.
        setPlannedRevision("");
        setPlanAttempt((value) => value + 1);
        toast.notify({ kind: "warning", message: t("folderEdit.folderChanged") });
      } else {
        toast.notify(toastFromError(error, t("folderEdit.applyFailed")));
      }
    } finally {
      setApplying(false);
    }
  };

  return {
    resources,
    sourcesStatus,
    retrySources: () => setSourcesAttempt((value) => value + 1),
    remoteCheck,
    checkRemote: () => void checkRemote(),
    files,
    selection,
    activeResource: resources.find((resource) => resource.id === activeId) ?? resources[0] ?? currentResource,
    selectResource,
    retryResource: (resource: FolderEditResource) => void loadResource(resource),
    setSelected: (resourceId: string, paths: ReadonlySet<string>) =>
      setSelection((current) => ({ ...current, [resourceId]: paths })),
    decisions,
    setDecision: (decision: RemoteFetchFileDecision) =>
      setDecisions((current) => ({ ...current, [decision.itemKey]: decision })),
    request,
    plan: currentPlan,
    planFailed: needsPlan && planFailed && !planCurrent,
    retryPlan: () => {
      setPlanFailed(false);
      setPlanAttempt((value) => value + 1);
    },
    readiness,
    result,
    removedFiles,
    applying,
    apply,
  };
}

export type FolderEditWorkspace = ReturnType<typeof useFolderEditWorkspace>;
