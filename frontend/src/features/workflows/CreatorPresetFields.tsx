import { Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { api, type LibrarySource } from "@/lib/api";

/**
 * Creator target fields for the circle and voice actor follow presets: the
 * compatible remote source list, a source checkbox group, and a voice actor
 * picker that resolves the stored person id to a name.
 */

export function useCompatibleRemoteSources() {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    api
      .listLibrarySources()
      .then((items) => {
        if (active) setSources(items);
      })
      .catch(() => {
        if (active) setSources([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const compatible = useMemo(
    () =>
      sources.filter(
        (source) =>
          source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
      ),
    [sources],
  );
  return { sources: compatible, loading };
}

export function RemoteSourceCheckboxes({
  label,
  sources,
  loading,
  selected,
  disabled = false,
  onChange,
}: {
  label: string;
  sources: LibrarySource[];
  loading: boolean;
  selected: number[];
  disabled?: boolean;
  onChange: (ids: number[]) => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("workflowPage.creatorFields.loadingSources")}
      </div>
    );
  }
  if (sources.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("workflowPage.creatorFields.noSources")}</p>;
  }
  const chosen = new Set(selected);
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {sources.map((source) => (
        <label
          key={source.id}
          className="flex min-h-[var(--control-height-sm)] min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-md border bg-background px-2.5 text-sm"
        >
          <Checkbox
            checked={chosen.has(source.id)}
            disabled={disabled}
            aria-label={source.displayName}
            onCheckedChange={(checked) => {
              const next = new Set(chosen);
              if (checked) next.add(source.id);
              else next.delete(source.id);
              onChange(sources.map((item) => item.id).filter((id) => next.has(id)));
            }}
          />
          <span className="truncate">{source.displayName}</span>
        </label>
      ))}
    </div>
  );
}

type VoiceChoice = { personId: number; displayName: string };

function useVoiceSearch(query: string, enabled: boolean) {
  const [results, setResults] = useState<VoiceChoice[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const needle = query.trim();
    if (!enabled || !needle) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .listVoices({ query: needle, pageSize: 8, signal: controller.signal })
        .then((page) =>
          setResults(page.voices.map((voice) => ({ personId: voice.personId, displayName: voice.displayName }))),
        )
        .catch(() => {
          if (!controller.signal.aborted) setResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, query]);
  return { results, loading };
}

/**
 * Picks one voice actor by id. The display name is loaded for a stored id so
 * prefilled and saved forms show who they target.
 */
export function VoiceActorPicker({
  id,
  personId,
  displayName,
  disabled = false,
  onChange,
}: {
  id: string;
  personId: string;
  displayName: string;
  disabled?: boolean;
  onChange: (personId: string, displayName: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const selectedId = Number(personId);
  const selected = Number.isSafeInteger(selectedId) && selectedId > 0;
  const { results, loading } = useVoiceSearch(query, !selected);

  useEffect(() => {
    if (!selected || displayName) return;
    const controller = new AbortController();
    api
      .getVoiceSummary(selectedId, controller.signal)
      .then((summary) => onChange(String(summary.personId), summary.displayName))
      .catch(() => undefined);
    return () => controller.abort();
  }, [displayName, selected, selectedId]);

  if (selected) {
    return (
      <div className="flex min-h-[var(--control-height-sm)] max-w-sm items-center gap-2 rounded-[var(--control-radius)] border bg-background pl-3 pr-1 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{displayName || `#${selectedId}`}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">#{selectedId}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={t("workflowPage.creatorFields.changeVoice")}
          disabled={disabled}
          onClick={() => {
            setQuery("");
            onChange("", "");
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }
  return (
    <div className="grid max-w-sm gap-1">
      <Input
        id={id}
        fieldSize="sm"
        value={query}
        placeholder={t("workflowPage.creatorFields.voiceSearchPlaceholder")}
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
      />
      {query.trim() && (
        <div
          className="grid max-h-56 overflow-y-auto rounded-md border bg-background p-1"
          role="listbox"
          aria-label={t("workflowPage.creatorFields.voiceResults")}
        >
          {loading && results.length === 0 ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("workflowPage.creatorFields.searching")}
            </div>
          ) : results.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("workflowPage.creatorFields.voiceSearchEmpty")}
            </div>
          ) : (
            results.map((result) => (
              <button
                key={result.personId}
                type="button"
                role="option"
                aria-selected={false}
                className="flex min-w-0 items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                onClick={() => onChange(String(result.personId), result.displayName)}
              >
                <span className="truncate">{result.displayName}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">#{result.personId}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
