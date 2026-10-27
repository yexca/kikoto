import { useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Captions, Files, Folder, ListChecks, ListOrdered, RotateCcw, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { FloatingSelect, type FloatingSelectOption } from "@/components/ui/floating-select";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  alignLyricsByOrder,
  draftLyricsMediaItemId,
  effectiveLyricsMediaItemId,
  groupAudioByFolder,
  initialLyricsAssignmentDrafts,
  lyricsAssignmentChanges,
  lyricsFolders,
  lyricsLanguageTrackCounts,
  lyricsManagerEntries,
  rebaseLyricsAssignmentDrafts,
} from "@/features/work-detail/lyrics/lyricsManagerModel";
import { folderLyrics } from "@/features/work-detail/lyrics/lyricsEditModel";
import {
  LyricsAssignmentGroup,
  LyricsAssignmentPanel,
  LyricsAssignmentRow,
  LyricsCoverageBar,
  LyricsLanguageTabs,
} from "@/features/work-detail/lyrics/LyricsAssignments";
import { LyricsFilesWorkspace } from "@/features/work-detail/lyrics/LyricsFilesWorkspace";
import { LyricsNote } from "@/features/work-detail/lyrics/LyricsNote";
import { TranscriptionPanel } from "@/features/work-detail/lyrics/TranscriptionPanel";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { api, type WorkDetail } from "@/lib/api";
import { isLocalOffline } from "@/lib/localAvailability";
import { allLyricsLanguages } from "@/lib/lyricsLanguage";
import { cn } from "@/lib/tailwindClassNames";

/** Wide enough to show the selected track's lyrics beside the list. */
const panelQuery = "(min-width: 1024px)";

export type LyricsManagerTab = "assign" | "files" | "transcribe";

/** What the lyrics manager opens on. */
export type LyricsManagerRequest = {
  tab: LyricsManagerTab;
  /** The local folder whose lyrics files are shown first. */
  folderId?: number;
  /** Opens the files of that folder on its other lyrics, the lyrics Kikoto does not manage yet. */
  folderLyrics?: boolean;
};

/**
 * Lets a library manager choose, per language, the lyrics file every listener
 * uses for each local track. Personal player choices still override these
 * assignments. A manager of local files also edits the lyrics files Kikoto
 * manages in a local folder: which stay, and which come in from the folder,
 * the work's other folders, and remote editions. Demo shows the transcription
 * and translation tabs with samples.
 */
export function LyricsManagerDialog({
  work,
  readOnly,
  canDownload = false,
  canTranscribe = false,
  demo = false,
  request,
  onClose,
  onSaved,
}: {
  work: WorkDetail;
  readOnly: boolean;
  /** Whether the viewer may add, move, and delete files of the library. */
  canDownload?: boolean;
  /** Whether the viewer may start speech transcriptions and review their results. */
  canTranscribe?: boolean;
  /** Shows the transcription and translation tabs with samples and every action off. */
  demo?: boolean;
  request: LyricsManagerRequest;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const entries = useMemo(() => lyricsManagerEntries(work.mediaItems), [work.mediaItems]);
  const folders = useMemo(() => lyricsFolders(entries.lyrics), [entries.lyrics]);
  const lyricsByID = useMemo(() => new Map(entries.lyrics.map((file) => [file.mediaItemId, file])), [entries.lyrics]);
  const [drafts, setDrafts] = useState(() => initialLyricsAssignmentDrafts(entries.audio));
  const [language, setLanguage] = useState<string>(allLyricsLanguages);
  // Lyrics files change only in a folder whose storage pool is online.
  const localFolders = useMemo(
    () =>
      canDownload
        ? (work.localFolders ?? []).filter(
            (folder) => folder.state === "active" && !isLocalOffline(folder.availability),
          )
        : [],
    [canDownload, work.localFolders],
  );
  const filesAvailable = localFolders.length > 0;
  const transcribeAvailable = (canTranscribe || demo) && entries.audio.length > 0;
  const [tab, setTab] = useState<LyricsManagerTab>(request.tab === "files" && filesAvailable ? "files" : "assign");
  const [folderId, setFolderId] = useState(request.folderId ?? 0);
  const folder = localFolders.find((candidate) => candidate.id === folderId) ?? localFolders[0];
  const managedCount = useMemo(
    () => (folder ? folderLyrics(work.mediaItems, folder.rootPath).managed.length : 0),
    [folder, work.mediaItems],
  );
  const [filesBusy, setFilesBusy] = useState(false);
  // A download reloads the work. Keep the user's unsaved edits on the new entries.
  const previousAudio = useRef(entries.audio);
  useEffect(() => {
    if (previousAudio.current === entries.audio) return;
    const previous = previousAudio.current;
    previousAudio.current = entries.audio;
    setDrafts((current) => rebaseLyricsAssignmentDrafts(previous, entries.audio, current));
  }, [entries.audio]);
  const [alignFolder, setAlignFolder] = useState(() => folders[0]?.folder ?? "");
  const [alignMessage, setAlignMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const changes = useMemo(() => lyricsAssignmentChanges(entries.audio, drafts), [entries.audio, drafts]);
  const pendingLanguages = useMemo(() => new Set(changes.map((change) => change.language)), [changes]);
  const languageCounts = useMemo(() => lyricsLanguageTrackCounts(entries.audio, drafts), [entries.audio, drafts]);
  const groups = useMemo(() => groupAudioByFolder(entries.audio), [entries.audio]);
  const hasLyrics = entries.audio.length > 0 && entries.lyrics.length > 0;
  const panel = useMediaQuery(panelQuery) && hasLyrics;
  // Inline, the track whose preview is open; beside the panel, the track it shows.
  const [selectedAudioID, setSelectedAudioID] = useState<number | null>(null);
  const panelEntry = panel
    ? (entries.audio.find((entry) => entry.mediaItemId === selectedAudioID) ?? entries.audio[0] ?? null)
    : null;
  const effectiveLyricsOf = (audioID: number) => {
    const entry = entries.audio.find((candidate) => candidate.mediaItemId === audioID);
    return entry ? (lyricsByID.get(effectiveLyricsMediaItemId(entry, drafts, language) ?? 0) ?? null) : null;
  };
  const covered = useMemo(
    () => entries.audio.filter((entry) => effectiveLyricsMediaItemId(entry, drafts, language) !== null).length,
    [entries.audio, drafts, language],
  );
  const editable = !readOnly && !saving && entries.lyrics.length > 0;
  const busy = saving || filesBusy;
  const pendingChanges = changes.length > 0;

  /** Replaces the selected language's assignments for the given tracks. */
  const assignMany = (assignments: Iterable<[number, number | null]>) =>
    setDrafts((current) => {
      const draft = new Map(current.get(language));
      for (const [audioID, lyricsID] of assignments) draft.set(audioID, lyricsID);
      return new Map(current).set(language, draft);
    });

  const assign = (audioID: number, lyricsID: number | null) => assignMany([[audioID, lyricsID]]);

  const alignByOrder = () => {
    const aligned = alignLyricsByOrder(entries.audio, entries.lyrics, alignFolder);
    if (aligned.size > 0) assignMany(aligned);
    setAlignMessage(
      aligned.size > 0 ? t("lyricsManager.alignResult", { count: aligned.size }) : t("lyricsManager.alignNone"),
    );
  };

  const clearLanguage = () => {
    assignMany(entries.audio.map((entry): [number, null] => [entry.mediaItemId, null]));
    setAlignMessage("");
  };

  const selectLanguage = (value: string) => {
    setLanguage(value);
    setAlignMessage("");
    // The panel keeps its track across languages; an inline preview closes.
    if (!panel) setSelectedAudioID(null);
  };

  const save = async () => {
    if (changes.length === 0 || readOnly) return;
    setSaving(true);
    try {
      await api.setWorkLyricsAssignments(work.id, changes);
      toast.success(t("lyricsManager.saved"));
      await onSaved();
      onClose();
    } catch (error) {
      toast.notify(toastFromError(error, t("lyricsManager.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const folderOptions: FloatingSelectOption[] = folders.map(({ folder, count }) => ({
    value: folder,
    label: (
      <span className="flex min-w-0 items-center justify-between gap-3">
        <span className="truncate">{folder || t("lyricsManager.rootFolder")}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
      </span>
    ),
  }));
  const tabs: LyricsManagerTabItem[] = [
    { value: "assign", icon: ListChecks, label: t("lyricsManager.tabAssign") },
    ...(filesAvailable
      ? [{ value: "files" as const, icon: Files, label: t("lyricsManager.tabFiles"), count: managedCount }]
      : []),
    ...(transcribeAvailable
      ? [{ value: "transcribe" as const, icon: AudioLines, label: t("lyricsManager.tabTranscribe") }]
      : []),
  ];
  const resetLabel =
    language === allLyricsLanguages ? t("lyricsManager.restoreAutomatic") : t("lyricsManager.clearLanguage");
  const coverage = t("lyricsManager.coverage", { count: covered, total: entries.audio.length });

  const list =
    entries.audio.length === 0 ? (
      <LyricsNote icon={<AudioLines aria-hidden="true" />}>{t("lyricsManager.noAudio")}</LyricsNote>
    ) : entries.lyrics.length === 0 ? (
      <LyricsNote icon={<Captions aria-hidden="true" />}>
        {filesAvailable ? t("lyricsManager.noLyricsTryFiles") : t("lyricsManager.noLyrics")}
      </LyricsNote>
    ) : (
      groups.map(([folder, audio]) => (
        <LyricsAssignmentGroup
          key={folder}
          folder={folder}
          covered={audio.filter((entry) => effectiveLyricsMediaItemId(entry, drafts, language) !== null).length}
          total={audio.length}
        >
          {audio.map((entry) => (
            <LyricsAssignmentRow
              key={entry.mediaItemId}
              entry={entry}
              language={language}
              draftValue={draftLyricsMediaItemId(entry, drafts, language)}
              effectiveLyrics={effectiveLyricsOf(entry.mediaItemId)}
              lyrics={entries.lyrics}
              lyricsByID={lyricsByID}
              disabled={!editable}
              layout={panel ? "panel" : "inline"}
              selected={panel ? panelEntry?.mediaItemId === entry.mediaItemId : selectedAudioID === entry.mediaItemId}
              onSelect={(selected) => setSelectedAudioID(selected ? entry.mediaItemId : null)}
              onAssign={(lyricsID) => assign(entry.mediaItemId, lyricsID)}
            />
          ))}
        </LyricsAssignmentGroup>
      ))
    );

  return (
    <Dialog
      onClose={onClose}
      size="full"
      dismissible={!busy}
      marker="lyrics-manager"
      className={cn(
        filesAvailable
          ? "h-[var(--dialog-max-height)] max-w-7xl md:h-[min(90dvh,var(--dialog-max-height))]"
          : cn("max-h-[min(90vh,var(--dialog-max-height))]", panel ? "max-w-6xl" : "max-w-4xl"),
      )}
    >
      <DialogHeader
        title={t("lyricsManager.title")}
        description={t("lyricsManager.description")}
        icon={<Captions className="h-4 w-4" />}
        onClose={busy ? undefined : onClose}
        closeLabel={t("content.close")}
        className={tabs.length > 1 ? "border-b-0 pb-1" : undefined}
      />
      {tabs.length > 1 && (
        <LyricsManagerTabs tabs={tabs} value={tab} label={t("lyricsManager.title")} disabled={busy} onChange={setTab} />
      )}
      {tab === "transcribe" && transcribeAvailable ? (
        <TranscriptionPanel
          work={work}
          audio={entries.audio}
          demo={demo}
          closeDisabled={busy}
          onClose={onClose}
          onPublished={onSaved}
        />
      ) : tab === "files" && folder ? (
        <LyricsFilesWorkspace
          // Each folder is its own edit.
          key={folder.id}
          workId={work.id}
          items={work.mediaItems}
          folder={folder}
          folders={localFolders}
          canAssign={!readOnly}
          startInFolderLyrics={folder.id === request.folderId && Boolean(request.folderLyrics)}
          localOnly={Boolean(work.customWork)}
          onFolderChange={setFolderId}
          onBusyChange={setFilesBusy}
          onApplied={onSaved}
          onClose={onClose}
        />
      ) : (
        <>
          {hasLyrics && (
            <div className="shrink-0 space-y-2.5 border-b bg-muted/20 px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <LyricsLanguageTabs
                  selected={language}
                  counts={languageCounts}
                  pending={pendingLanguages}
                  onSelect={selectLanguage}
                />
                {editable && folders.length > 0 && (
                  <div className="flex min-w-0 flex-1 basis-72 items-center justify-end gap-1">
                    <div className="flex min-w-0 flex-1 items-center sm:max-w-80">
                      <div className="min-w-0 flex-1">
                        <FloatingSelect
                          value={alignFolder}
                          options={folderOptions}
                          onValueChange={(value) => {
                            setAlignFolder(value);
                            setAlignMessage("");
                          }}
                          ariaLabel={t("lyricsManager.alignFrom")}
                          triggerLabel={
                            <span className="flex min-w-0 items-center gap-2">
                              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                              <span className="truncate">{alignFolder || t("lyricsManager.rootFolder")}</span>
                            </span>
                          }
                          className="rounded-r-none focus-visible:relative focus-visible:z-10"
                          contentClassName="min-w-56 max-w-[min(24rem,calc(100vw-1.5rem))]"
                        />
                      </div>
                      <Button
                        variant="outline"
                        className="-ml-px shrink-0 rounded-l-none max-sm:w-[var(--control-height)] max-sm:px-0"
                        aria-label={t("lyricsManager.alignByOrder")}
                        title={t("lyricsManager.alignByOrder")}
                        onClick={alignByOrder}
                      >
                        <ListOrdered className="h-4 w-4" />
                        <span className="hidden sm:inline">{t("lyricsManager.alignByOrder")}</span>
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground"
                      aria-label={resetLabel}
                      title={resetLabel}
                      onClick={clearLanguage}
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <p className="min-w-0 flex-1 basis-80 text-xs text-muted-foreground">
                  {language === allLyricsLanguages ? t("lyricsManager.fallbackHint") : t("lyricsManager.languageHint")}
                </p>
                <p className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <LyricsCoverageBar count={covered} total={entries.audio.length} className="w-24" />
                  <span className="tabular-nums">{coverage}</span>
                </p>
              </div>
              {alignMessage && (
                <p
                  role="status"
                  className="flex items-center gap-1.5 rounded-md bg-info-surface px-2.5 py-1.5 text-xs text-info-foreground"
                >
                  <ListOrdered className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {alignMessage}
                </p>
              )}
            </div>
          )}
          {panel ? (
            <div className="flex min-h-0 flex-1">
              <DialogBody className="min-w-0 space-y-4">
                {readOnly && <p className="text-sm text-muted-foreground">{t("lyricsManager.readOnly")}</p>}
                {list}
              </DialogBody>
              <LyricsAssignmentPanel
                entry={panelEntry}
                language={language}
                draftValue={panelEntry ? draftLyricsMediaItemId(panelEntry, drafts, language) : null}
                effectiveLyrics={panelEntry ? effectiveLyricsOf(panelEntry.mediaItemId) : null}
              />
            </div>
          ) : (
            <DialogBody className="space-y-4">
              {readOnly && <p className="text-sm text-muted-foreground">{t("lyricsManager.readOnly")}</p>}
              {list}
            </DialogBody>
          )}
          <DialogFooter>
            <span
              className={cn(
                "mr-auto flex items-center gap-2 text-xs",
                pendingChanges ? "font-medium text-foreground" : "text-muted-foreground",
              )}
              role="status"
            >
              {pendingChanges && <span className="h-2 w-2 shrink-0 rounded-full bg-info" aria-hidden="true" />}
              {pendingChanges ? t("lyricsManager.pending", { count: changes.length }) : t("lyricsManager.noChanges")}
            </span>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {t("lyricsManager.cancel")}
            </Button>
            {!readOnly && (
              <Button onClick={() => void save()} disabled={busy || changes.length === 0}>
                {saving ? t("lyricsManager.saving") : t("lyricsManager.save")}
              </Button>
            )}
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}

type LyricsManagerTabItem = { value: LyricsManagerTab; icon: LucideIcon; label: string; count?: number };

/** The manager's sections, as an underlined strip below its header. */
function LyricsManagerTabs({
  tabs,
  value,
  label,
  disabled,
  onChange,
}: {
  tabs: readonly LyricsManagerTabItem[];
  value: LyricsManagerTab;
  label: string;
  disabled: boolean;
  onChange: (tab: LyricsManagerTab) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex shrink-0 gap-1 overflow-x-auto overflow-y-hidden border-b px-2 ![scrollbar-width:none] sm:px-3 [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map(({ value: tabValue, icon: Icon, label: tabLabel, count = 0 }) => {
        const active = tabValue === value;
        return (
          <button
            key={tabValue}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(tabValue)}
            className={cn(
              "relative inline-flex h-11 shrink-0 items-center gap-2 rounded-t-md px-3 text-sm font-medium transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
              active
                ? "text-foreground after:bg-primary"
                : "text-muted-foreground after:bg-transparent hover:text-foreground",
            )}
          >
            <Icon className={cn("h-4 w-4 shrink-0", active && "text-primary")} aria-hidden="true" />
            {tabLabel}
            {count > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-px text-2xs tabular-nums text-muted-foreground">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
