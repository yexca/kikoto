import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  api,
  type RecordActivity,
  type RecordRoot,
  type RecordSectionName,
  type RecordSectionPage,
  type RecordSectionPages,
  type RecordSiblings,
} from "@/lib/api";
import { startLoad } from "@/lib/effectScope";

import { crumbFromFolder } from "./recordsModel";
import { recordTrailFromState, type RecordCrumb } from "./recordsLocation";

export type RecordRootState =
  { status: "loading" } | { status: "error" } | { status: "ready"; root: RecordRoot; activity: RecordActivity | null };

/** The root and what its workflows are doing, as one read answers them. */
export type RecordRootReading = { root: RecordRoot; activity: RecordActivity | null };

/** A section as far as it has been read, and whether its next page is on the way or failed. */
export type RecordSectionState<T> = RecordSectionPage<T> & { loading: boolean; failed: boolean };

export type RecordSections = {
  [S in RecordSectionName]: RecordSectionState<RecordSectionPages[S]["items"][number]>;
};

export type RecordTreeState =
  | { status: "idle" }
  | { status: "loading"; folderId: number }
  | { status: "error"; folderId: number }
  | { status: "ready"; folderId: number; trail: RecordCrumb[]; sections: RecordSections };

type AnySection = RecordSectionState<{ id: number }>;

const sectionNames: readonly RecordSectionName[] = ["folders", "videos", "photos", "audio", "files"];

/**
 * How long after opening a folder whose listing left media details pending it
 * is listed once more, so the lengths and covers the server read meanwhile
 * appear. Files it has not read by then show theirs on the next visit.
 */
const mediaDetailsRefreshMs = 4_000;

/** The root state, read once and again on Retry or while a record workflow runs. */
export function useRecordRoot(enabled: boolean) {
  const [state, setState] = useState<RecordRootState>({ status: "loading" });
  const reload = useCallback(async (): Promise<RecordRootReading | null> => {
    try {
      const result = await api.getRecordRoot();
      const reading = { root: result.root, activity: result.activity ?? null };
      setState({ status: "ready", ...reading });
      return reading;
    } catch {
      setState((current) => (current.status === "ready" ? current : { status: "error" }));
      return null;
    }
  }, []);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  const setRoot = useCallback(
    (root: RecordRoot) =>
      setState((current) => ({
        status: "ready",
        root,
        activity: current.status === "ready" ? current.activity : null,
      })),
    [],
  );
  return { state, reload, setRoot };
}

/** Appends a page to a section, leaving out children an earlier page already held. */
function appendById<T extends { id: number }>(listed: readonly T[], page: readonly T[]) {
  const seen = new Set(listed.map((item) => item.id));
  return [...listed, ...page.filter((item) => !seen.has(item.id))];
}

function sectionsFromPages(pages: RecordSectionPages): RecordSections {
  const sections = {} as Record<RecordSectionName, AnySection>;
  for (const name of sectionNames) sections[name] = { ...pages[name], loading: false, failed: false };
  return sections as unknown as RecordSections;
}

/**
 * The open folder's sections and breadcrumb trail. A visit reads the first
 * page of every section; `loadMore` reads a section's next page and
 * `readWhole` the rest of it. A refresh reads each section again as far as it
 * was read, keeping the current listing until the new one is whole. The
 * listing names the folder's trail; until it arrives, the trail the history
 * entry carries stands in. A visit whose listing has media details pending is
 * refreshed once, a few seconds later.
 */
export function useRecordTree(folderId: number, historyState: unknown, enabled: boolean) {
  const [tree, setTree] = useState<RecordTreeState>({ status: "idle" });
  const [reloadToken, setReloadToken] = useState(0);
  const [pending, setPending] = useState(false);
  // The folder whose visit left media details pending, refreshed once.
  const [detailsRefreshFolder, setDetailsRefreshFolder] = useState<number | null>(null);
  const treeRef = useRef(tree);
  useLayoutEffect(() => {
    treeRef.current = tree;
  });
  // Each read of the folder starts a generation; pages of an earlier one are dropped.
  const generationRef = useRef(0);
  const inflightRef = useRef(new Set<string>());
  const wholeReadsRef = useRef(new Map<string, Promise<readonly { id: number }[] | null>>());
  const storedTrail = recordTrailFromState(historyState, folderId);

  useEffect(() => {
    if (!enabled) return;
    generationRef.current += 1;
    inflightRef.current.clear();
    const current = treeRef.current;
    const refreshing = current.status === "ready" && current.folderId === folderId;
    const readSoFar = refreshing ? current.sections : null;
    setPending(true);
    if (!refreshing) setTree({ status: "loading", folderId });
    let detailsPending = false;
    const load = async (signal: AbortSignal): Promise<RecordTreeState> => {
      const result = await api.listRecordTree(folderId || undefined, signal);
      detailsPending = (result.mediaDetailsPending ?? 0) > 0;
      const sections = sectionsFromPages(result.sections) as unknown as Record<RecordSectionName, AnySection>;
      if (readSoFar) {
        for (const name of sectionNames) {
          const wanted = readSoFar[name].items.length;
          let section = sections[name];
          while (section.next && section.items.length < wanted) {
            const page = await api.listRecordSection(folderId, name, section.next, signal);
            section = { ...section, items: appendById(section.items, page.items), total: page.total, next: page.next };
          }
          sections[name] = section;
        }
      }
      return {
        status: "ready",
        folderId,
        trail: result.trail.map(crumbFromFolder),
        sections: sections as unknown as RecordSections,
      };
    };
    return startLoad(load, {
      onSuccess: (state) => {
        setTree(state);
        if (!refreshing) setDetailsRefreshFolder(detailsPending ? folderId : null);
      },
      onError: () => setTree({ status: "error", folderId }),
      onSettled: () => setPending(false),
    });
  }, [enabled, folderId, reloadToken]);

  useEffect(() => {
    if (!enabled || detailsRefreshFolder !== folderId) return;
    const timer = window.setTimeout(() => {
      setDetailsRefreshFolder(null);
      setReloadToken((value) => value + 1);
    }, mediaDetailsRefreshMs);
    return () => window.clearTimeout(timer);
  }, [enabled, detailsRefreshFolder, folderId]);

  const updateSection = useCallback(
    (name: RecordSectionName, generation: number, change: (section: AnySection) => AnySection) => {
      if (generation !== generationRef.current) return;
      setTree((current) => {
        if (current.status !== "ready" || current.folderId !== folderId) return current;
        const sections = current.sections as unknown as Record<RecordSectionName, AnySection>;
        return {
          ...current,
          sections: { ...sections, [name]: change(sections[name]) } as unknown as RecordSections,
        };
      });
    },
    [folderId],
  );

  /** Reads the next page of a section, once at a time. */
  const loadMore = useCallback(
    (name: RecordSectionName) => {
      const current = treeRef.current;
      if (current.status !== "ready" || current.folderId !== folderId) return;
      const section = current.sections[name] as AnySection;
      const generation = generationRef.current;
      const key = `${generation}:${name}`;
      if (!section.next || inflightRef.current.has(key)) return;
      inflightRef.current.add(key);
      updateSection(name, generation, (value) => ({ ...value, loading: true, failed: false }));
      api
        .listRecordSection(folderId, name, section.next)
        .then((page) =>
          updateSection(name, generation, (value) => ({
            items: appendById(value.items, page.items),
            total: page.total,
            next: page.next,
            loading: false,
            failed: false,
          })),
        )
        .catch(() => updateSection(name, generation, (value) => ({ ...value, loading: false, failed: true })))
        .finally(() => inflightRef.current.delete(key));
    },
    [folderId, updateSection],
  );

  /**
   * Reads a section to its end and answers every child it has, in order, or
   * null when the folder is not listed or the folder changes or reloads first.
   * Calls while a read of the section runs share it, and More reads nothing
   * of the section meanwhile.
   */
  const readWhole = useCallback(
    <S extends RecordSectionName>(name: S): Promise<RecordSections[S]["items"] | null> => {
      const current = treeRef.current;
      if (current.status !== "ready" || current.folderId !== folderId) return Promise.resolve(null);
      const generation = generationRef.current;
      const key = `${generation}:${name}`;
      const reading = wholeReadsRef.current.get(key);
      if (reading) return reading as Promise<RecordSections[S]["items"] | null>;
      const start = current.sections[name] as AnySection;
      inflightRef.current.add(key);
      const read = (async () => {
        let items = start.items;
        let next = start.next;
        while (next) {
          const page = await api.listRecordSection(folderId, name, next);
          if (generation !== generationRef.current) return null;
          items = appendById(items, page.items);
          next = page.next;
        }
        const whole = items;
        updateSection(name, generation, (value) => ({
          ...value,
          items: appendById(value.items, whole),
          next: undefined,
          loading: false,
          failed: false,
        }));
        return whole;
      })().finally(() => {
        wholeReadsRef.current.delete(key);
        inflightRef.current.delete(key);
      });
      wholeReadsRef.current.set(key, read);
      return read as Promise<RecordSections[S]["items"] | null>;
    },
    [folderId, updateSection],
  );

  const listedTrail =
    tree.status === "ready" && tree.folderId === folderId && (folderId === 0 || tree.trail.length > 0)
      ? tree.trail
      : null;
  const trail =
    listedTrail ??
    storedTrail ??
    // Until the listing arrives, or for a folder the catalog no longer holds, the folder stands alone.
    (folderId > 0 ? [{ id: folderId, name: "" }] : []);

  return {
    tree,
    trail,
    pending,
    version: reloadToken,
    loadMore,
    readWhole,
    reload: () => setReloadToken((value) => value + 1),
  };
}

/**
 * Where the open overlay's file sits in its section, read for each file it
 * opens and again with each new `version` of the folder.
 */
export function useRecordSiblings(assetId: number | null, version: number) {
  const [state, setState] = useState<{ id: number; siblings: RecordSiblings | null } | null>(null);
  useEffect(() => {
    if (assetId === null) return;
    return startLoad((signal) => api.getRecordSiblings(assetId, signal), {
      onSuccess: (siblings) => setState({ id: assetId, siblings }),
      onError: () => setState({ id: assetId, siblings: null }),
    });
  }, [assetId, version]);
  return state && state.id === assetId ? state : null;
}
