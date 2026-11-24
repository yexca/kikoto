import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import {
  localFolderFiles,
  remoteEditionFiles,
  type FolderEditFile,
  type FolderEditTarget,
} from "@/features/work-detail/folder-edit/folderEditModel";
import {
  FOLDER_LYRICS_RESOURCE,
  MANAGED_LYRICS_RESOURCE,
  folderLyrics,
  lyricsEditLanguage,
  lyricsEditReadiness,
  lyricsEditRequest,
  lyricsEditResources,
  lyricsEditResult,
  lyricsFilesOf,
  type LyricsEditResource,
} from "@/features/work-detail/lyrics/lyricsEditModel";
import { useDebouncedRequest } from "@/hooks/useDebouncedRequest";
import {
  ApiError,
  api,
  type FolderLyricsMode,
  type LyricsEditPlan,
  type LyricsEditResult,
  type MediaItem,
  type RemoteFetchFileDecision,
} from "@/lib/api";
import { startLoad } from "@/lib/effectScope";

type LyricsEditFilesState = {
  status: "loading" | "ready" | "error";
  files: FolderEditFile[];
};

const PLAN_DELAY_MS = 500;
const noFiles: FolderEditFile[] = [];
const noSelection: ReadonlySet<string> = new Set();

/**
 * The state of one edit of the lyrics Kikoto manages in a local folder: where
 * lyrics can come from, what is selected in each place and in which language,
 * the server's preview of the additions, and the submission.
 */
export function useLyricsEditWorkspace({
  target,
  items,
  canAssign,
  startInFolderLyrics = false,
  localOnly = false,
  onApplied,
}: {
  target: FolderEditTarget;
  /** The media of the edited work, which the page has already loaded. */
  items: MediaItem[];
  /** Whether the viewer may assign the added lyrics to tracks. */
  canAssign: boolean;
  /** Opens on the folder's other lyrics instead of the managed lyrics. */
  startInFolderLyrics?: boolean;
  /** Lists only local places, for a custom work that no remote source has. */
  localOnly?: boolean;
  onApplied: (result: LyricsEditResult) => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const lyrics = useMemo(() => folderLyrics(items, target.folderId), [items, target.folderId]);
  const ownResources = useMemo(
    () => lyricsEditResources({ workId: target.workId, primaryCode: "", editions: [], warnings: [] }, target),
    [target],
  );
  const [resources, setResources] = useState<LyricsEditResource[]>(ownResources);
  const [sourcesStatus, setSourcesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [sourcesAttempt, setSourcesAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Record<string, LyricsEditFilesState>>({});
  const [selection, setSelection] = useState<Record<string, ReadonlySet<string>>>(() => ({
    [MANAGED_LYRICS_RESOURCE]: new Set(lyrics.managed.map((file) => file.path)),
  }));
  const [languages, setLanguages] = useState<Record<string, string | null>>({});
  const [listManaged, setListManaged] = useState(false);
  // The folder's own files are copied unless the administrator's default or
  // the viewer's choice moves them.
  const [defaultFolderMode, setDefaultFolderMode] = useState<FolderLyricsMode>("copy");
  const [chosenFolderMode, setChosenFolderMode] = useState<FolderLyricsMode | null>(null);
  const folderMode = chosenFolderMode ?? defaultFolderMode;
  const [activeId, setActiveId] = useState(startInFolderLyrics ? FOLDER_LYRICS_RESOURCE : MANAGED_LYRICS_RESOURCE);
  const [decisions, setDecisions] = useState<Record<string, RemoteFetchFileDecision>>({});
  const [assign, setAssign] = useState(true);
  const [applying, setApplying] = useState(false);
  const loading = useRef(new Set<string>());

  // The folder's own files come from the page. Every managed file stays
  // selected until the viewer clears it; the others move only when selected.
  const folderFiles = useMemo(
    () => (listManaged ? [...lyrics.loose, ...lyrics.managed] : lyrics.loose),
    [listManaged, lyrics],
  );
  const files = useMemo<Record<string, LyricsEditFilesState>>(
    () => ({
      ...loaded,
      [MANAGED_LYRICS_RESOURCE]: { status: "ready", files: lyrics.managed },
      [FOLDER_LYRICS_RESOURCE]: { status: "ready", files: folderFiles },
    }),
    [folderFiles, loaded, lyrics.managed],
  );
  useEffect(() => {
    setSelection((current) => ({
      ...current,
      [MANAGED_LYRICS_RESOURCE]: new Set(lyrics.managed.map((file) => file.path)),
    }));
  }, [lyrics.managed]);

  const loadResource = useCallback(async (resource: LyricsEditResource) => {
    if ((resource.kind !== "local" && resource.kind !== "remote") || loading.current.has(resource.id)) return;
    loading.current.add(resource.id);
    setLoaded((current) => ({ ...current, [resource.id]: { status: "loading", files: noFiles } }));
    try {
      const found =
        resource.kind === "local"
          ? localFolderFiles((await api.getWork(resource.workId)).mediaItems, resource.folderId)
          : remoteEditionFiles((await api.getRemoteSourceWork(resource.sourceId, resource.editionCode)).tracks);
      setLoaded((current) => ({ ...current, [resource.id]: { status: "ready", files: lyricsFilesOf(found) } }));
    } catch {
      setLoaded((current) => ({ ...current, [resource.id]: { status: "error", files: noFiles } }));
    } finally {
      loading.current.delete(resource.id);
    }
  }, []);

  const selectResource = useCallback(
    (resource: LyricsEditResource) => {
      setActiveId(resource.id);
      if (!loaded[resource.id] || loaded[resource.id].status === "error") void loadResource(resource);
    },
    [loaded, loadResource],
  );

  useEffect(() => {
    setSourcesStatus("loading");
    setResources(ownResources);
    return startLoad((signal) => api.getWorkFolderEditSources(target.workId, signal), {
      onSuccess: (sources) => {
        setResources(lyricsEditResources(sources, target));
        setSourcesStatus("ready");
      },
      onError: () => setSourcesStatus("error"),
    });
  }, [ownResources, sourcesAttempt, target]);

  // Without the default the edit copies, which never changes the work's own files.
  useEffect(
    () =>
      startLoad((signal) => api.getRuntimeSettings(signal), {
        onSuccess: (settings) => {
          if (settings.folderLyricsMode) setDefaultFolderMode(settings.folderLyricsMode);
        },
      }),
    [],
  );

  const readyFiles = useMemo(() => {
    const ready: Record<string, FolderEditFile[]> = {};
    for (const [id, state] of Object.entries(files)) if (state.status === "ready") ready[id] = state.files;
    return ready;
  }, [files]);
  const { request, undeclared } = useMemo(
    () => lyricsEditRequest({ target, resources, files: readyFiles, selection, languages, decisions, folderMode }),
    [decisions, folderMode, languages, readyFiles, resources, selection, target],
  );
  const revision = useMemo(() => JSON.stringify(request), [request]);
  const needsPlan = request.additions.length > 0;

  const planRequest = useDebouncedRequest<LyricsEditPlan>({
    key: `${target.workId}:${canAssign}:${revision}`,
    enabled: needsPlan && !applying,
    delayMs: PLAN_DELAY_MS,
    // A viewer who may assign sees the pairs the server would make.
    send: (signal) => api.planWorkLyricsEdit(target.workId, canAssign ? { ...request, assign: true } : request, signal),
  });

  const currentPlan = needsPlan ? planRequest.result : null;
  const planCurrent = needsPlan && planRequest.current;
  const readiness = lyricsEditReadiness({ request, undeclared, plan: currentPlan, planCurrent });
  const kept = selection[MANAGED_LYRICS_RESOURCE] ?? noSelection;
  const result = useMemo(
    () => lyricsEditResult(lyrics.managed, kept, currentPlan),
    [currentPlan, kept, lyrics.managed],
  );
  const removedFiles = useMemo(() => lyrics.managed.filter((file) => !kept.has(file.path)), [kept, lyrics.managed]);
  const assignments = canAssign && assign && planCurrent ? (currentPlan?.assignments ?? []) : [];

  const apply = async () => {
    if (readiness !== "ready" || applying) return;
    setApplying(true);
    try {
      // The server pairs the files again as the folder is when the edit applies.
      const applied = await api.applyWorkLyricsEdit(target.workId, { ...request, assign: canAssign && assign });
      toast.success(
        t("lyricsFiles.applied", {
          added: applied.moved + applied.copied + applied.downloaded,
          removed: applied.removed,
        }) + (applied.assigned > 0 ? ` ${t("lyricsFiles.appliedAssigned", { count: applied.assigned })}` : ""),
      );
      // The edit is done; what was selected for it is no longer waiting.
      setSelection((current) => ({ [MANAGED_LYRICS_RESOURCE]: current[MANAGED_LYRICS_RESOURCE] ?? noSelection }));
      setDecisions({});
      planRequest.clear();
      setActiveId(MANAGED_LYRICS_RESOURCE);
      await onApplied(applied);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "lyrics_edit_conflict") {
        // The folder changed since the preview; show what it holds now.
        planRequest.invalidate();
        toast.notify({ kind: "warning", message: t("folderEdit.folderChanged") });
      } else {
        toast.notify(toastFromError(error, t("lyricsFiles.applyFailed")));
      }
    } finally {
      setApplying(false);
    }
  };

  const activeResource = resources.find((resource) => resource.id === activeId) ?? resources[0];
  return {
    resources,
    localOnly,
    sourcesStatus,
    retrySources: () => setSourcesAttempt((value) => value + 1),
    files,
    selection,
    activeResource,
    selectResource,
    retryResource: (resource: LyricsEditResource) => void loadResource(resource),
    setSelected: (resourceId: string, paths: ReadonlySet<string>) =>
      setSelection((current) => ({ ...current, [resourceId]: paths })),
    language: (resource: LyricsEditResource) => lyricsEditLanguage(resource, languages),
    setLanguage: (resourceId: string, language: string) =>
      setLanguages((current) => ({ ...current, [resourceId]: language })),
    listManaged,
    setListManaged: (listed: boolean) => {
      setListManaged(listed);
      if (listed) return;
      // The managed files leave the list, and their selection with them.
      const loose = new Set(lyrics.loose.map((file) => file.path));
      setSelection((current) => ({
        ...current,
        [FOLDER_LYRICS_RESOURCE]: new Set(
          [...(current[FOLDER_LYRICS_RESOURCE] ?? noSelection)].filter((path) => loose.has(path)),
        ),
      }));
    },
    folderMode,
    setFolderMode: setChosenFolderMode,
    decisions,
    setDecision: (decision: RemoteFetchFileDecision) =>
      setDecisions((current) => ({ ...current, [decision.itemKey]: decision })),
    request,
    undeclared,
    plan: currentPlan,
    planFailed: needsPlan && planRequest.failed && !planCurrent,
    retryPlan: planRequest.retry,
    readiness,
    result,
    removedFiles,
    canAssign,
    assign,
    setAssign,
    assignments,
    applying,
    apply,
  };
}

export type LyricsEditWorkspace = ReturnType<typeof useLyricsEditWorkspace>;
