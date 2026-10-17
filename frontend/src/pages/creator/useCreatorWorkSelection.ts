import { useEffect, useState } from "react";

import {
  REMOTE_BULK_FETCH_PERMISSIONS,
  REMOTE_BULK_TRACK_PERMISSIONS,
  usePermissionGate,
} from "@/auth/usePermissionGate";
import { retainVisibleSelection, withSelection } from "@/components/work-collection/workSelectionModel";
import type { RemoteWorkTarget } from "@/pages/remoteBulkRunModel";
import { creatorBulkCopy, useRemoteWorkActions } from "@/pages/useRemoteWorkActions";

export type CreatorWorkSelectionOptions<W> = {
  /** The loaded page of works. A selection covers this page only. */
  works: readonly W[];
  /** A stable key function; it is an effect dependency. */
  keyOf: (work: W) => string;
  selectable: (work: W) => boolean;
  /** Which selected works Fetch saves; every selected work when omitted. */
  fetchable?: (work: W) => boolean;
  /** Which selected works Fork tracks. */
  forkable: (work: W) => boolean;
  remoteTargets: (works: readonly W[]) => RemoteWorkTarget[];
  /** Refreshes the page once the queued runs finish. */
  reload: () => Promise<unknown>;
  /** Runs as each bulk run starts. */
  onBulkStart?: () => void;
};

export type CreatorWorkSelection<W> = ReturnType<typeof useCreatorWorkSelection<W>>;

/**
 * The bulk selection of a creator's works page: which works are selected,
 * the Fetch and Fork runs over them, and the busy state those runs and the
 * page's single-work actions share.
 */
export function useCreatorWorkSelection<W>({
  works,
  keyOf,
  selectable,
  fetchable,
  forkable,
  remoteTargets,
  reload,
  onBulkStart,
}: CreatorWorkSelectionOptions<W>) {
  const requireBulkFetch = usePermissionGate(REMOTE_BULK_FETCH_PERMISSIONS);
  const requireBulkTrack = usePermissionGate(REMOTE_BULK_TRACK_PERMISSIONS, { deferDemo: true });
  const { recordBulkRuns } = useRemoteWorkActions();
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionModeState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveConfirm, setSaveConfirm] = useState<{ count: number; run: () => Promise<void> } | null>(null);

  useEffect(() => {
    setSelectedKeys((current) => retainVisibleSelection(current, works, keyOf));
  }, [keyOf, works]);

  const isSelected = (work: W) => selectedKeys.has(keyOf(work));
  const selectedWorks = works.filter(isSelected);
  const selectableWorks = works.filter(selectable);
  const fetchableWorks = fetchable ? selectedWorks.filter(fetchable) : selectedWorks;
  const forkableWorks = selectedWorks.filter(forkable);

  const clear = () => setSelectedKeys(new Set());
  const setSelectionMode = (value: boolean) => {
    setSelectionModeState(value);
    if (!value) clear();
  };

  const runBusy = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };

  const runBulkFetch = async () => {
    if (!requireBulkFetch()) return;
    setBusy(true);
    onBulkStart?.();
    try {
      await recordBulkRuns("fetch", remoteTargets(fetchableWorks), creatorBulkCopy, reload);
    } finally {
      setBusy(false);
      setSaveConfirm(null);
    }
  };

  return {
    selectionMode,
    setSelectionMode,
    toggleSelectionMode: () =>
      setSelectionModeState((value) => {
        if (value) clear();
        return !value;
      }),
    isSelected,
    selectedWorks,
    selectableWorks,
    fetchableWorks,
    forkableWorks,
    scopeSelectedCount: selectableWorks.filter(isSelected).length,
    toggle: (work: W, checked: boolean) => setSelectedKeys((current) => withSelection(current, [keyOf(work)], checked)),
    selectScope: () => setSelectedKeys((current) => withSelection(current, selectableWorks.map(keyOf), true)),
    clear,
    exit: () => setSelectionMode(false),
    busy,
    runBusy,
    bulkFetch: () => {
      if (fetchableWorks.length === 0 || !requireBulkFetch()) return;
      setSaveConfirm({ count: fetchableWorks.length, run: runBulkFetch });
    },
    bulkFork: async () => {
      if (forkableWorks.length === 0 || !requireBulkTrack()) return;
      onBulkStart?.();
      await runBusy(() => recordBulkRuns("track", remoteTargets(forkableWorks), creatorBulkCopy, reload));
    },
    saveConfirm,
    closeSaveConfirm: () => setSaveConfirm(null),
  };
}
