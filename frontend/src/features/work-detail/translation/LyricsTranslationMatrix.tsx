import { ArrowRight, Check, Cloud, FileText, Folder, Loader2, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Checkbox } from "@/components/ui/checkbox";
import type { LyricsManagerAudio } from "@/features/work-detail/lyrics/lyricsManagerModel";
import { groupAudioByFolder } from "@/features/work-detail/lyrics/lyricsManagerModel";
import type { TranslationSourceFile } from "@/features/work-detail/lyrics/lyricsTaskModel";
import type { TranslationItemState } from "@/lib/translationApi";
import { allLyricsLanguages, lyricsLanguages } from "@/lib/lyricsLanguage";
import { cn } from "@/lib/tailwindClassNames";
import {
  canTranslateLyrics,
  chooseLyricsSource,
  lyricsCellKey,
  lyricsCellOpen,
  lyricsLanguageChoice,
  lyricsTrackChoice,
  toggleLyricsCell,
  toggleLyricsLanguage,
  toggleLyricsTrack,
  type LyricsCellContext,
  type LyricsChoice,
  type LyricsPlan,
  type PlanTrack,
} from "./translateWithAIModel";

const reviewStates: ReadonlySet<TranslationItemState> = new Set(["ready"]);

/**
 * Each local track's lyrics per language and the part they play in a
 * request: a track translates the chosen target languages from one of its
 * lyrics files, and a track without lyrics says it has none. The head of a
 * target language chooses it for every track that can create it, and the
 * head of a track every target language it can create. A missing target the
 * model cannot translate shows ×.
 */
export function LyricsTranslationMatrix({
  audio,
  tracks,
  sourceFiles,
  targetLanguages,
  context,
  disabled,
  onPlanChange,
}: {
  audio: readonly LyricsManagerAudio[];
  tracks: readonly PlanTrack[];
  sourceFiles: ReadonlyMap<number, TranslationSourceFile>;
  /** The languages the request translates into. */
  targetLanguages: readonly string[];
  context: LyricsCellContext;
  disabled: boolean;
  onPlanChange: (plan: LyricsPlan) => void;
}) {
  const { t } = useTranslation();
  const { plan, active, origin } = context;
  const trackByID = new Map(tracks.map((track) => [track.audioId, track]));
  const groups = groupAudioByFolder([...audio]);
  const columns = lyricsLanguages;
  return (
    <div className="space-y-2">
      <MatrixLegend />
      <div className="app-scrollbar overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
              <th scope="col" className="sticky left-0 z-10 bg-muted px-3 py-2 text-left font-medium sm:px-4">
                {t("lyricsTranslation.audioFile")}
              </th>
              {columns.map(([language, labelKey]) => (
                <th key={language || "fallback"} scope="col" className="w-20 px-1 py-1.5 text-center font-medium">
                  <span className="flex flex-col items-center gap-0.5 px-1 py-1 leading-tight">
                    <span>{t(labelKey)}</span>
                    {language === origin && language !== allLyricsLanguages && (
                      <span className="text-2xs font-normal text-info-foreground">{t("lyricsManager.original")}</span>
                    )}
                    <HeadChoice
                      choice={
                        targetLanguages.includes(language) ? lyricsLanguageChoice(tracks, language, context) : null
                      }
                      label={t("aiTranslation.lyricsAllTracks", { language: t(labelKey) })}
                      disabled={disabled}
                      onToggle={() => onPlanChange(toggleLyricsLanguage(tracks, language, context))}
                    />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          {groups.map(([folder, entries]) => (
            <tbody key={folder} className="border-b last:border-b-0">
              {groups.length > 1 && (
                <tr className="bg-muted/20">
                  <th
                    scope="colgroup"
                    colSpan={columns.length + 1}
                    className="px-3 py-1.5 text-left text-xs font-normal text-muted-foreground sm:px-4"
                  >
                    <span className="flex items-center gap-2">
                      <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{folder || t("lyricsManager.rootFolder")}</span>
                    </span>
                  </th>
                </tr>
              )}
              {entries.map((entry) => {
                const track = trackByID.get(entry.mediaItemId);
                if (!track) return null;
                const row = plan.selection.get(track.audioId);
                const noLyrics = track.lyrics.size === 0;
                return (
                  <tr key={track.audioId} className={cn("border-t first:border-t-0", row && "bg-primary/5")}>
                    <th
                      scope="row"
                      className="sticky left-0 z-10 max-w-[9rem] bg-card px-3 py-1.5 text-left font-normal sm:max-w-xs sm:px-4"
                    >
                      <span className="flex items-center gap-2">
                        <HeadChoice
                          choice={lyricsTrackChoice(track, targetLanguages, context)}
                          label={t("aiTranslation.lyricsAllLanguages", { track: entry.title })}
                          disabled={disabled}
                          onToggle={() => onPlanChange(toggleLyricsTrack(track, targetLanguages, context))}
                        />
                        <span className="min-w-0 truncate" title={entry.path}>
                          {entry.title}
                        </span>
                      </span>
                      {noLyrics && (
                        <span className="block text-xs text-error-foreground">{t("aiTranslation.trackNoLyrics")}</span>
                      )}
                    </th>
                    {columns.map(([language, labelKey]) => {
                      const lyricsID = track.lyrics.get(language);
                      const state = active.get(lyricsCellKey(track.audioId, language));
                      const target = language !== allLyricsLanguages && targetLanguages.includes(language);
                      const file = lyricsID === undefined ? undefined : sourceFiles.get(lyricsID);
                      return (
                        <td key={language || "fallback"} className="px-1 py-1">
                          <MatrixCell
                            track={entry.title}
                            language={t(labelKey)}
                            has={lyricsID !== undefined}
                            remoteSource={file?.remote ? file.sourceName : null}
                            source={row?.source === language}
                            canBeSource={row !== undefined && lyricsID !== undefined}
                            target={row?.targets.has(language) ?? false}
                            canBeTarget={target && lyricsCellOpen(track, language, context)}
                            unavailable={
                              target &&
                              canTranslateLyrics(track, language, active) &&
                              !lyricsCellOpen(track, language, context)
                            }
                            state={state ?? null}
                            disabled={disabled}
                            onToggleTarget={() => onPlanChange(toggleLyricsCell(track, language, context))}
                            onChooseSource={() => onPlanChange(chooseLyricsSource(plan, track, language))}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}

/** One track's lyrics in one language, and the part it plays in the request. */
function MatrixCell({
  track,
  language,
  has,
  remoteSource,
  source,
  canBeSource,
  target,
  canBeTarget,
  unavailable,
  state,
  disabled,
  onToggleTarget,
  onChooseSource,
}: {
  track: string;
  language: string;
  has: boolean;
  /** The remote source the lyrics are read from, when the work has no local copy. */
  remoteSource: string | null;
  source: boolean;
  canBeSource: boolean;
  target: boolean;
  canBeTarget: boolean;
  /** Whether the model cannot translate this missing target from the lyrics the track reads. */
  unavailable: boolean;
  state: TranslationItemState | null;
  disabled: boolean;
  onToggleTarget: () => void;
  onChooseSource: () => void;
}) {
  const { t } = useTranslation();
  const base =
    "relative mx-auto flex h-8 w-full min-w-[4rem] items-center justify-center gap-1 rounded-md border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default";
  if (has) {
    const title = [
      t(
        source
          ? "lyricsTranslation.cellSource"
          : canBeSource
            ? "lyricsTranslation.cellUseSource"
            : "lyricsTranslation.cellHas",
        {
          track,
          language,
        },
      ),
      remoteSource !== null ? t("lyricsTranslation.cellRemote", { source: remoteSource }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <button
        type="button"
        aria-pressed={canBeSource ? source : undefined}
        aria-label={title}
        title={title}
        disabled={disabled || !canBeSource || source}
        onClick={onChooseSource}
        className={cn(
          base,
          source
            ? "border-info-border bg-info-surface text-info-foreground ring-2 ring-info/40"
            : "border-success-border bg-success-surface text-success-foreground",
          canBeSource && !source && "hover:ring-2 hover:ring-info/30",
        )}
      >
        {source ? (
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {source && <span>{t("lyricsTranslation.sourceShort")}</span>}
        {remoteSource !== null && <Cloud className="h-3 w-3 opacity-80" aria-hidden="true" />}
      </button>
    );
  }
  if (state) {
    const reviewing = reviewStates.has(state);
    const label = t(`translationReview.states.${state}`);
    return (
      <span
        className={cn(
          base,
          reviewing
            ? "border-warning-border bg-warning-surface text-warning-foreground"
            : "border-info-border bg-info-surface text-info-foreground",
        )}
        title={`${language} · ${label}`}
      >
        {reviewing ? (
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        )}
        <span className="sr-only">{`${track} · ${language} · ${label}`}</span>
      </span>
    );
  }
  if (unavailable) {
    return (
      <span className={cn(base, "border-transparent")}>
        <UnavailableMark label={`${track} · ${language}`} />
      </span>
    );
  }
  const label = t("lyricsTranslation.cellTarget", { track, language });
  return (
    <button
      type="button"
      aria-pressed={target}
      aria-label={label}
      title={canBeTarget ? label : t("lyricsTranslation.cellMissing", { track, language })}
      disabled={disabled || !canBeTarget}
      onClick={onToggleTarget}
      className={cn(
        base,
        target
          ? "border-primary bg-primary text-primary-foreground shadow-sm"
          : "border-error-border bg-error-surface text-error-foreground",
        canBeTarget && !target && "hover:ring-2 hover:ring-primary/40",
        !canBeTarget && "opacity-60",
      )}
    >
      {target ? <Plus className="h-3.5 w-3.5" aria-hidden="true" /> : <X className="h-3.5 w-3.5" aria-hidden="true" />}
      {target && <span>{t("lyricsTranslation.targetShort")}</span>}
    </button>
  );
}

/** Marks what the chosen model cannot translate. */
export function UnavailableMark({ label }: { label?: string }) {
  const { t } = useTranslation();
  const reason = t("aiTranslation.modelCannotTranslate");
  return (
    <span className="text-sm leading-none text-muted-foreground" title={reason}>
      <span aria-hidden="true">×</span>
      <span className="sr-only">{label ? `${label} · ${reason}` : reason}</span>
    </span>
  );
}

/** Chooses every open cell of a target language or of a track. */
function HeadChoice({
  choice,
  label,
  disabled,
  onToggle,
}: {
  choice: LyricsChoice;
  label: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  if (choice === null) return null;
  return (
    <Checkbox
      className="mt-0.5 h-4 w-4"
      checked={choice === "all"}
      indeterminate={choice === "some"}
      disabled={disabled}
      aria-label={label}
      title={label}
      onCheckedChange={onToggle}
    />
  );
}

/** The colors of the matrix. */
function MatrixLegend() {
  const { t } = useTranslation();
  const items = [
    ["border-success-border bg-success-surface", t("lyricsTranslation.legendHas")],
    ["border-error-border bg-error-surface", t("lyricsTranslation.legendMissing")],
    ["border-info-border bg-info-surface", t("lyricsTranslation.legendSource")],
    ["border-primary bg-primary", t("lyricsTranslation.legendTarget")],
  ] as const;
  return (
    <ul
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
      aria-label={t("lyricsTranslation.legend")}
    >
      {items.map(([swatch, label]) => (
        <li key={label} className="flex items-center gap-1.5">
          <span className={cn("h-3 w-3 shrink-0 rounded-sm border", swatch)} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}
