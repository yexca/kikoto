import { useEffect, useState } from "react";
import { api, type MetadataCircle, type MetadataTag } from "@/lib/api";

export function useMetadataEntrySuggestions(kind: "tags" | "circles", query: string) {
  const [result, setResult] = useState<{ key: string; entries: (MetadataTag | MetadataCircle)[]; failed: boolean }>({
    key: "",
    entries: [],
    failed: false,
  });
  const key = `${kind}:${query.trim()}`;
  useEffect(() => {
    if (!query.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const options = { query: query.trim(), pageSize: 20, signal: controller.signal };
      const request =
        kind === "tags"
          ? api.listMetadataTags({ ...options, includeHidden: true }).then((page) => page.tags)
          : api.listMetadataCircles(options).then((page) => page.circles);
      void request
        .then((entries) => {
          if (!controller.signal.aborted) setResult({ key, entries, failed: false });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResult({ key, entries: [], failed: true });
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, kind, query]);
  return result.key === key ? result : { entries: [], failed: false };
}
