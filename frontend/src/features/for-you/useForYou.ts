import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, type Work } from "@/lib/api";
import { FOR_YOU_COLUMNS, type ForYouColumn, type ForYouTemperature } from "@/lib/forYouApi";

import {
  advanceForYouDrawRevision,
  emptyForYouColumns,
  initialForYouDrawRevision,
  isCurrentForYouDrawRevision,
  otherColumnWorkIds,
  type ForYouColumnState,
} from "./forYouModel";

/** Whether the first draw is still loading, failed, or waits for recommendations to finish preparing. */
export type ForYouStatus = "loading" | "ready" | "preparing" | "failed";

/**
 * The For you draws: all three columns on open and after a temperature
 * change, one column when it is drawn again. A column draw leaves out what the
 * other columns show, so a work stays in one column.
 */
export function useForYou(active: boolean) {
  const [status, setStatus] = useState<ForYouStatus>("loading");
  const [temperature, setTemperature] = useState<ForYouTemperature | null>(null);
  const [columns, setColumns] = useState(emptyForYouColumns);
  const [algorithmVersion, setAlgorithmVersion] = useState("");
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

  useEffect(() => {
    if (active) void draw([...FOR_YOU_COLUMNS]);
  }, [active, draw]);

  const drawAll = useCallback(() => draw([...FOR_YOU_COLUMNS], temperature ?? undefined), [draw, temperature]);
  const drawColumn = useCallback(
    (column: ForYouColumn) => draw([column], temperature ?? undefined),
    [draw, temperature],
  );
  // The choice is saved for the account, then every column draws again with it.
  const changeTemperature = useCallback(
    async (next: ForYouTemperature) => {
      setTemperature(next);
      void draw([...FOR_YOU_COLUMNS], next);
      try {
        await api.updateUserPreferences({ forYouTemperature: next });
      } catch {
        // The draw still uses the choice; it is saved the next time it changes.
      }
    },
    [draw],
  );
  // Marks and ratings change the card in place; the next draw reads them.
  const patchWork = useCallback((workId: number, patch: Partial<Work>) => {
    setColumns((state) => {
      const next = { ...state };
      for (const column of FOR_YOU_COLUMNS) {
        if (!state[column].items.some((item) => item.work.id === workId)) continue;
        next[column] = {
          ...state[column],
          items: state[column].items.map((item) =>
            item.work.id === workId ? { ...item, work: { ...item.work, ...patch } } : item,
          ),
        };
      }
      return next;
    });
  }, []);

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
