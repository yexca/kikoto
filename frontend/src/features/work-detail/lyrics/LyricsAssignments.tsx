import type { MouseEvent, ReactNode } from "react";
import { CheckCircle2, CircleDashed, Eye, FileText, Folder, Languages, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FloatingSelect, type FloatingSelectOption } from "@/components/ui/floating-select";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import {
  storedLyricsMediaItemId,
  type LyricsManagerAudio,
  type LyricsManagerFile,
} from "@/features/work-detail/lyrics/lyricsManagerModel";
import { LyricsNote } from "@/features/work-detail/lyrics/LyricsNote";
import { LyricsPreview, loadLocalLyricsText } from "@/features/work-detail/lyrics/LyricsPreview";
import { formatTrackDuration } from "@/features/work-detail/media/mediaTreeModel";
import { allLyricsLanguages, lyricsLanguages } from "@/lib/lyricsLanguage";
import { cn } from "@/lib/tailwindClassNames";

const automaticValue = "auto";

/** Where a track's lyrics in one language come from. */
export type LyricsAssignmentState = "changed" | "assigned" | "automatic" | "none";

export function lyricsAssignmentState(
  entry: LyricsManagerAudio,
  language: string,
  draftValue: number | null,
  effectiveLyrics: LyricsManagerFile | null,
): LyricsAssignmentState {
  if (draftValue !== storedLyricsMediaItemId(entry, language)) return "changed";
  if (draftValue !== null) return "assigned";
  return effectiveLyrics ? "automatic" : "none";
}

/** The language strip: every language, then each language lyrics can declare, with its track count. */
export function LyricsLanguageTabs({
  selected,
  counts,
  pending,
  onSelect,
}: {
  selected: string;
  counts: ReadonlyMap<string, number>;
  /** Languages with unsaved changes. */
  pending: ReadonlySet<string>;
  onSelect: (language: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 max-w-full items-center gap-2">
      <Languages className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
      <div
        role="tablist"
        aria-label={t("lyricsManager.language")}
        className={segmentedListClassName("![scrollbar-width:none] [&::-webkit-scrollbar]:hidden")}
      >
        {lyricsLanguages.map(([language, labelKey]) => {
          const active = language === selected;
          const count = counts.get(language) ?? 0;
          const changed = pending.has(language);
          return (
            <button
              key={language || "all"}
              type="button"
              role="tab"
              aria-selected={active}
              className={segmentedItemClassName(active, "relative h-9 gap-1.5 sm:h-8")}
              onClick={() => onSelect(language)}
            >
              {t(labelKey)}
              {count > 0 && (
                <span
                  className={cn(
                    "min-w-[1.125rem] rounded-full px-1 text-center text-2xs tabular-nums",
                    active ? "bg-primary/10 text-primary" : "bg-background/70 text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              )}
              {changed && (
                <>
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-info" aria-hidden="true" />
                  <span className="sr-only">{t("lyricsManager.changed")}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** How many tracks have lyrics, as a short bar beside its count. */
export function LyricsCoverageBar({ count, total, className }: { count: number; total: number; className?: string }) {
  const ratio = total > 0 ? count / total : 0;
  return (
    <span className={cn("block h-1.5 overflow-hidden rounded-full bg-muted", className)} aria-hidden="true">
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
          ratio >= 1 ? "bg-success" : "bg-primary/70",
        )}
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </span>
  );
}

/** A folder of tracks with its coverage in the selected language. */
export function LyricsAssignmentGroup({
  folder,
  covered,
  total,
  children,
}: {
  folder: string;
  covered: number;
  total: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const name = folder || t("lyricsManager.rootFolder");
  const coverage = t("lyricsManager.groupCoverage", { count: covered, total });
  return (
    <section aria-label={name} className="rounded-lg border bg-card">
      <h4 className="sticky top-0 z-10 flex items-center gap-2 rounded-t-lg border-b bg-card/95 px-3 py-2 text-xs font-medium text-muted-foreground backdrop-blur-sm sm:px-4">
        <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate text-foreground">{name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2" title={coverage}>
          <LyricsCoverageBar count={covered} total={total} className="w-16" />
          <span className="tabular-nums" aria-hidden="true">
            {covered}/{total}
          </span>
          <span className="sr-only">{coverage}</span>
        </span>
      </h4>
      <ul className="divide-y">{children}</ul>
    </section>
  );
}

/**
 * One track and its lyrics in the selected language. Inline, its preview opens
 * below the row; beside a panel, the row selects the track the panel shows.
 */
export function LyricsAssignmentRow({
  entry,
  language,
  draftValue,
  effectiveLyrics,
  lyrics,
  lyricsByID,
  disabled,
  layout,
  selected,
  onSelect,
  onAssign,
}: {
  entry: LyricsManagerAudio;
  language: string;
  draftValue: number | null;
  effectiveLyrics: LyricsManagerFile | null;
  lyrics: LyricsManagerFile[];
  lyricsByID: ReadonlyMap<number, LyricsManagerFile>;
  disabled: boolean;
  layout: "inline" | "panel";
  /** Inline: the preview is open. Panel: the panel shows this track. */
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onAssign: (lyricsID: number | null) => void;
}) {
  const { t } = useTranslation();
  const automatic = entry.autoLyricsMediaItemId ? lyricsByID.get(entry.autoLyricsMediaItemId) : undefined;
  // Only the every-language row falls back to a name match; a language without
  // lyrics leaves the choice to the other languages.
  const automaticApplies = language === allLyricsLanguages;
  const unassignedLabel = !automaticApplies
    ? t("lyricsManager.languageUnset")
    : automatic
      ? t("lyricsManager.automaticMatch", { title: automatic.title })
      : t("lyricsManager.automaticNone");
  const options: FloatingSelectOption[] = [
    {
      value: automaticValue,
      label: <UnassignedLabel automatic={automaticApplies}>{unassignedLabel}</UnassignedLabel>,
    },
    ...lyrics.map((file) => ({
      value: String(file.mediaItemId),
      label: <LyricsFileLabel file={file} />,
    })),
  ];
  const selectedFile = draftValue === null ? undefined : lyricsByID.get(draftValue);
  const state = lyricsAssignmentState(entry, language, draftValue, effectiveLyrics);
  const duration = formatTrackDuration(entry.durationSeconds);
  const previewLabel = t("lyricsManager.previewOf", { title: entry.title });
  const panel = layout === "panel";
  // Beside the panel, working on a row shows it there; its own buttons and the picker still work.
  const selectRow =
    panel && !selected ? (event: MouseEvent) => (event.defaultPrevented ? undefined : onSelect(true)) : undefined;
  return (
    <li
      className={cn(
        "relative px-3 py-2.5 transition-colors sm:px-4",
        panel && "cursor-default",
        panel && selected
          ? "bg-primary/[0.06]"
          : state === "changed"
            ? "bg-info-surface/40"
            : panel && "hover:bg-muted/40",
      )}
      onClick={selectRow}
    >
      {(state === "changed" || (panel && selected)) && (
        <span
          className={cn("absolute inset-y-0 left-0 w-0.5", state === "changed" ? "bg-info" : "bg-primary")}
          aria-hidden="true"
        />
      )}
      <div className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[1rem_minmax(0,1fr)_minmax(0,20rem)_auto]">
        {effectiveLyrics ? (
          <CheckCircle2
            className={cn("h-4 w-4", state === "automatic" ? "text-success/60" : "text-success")}
            aria-hidden="true"
          />
        ) : (
          <CircleDashed className="h-4 w-4 text-muted-foreground/60" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" title={entry.path}>
            {entry.title}
          </div>
          <div className="mt-0.5 flex min-h-4 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {duration && <span className="tabular-nums">{duration}</span>}
            <LyricsStateBadge state={state} />
          </div>
        </div>
        <div className="col-span-2 col-start-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-auto sm:row-start-auto">
          <FloatingSelect
            value={draftValue === null ? automaticValue : String(draftValue)}
            options={options}
            onValueChange={(value) => {
              onAssign(value === automaticValue ? null : Number(value));
              if (panel) onSelect(true);
            }}
            ariaLabel={t("lyricsManager.lyricsFor", { title: entry.title })}
            triggerLabel={
              selectedFile ? (
                <LyricsFileLabel file={selectedFile} inline />
              ) : automaticApplies && automatic ? (
                <UnassignedLabel automatic>{automatic.title}</UnassignedLabel>
              ) : (
                <UnassignedLabel automatic={automaticApplies}>{unassignedLabel}</UnassignedLabel>
              )
            }
            disabled={disabled}
            // A dashed field holds no choice of its own: a name match or nothing.
            className={cn(!selectedFile && "border-dashed bg-transparent")}
            contentClassName="max-w-[min(32rem,calc(100vw-1.5rem))]"
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="col-start-3 row-start-1 text-muted-foreground aria-expanded:bg-muted aria-expanded:text-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary sm:col-start-auto sm:row-start-auto"
          aria-expanded={panel ? undefined : selected}
          aria-pressed={panel ? selected : undefined}
          aria-label={previewLabel}
          title={previewLabel}
          disabled={!effectiveLyrics}
          onClick={(event) => {
            event.preventDefault();
            onSelect(panel || !selected);
          }}
        >
          <Eye className="h-4 w-4" />
        </Button>
      </div>
      {!panel && selected && effectiveLyrics && (
        <div className="sm:pl-7">
          <LyricsPreview
            label={effectiveLyrics.path}
            loadKey={`local:${effectiveLyrics.locationId}`}
            load={() => loadLocalLyricsText(effectiveLyrics.locationId)}
            durationSeconds={entry.durationSeconds}
          />
        </div>
      )}
    </li>
  );
}

/**
 * The selected track beside the list on wide screens: where its lyrics come
 * from in the selected language, and their timed lines against its length.
 */
export function LyricsAssignmentPanel({
  entry,
  language,
  draftValue,
  effectiveLyrics,
}: {
  entry: LyricsManagerAudio | null;
  language: string;
  draftValue: number | null;
  effectiveLyrics: LyricsManagerFile | null;
}) {
  const { t } = useTranslation();
  const duration = entry ? formatTrackDuration(entry.durationSeconds) : "";
  const state = entry ? lyricsAssignmentState(entry, language, draftValue, effectiveLyrics) : "none";
  return (
    <aside
      aria-label={t("lyricsManager.preview")}
      className="flex w-[22rem] shrink-0 flex-col border-l bg-muted/25 xl:w-[26rem]"
    >
      {entry && (
        <div className="shrink-0 space-y-3 border-b px-5 py-4">
          <div className="min-w-0">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("lyricsManager.track")}
            </p>
            <h3 className="mt-1 truncate text-sm font-semibold" title={entry.path}>
              {entry.title}
            </h3>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{entry.folder || t("lyricsManager.rootFolder")}</span>
              {duration && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0 tabular-nums">{duration}</span>
                </>
              )}
            </p>
          </div>
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("lyricsManager.lyrics")}
              <LyricsStateBadge state={state} />
            </div>
            {effectiveLyrics ? (
              <div
                className={cn(
                  "mt-1.5 flex min-w-0 items-start gap-2.5 rounded-md border bg-card px-3 py-2",
                  state === "automatic" && "border-dashed",
                )}
              >
                {state === "automatic" ? (
                  <Wand2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <span className="flex min-w-0 flex-col" title={effectiveLyrics.path}>
                  <span className="truncate text-sm">{effectiveLyrics.title}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {effectiveLyrics.folder || t("lyricsManager.rootFolder")}
                  </span>
                </span>
              </div>
            ) : (
              <p className="mt-1.5 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                {language === allLyricsLanguages ? t("lyricsManager.automaticNone") : t("lyricsManager.languageUnset")}
              </p>
            )}
          </div>
        </div>
      )}
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
        {entry && effectiveLyrics ? (
          <LyricsPreview
            variant="panel"
            label={effectiveLyrics.path}
            loadKey={`local:${effectiveLyrics.locationId}`}
            load={() => loadLocalLyricsText(effectiveLyrics.locationId)}
            durationSeconds={entry.durationSeconds}
          />
        ) : (
          <LyricsNote icon={<Eye aria-hidden="true" />}>{t("lyricsManager.panelEmpty")}</LyricsNote>
        )}
      </div>
    </aside>
  );
}

function LyricsStateBadge({ state }: { state: LyricsAssignmentState }) {
  const { t } = useTranslation();
  switch (state) {
    case "changed":
      return (
        <Badge variant="info" className="px-1.5 py-0 text-2xs normal-case tracking-normal">
          {t("lyricsManager.changed")}
        </Badge>
      );
    case "assigned":
      return (
        <Badge variant="outline" className="px-1.5 py-0 text-2xs normal-case tracking-normal text-muted-foreground">
          {t("lyricsManager.assigned")}
        </Badge>
      );
    case "automatic":
      return (
        <span className="inline-flex items-center gap-1 text-2xs normal-case tracking-normal text-muted-foreground">
          <Wand2 className="h-3 w-3" aria-hidden="true" />
          {t("lyricsManager.automatic")}
        </span>
      );
    default:
      return null;
  }
}

/** A lyrics file as a choice: its name, then the folder it is in. */
function LyricsFileLabel({ file, inline = false }: { file: LyricsManagerFile; inline?: boolean }) {
  if (inline) {
    return (
      <span className="flex min-w-0 items-center gap-2" title={file.path}>
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{file.title}</span>
        {file.folder && (
          <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{file.folder}</span>
        )}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col" title={file.path}>
      <span className="truncate">{file.title}</span>
      {file.folder && <span className="truncate text-xs text-muted-foreground">{file.folder}</span>}
    </span>
  );
}

/** The choice that leaves a track unassigned: a name match for every language, otherwise nothing. */
function UnassignedLabel({ automatic, children }: { automatic: boolean; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
      {automatic && <Wand2 className="h-4 w-4 shrink-0" aria-hidden="true" />}
      <span className="truncate">{children}</span>
    </span>
  );
}
