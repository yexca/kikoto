import { useEffect, useState } from "react";
import { api, type MetadataCircle, type MetadataTag } from "@/lib/api";
import { startLoad } from "@/lib/effectScope";

export function useMetadataEntrySuggestions(kind: "tags" | "circles", query: string) {
  const [result, setResult] = useState<{ key: string; entries: (MetadataTag | MetadataCircle)[]; failed: boolean }>({
    key: "",
    entries: [],
    failed: false,
  });
  const key = `${kind}:${query.trim()}`;
  useEffect(() => {
    if (!query.trim()) return;
    return startLoad<(MetadataTag | MetadataCircle)[]>(
      (signal) => {
        const options = { query: query.trim(), pageSize: 20, signal };
        return kind === "tags"
          ? api.listMetadataTags({ ...options, includeHidden: true, resolveMerged: true }).then((page) => page.tags)
          : api.listMetadataCircles(options).then((page) => page.circles);
      },
      {
        onSuccess: (entries) => setResult({ key, entries, failed: false }),
        onError: () => setResult({ key, entries: [], failed: true }),
      },
      { delayMs: 250 },
    );
  }, [key, kind, query]);
  return result.key === key ? result : { entries: [], failed: false };
}
