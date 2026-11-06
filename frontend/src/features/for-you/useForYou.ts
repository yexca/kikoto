import { useCallback, useEffect, useRef, useState } from "react";

import { WORK_DETAIL_USER_STATE_EVENT, type WorkDetailUserStateDetail } from "@/app/workDetailEvents";
import { useAuth } from "@/auth/AuthProvider";
import { api, ApiError, type Work } from "@/lib/api";
import { FOR_YOU_COLUMNS, type ForYouColumn, type ForYouTemperature } from "@/lib/forYouApi";

import {
  advanceForYouDrawRevision,
  emptyForYouColumns,
  forYouColumnsFromSnapshot,
  forYouSnapshotFromColumns,
  initialForYouDrawRevision,
  isCurrentForYouDrawRevision,
  otherColumnWorkIds,
  patchForYouColumns,
  type ForYouColumnState,
} from "./forYouModel";
import { readForYouSnapshot, writeForYouSnapshot } from "./forYouSnapshotStore";

/** Whether the first draw is still loading, failed, or waits for recommendations to finish preparing. */
export type ForYouStatus = "loading" | "ready" | "preparing" | "failed";

/**
 * The For you draws: all three columns on the first open in a browser session
 * and after a temperature change, one column when it is drawn again. A column
 * draw leaves out what the other columns show, so a work stays in one column.
 * The settled draw is kept for `storageScope`, so opening For you again shows
 * it instead of drawing anew.
 */
export function useForYou(storageScope: string) {
  const { demoMode } = useAuth();
  const [restored] = useState(() => readForYouSnapshot(storageScope));
  const [status, setStatus] = useState<ForYouStatus>(restored ? "ready" : "loading");
  const [temperature, setTemperature] = useState<ForYouTemperature | null>(restored?.temperature ?? null);
  const [columns, setColumns] = useState(() => (restored ? forYouColumnsFromSnapshot(restored) : emptyForYouColumns()));
  const [algorithmVersion, setAlgorithmVersion] = useState(restored?.algorithmVersion ?? "");
  const columnsRef = useRef(columns);
  useEffect(() => {
    columnsRef.current = columns;
  }, [columns]);
  // Full draws invalidate every older request. Column draws only invalidate
  // older draws of that column, while the full-draw epoch fences a late
  // column response from overwriting a newer temperature change.
  const drawRevision = useRef(initialForYouDrawRevision());

  const draw = useCallback(async (requested: ForYouColumn[], nextTemperature?: ForYouTemperature) => {
    const single = requested.length === 1 ? requested[0] : null;
    const token = advanceForYouDrawRevision(drawRevision.current, requested);
    drawRevision.current = token;
    setColumns((state) => {
      const next = { ...state };
      for (const column of requested) next[column] = { ...next[column], drawing: true, failed: false };
      return next;
    });
    try {
      const result = await api.drawForYou({
        columns: requested,
        temperature: nextTemperature,
        exclude: single ? otherColumnWorkIds(columnsRef.current, single) : undefined,
      });
      if (!isCurrentForYouDrawRevision(token, drawRevision.current, requested)) return;
      setTemperature(result.temperature);
      setAlgorithmVersion(result.algorithmVersion);
      setColumns((state) => {
        const next = { ...state };
        for (const item of result.columns) {
          next[item.column] = { items: item.items, coldStart: item.coldStart, drawing: false, failed: false };
        }
        return next;
      });
      setStatus("ready");
    } catch (error) {
      if (!isCurrentForYouDrawRevision(token, drawRevision.current, requested)) return;
      setColumns((state) => {
        const next = { ...state };
        for (const column of requested) next[column] = { ...next[column], drawing: false, failed: true };
        return next;
      });
      if (!single) {
        setStatus(error instanceof ApiError && error.code === "recommendation_preparing" ? "preparing" : "failed");
      }
    }
  }, []);

  // A kept draw is shown as it was; only a first open draws, and only once,
  // since every draw records its works as shown.
  const firstDrawStarted = useRef(false);
  useEffect(() => {
    if (restored || firstDrawStarted.current) return;
    firstDrawStarted.current = true;
    void draw([...FOR_YOU_COLUMNS]);
  }, [restored, draw]);

  // Keep every settled draw, and the marks and ratings changed on its cards.
  useEffect(() => {
    if (status !== "ready" || temperature === null) return;
    const snapshot = forYouSnapshotFromColumns(columns, temperature, algorithmVersion);
    if (snapshot) writeForYouSnapshot(storageScope, snapshot);
  }, [algorithmVersion, columns, status, storageScope, temperature]);

  const drawAll = useCallback(() => draw([...FOR_YOU_COLUMNS], temperature ?? undefined), [draw, temperature]);
  const drawColumn = useCallback(
    (column: ForYouColumn) => draw([column], temperature ?? undefined),
    [draw, temperature],
  );
  // The choice is saved for the account, then every column draws again with
  // it. Demo shares one account and saves nothing, so the choice stays in the
  // kept draw.
  const changeTemperature = useCallback(
    async (next: ForYouTemperature) => {
      setTemperature(next);
      void draw([...FOR_YOU_COLUMNS], next);
      if (demoMode) return;
      try {
        await api.updateUserPreferences({ forYouTemperature: next });
      } catch {
        // The draw still uses the choice; it is saved the next time it changes.
      }
    },
    [demoMode, draw],
  );
  // Marks and ratings change the card in place; the next draw reads them.
  const patchWork = useCallback((workId: number, patch: Partial<Work>) => {
    setColumns((state) => patchForYouColumns(state, workId, patch));
  }, []);

  // Work detail opens over Discover, which stays mounted, and reports the
  // listening status, favorite, and rating changed there.
  useEffect(() => {
    const followDetail = (event: Event) => {
      const { workID, listeningStatus, favorite, userRating } = (event as CustomEvent<WorkDetailUserStateDetail>)
        .detail;
      patchWork(workID, { listeningStatus, favorite, userRating });
    };
    window.addEventListener(WORK_DETAIL_USER_STATE_EVENT, followDetail);
    return () => window.removeEventListener(WORK_DETAIL_USER_STATE_EVENT, followDetail);
  }, [patchWork]);

  return {
    status,
    temperature,
    columns: columns as Record<ForYouColumn, ForYouColumnState>,
    algorithmVersion,
    drawAll,
    drawColumn,
    changeTemperature,
    patchWork,
  };
}
