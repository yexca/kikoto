import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, FileText, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { lyricsTimingCheck } from "@/features/work-detail/lyrics/lyricsManagerModel";
import { formatTrackDuration } from "@/features/work-detail/media/mediaTreeModel";
import { api, assetURL } from "@/lib/api";
import { parseTimedLyrics } from "@/lib/timedLyrics";

const previewLineCount = 6;
const maxRemotePreviewCharacters = 512 * 1024;

type LyricsPreviewState = { key: string; text: string } | { key: string; failed: true };

/**
 * Shows the first lines of a lyrics file and warns when its timed lines run
 * past the end of the track it is assigned to.
 */
export function LyricsPreview({
  label,
  loadKey,
  load,
  durationSeconds,
}: {
  label: string;
  /** Identifies the file; a new key loads again. */
  loadKey: string;
  load: () => Promise<string>;
  durationSeconds: number | null;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<LyricsPreviewState | null>(null);
  useEffect(() => {
    let cancelled = false;
    load()
      .then((text) => {
        if (!cancelled) setState({ key: loadKey, text });
      })
      .catch(() => {
        if (!cancelled) setState({ key: loadKey, failed: true });
      });
    return () => {
      cancelled = true;
    };
    // The key identifies the file; a new load function for the same file is not a new request.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);
  const current = state?.key === loadKey ? state : null;
  const text = current && "text" in current ? current.text : null;
  const check = useMemo(
    () => (text === null ? null : lyricsTimingCheck(text, durationSeconds)),
    [text, durationSeconds],
  );
  const lines = useMemo(() => (text === null ? [] : previewLines(text)), [text]);
  const timing =
    check && !check.exceedsAudio
      ? check.timed
        ? t("lyricsManager.timingOk", { count: check.lineCount, time: formatLyricsTime(check.lastLineSeconds) })
        : t("lyricsManager.untimed")
      : null;
  return (
    <div className="mt-2 overflow-hidden rounded-md border bg-muted/30 text-xs">
      <div className="flex min-w-0 items-center gap-2 border-b bg-muted/50 px-3 py-1.5">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium" title={label}>
          {label}
        </span>
        {timing && <span className="hidden shrink-0 text-muted-foreground sm:inline">{timing}</span>}
      </div>
      <div className="space-y-2 px-3 py-2">
        {!current ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {t("lyricsManager.previewLoading")}
          </p>
        ) : !check ? (
          <p className="text-muted-foreground">{t("lyricsManager.previewFailed")}</p>
        ) : (
          <>
            {check.exceedsAudio ? (
              <p className="flex items-start gap-1.5 rounded border border-warning-border bg-warning-surface px-2 py-1 text-warning-foreground">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                {t("lyricsManager.timingExceeds", {
                  time: formatLyricsTime(check.lastLineSeconds),
                  duration: formatLyricsTime(durationSeconds),
                })}
              </p>
            ) : (
              <p className="text-muted-foreground sm:hidden">{timing}</p>
            )}
            <ol className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              {lines.map((line, index) => (
                <li key={index} className="col-span-2 grid grid-cols-subgrid">
                  <span className="font-mono tabular-nums text-muted-foreground">{line.time}</span>
                  <span className="truncate">{line.text}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}

export function loadLocalLyricsText(locationId: number) {
  return api.getMediaText(locationId).then((result) => result.content);
}

/** Loads a remote tree file through the server's bounded, policy-checked text preview. */
export async function loadRemoteLyricsText(sourceId: number, workCode: string, path: string) {
  const response = await fetch(
    assetURL(
      `/api/remote-sources/${sourceId}/works/${encodeURIComponent(workCode)}/text?path=${encodeURIComponent(path)}`,
    ),
    { headers: { Accept: "text/plain,text/*" } },
  );
  if (!response.ok) throw new Error(`Remote lyrics preview returned HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > maxRemotePreviewCharacters) throw new Error("Remote lyrics are too large to preview.");
  return text;
}

/** The first lines as playback shows them: timed lines with their start, else the raw text. */
function previewLines(text: string): { time: string; text: string }[] {
  const parsed = parseTimedLyrics(text);
  if (parsed.timed) {
    return parsed.lines
      .slice(0, previewLineCount)
      .map((line) => ({ time: formatLyricsTime(line.time), text: line.text }));
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, previewLineCount)
    .map((line) => ({ time: "", text: line }));
}

function formatLyricsTime(seconds: number | null) {
  return formatTrackDuration(seconds) || "0:00";
}
