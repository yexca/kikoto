import type { SourcePresenceItem, Work } from "@/lib/libraryApi";

/**
 * What the source checks of this visit found for the works a Discover
 * view shows: by code, the sources that have it, with the names of the sources
 * asked. A code with a work also keeps the answer as its source presence; for
 * the others this is the only record.
 */
export type ShownWorksSourceCheck = {
  sources: ReadonlyMap<number, string>;
  available: ReadonlyMap<string, number[]>;
};

/** A shown work: its code, and its work when Kikoto knows one. */
export type ShownWork = { code: string; work: Pick<Work, "sourcePresence"> | null };

export const EMPTY_SHOWN_WORKS_SOURCE_CHECK: ShownWorksSourceCheck = { sources: new Map(), available: new Map() };

/** Reads a finished source check run's summary; a summary it cannot read adds nothing. */
export function parseShownWorksSourceCheck(summaryJson: string): ShownWorksSourceCheck {
  const sources = new Map<number, string>();
  const available = new Map<string, number[]>();
  let summary: unknown;
  try {
    summary = JSON.parse(summaryJson || "{}");
  } catch {
    return { sources, available };
  }
  const record = summary && typeof summary === "object" ? (summary as Record<string, unknown>) : {};
  for (const source of Array.isArray(record.sources) ? record.sources : []) {
    if (source && typeof source.id === "number") sources.set(source.id, String(source.name ?? ""));
  }
  for (const result of Array.isArray(record.results) ? record.results : []) {
    if (result && typeof result.code === "string" && Array.isArray(result.available)) {
      const ids = result.available.filter((id: unknown): id is number => typeof id === "number");
      available.set(result.code.toUpperCase(), ids);
    }
  }
  return { sources, available };
}

/** A later check's answer replaces an earlier check's for the same code. */
export function mergeShownWorksSourceChecks(
  earlier: ShownWorksSourceCheck,
  later: ShownWorksSourceCheck,
): ShownWorksSourceCheck {
  return {
    sources: new Map([...earlier.sources, ...later.sources]),
    available: new Map([...earlier.available, ...later.available]),
  };
}

/**
 * A shown work's source presence: what its work records, then the sources this
 * visit's checks found that the work does not record, as for a code without a
 * work.
 */
export function shownWorkSourcePresence(item: ShownWork, check: ShownWorksSourceCheck): SourcePresenceItem[] {
  const recorded = item.work?.sourcePresence ?? [];
  const found = check.available.get(item.code.toUpperCase()) ?? [];
  const known = new Set(recorded.filter((entry) => entry.type === "source").map((entry) => entry.fileSourceId));
  return [
    ...recorded,
    ...found
      .filter((id) => !known.has(id))
      .map((id) => ({
        type: "source",
        availability: "available",
        fileSourceId: id,
        fileSourceName: check.sources.get(id) ?? "",
      })),
  ];
}

/** Whether a remote source is known to have the work: recorded, tracked, or answered this visit. */
export function shownWorkOnSource(item: ShownWork, check: ShownWorksSourceCheck): boolean {
  return shownWorkSourcePresence(item, check).some(
    (entry) => (entry.type === "source" || entry.type === "tracked") && entry.availability === "available",
  );
}
