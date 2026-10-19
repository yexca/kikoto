import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AudioLines,
  Captions,
  CheckCircle2,
  CircleDashed,
  Eye,
  FileText,
  Files,
  Folder,
  Languages,
  ListChecks,
  ListOrdered,
  RotateCcw,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { FloatingSelect, type FloatingSelectOption } from "@/components/ui/floating-select";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
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
  storedLyricsMediaItemId,
  type LyricsManagerAudio,
  type LyricsManagerFile,
} from "@/features/work-detail/lyrics/lyricsManagerModel";
import { folderLyrics } from "@/features/work-detail/lyrics/lyricsEditModel";
import { LyricsFilesWorkspace } from "@/features/work-detail/lyrics/LyricsFilesWorkspace";
import { LyricsNote } from "@/features/work-detail/lyrics/LyricsNote";
import { LyricsPreview, loadLocalLyricsText } from "@/features/work-detail/lyrics/LyricsPreview";
import { LyricsTranslationPanel } from "@/features/work-detail/lyrics/LyricsTranslationPanel";
import { TranscriptionPanel } from "@/features/work-detail/lyrics/TranscriptionPanel";
import { formatTrackDuration } from "@/features/work-detail/media/mediaTreeModel";
import { api, type WorkDetail } from "@/lib/api";
import { isLocalOffline } from "@/lib/localAvailability";
import { allLyricsLanguages, lyricsLanguages } from "@/lib/lyricsLanguage";
import { cn } from "@/lib/tailwindClassNames";

const automaticValue = "auto";

export type LyricsManagerTab = "assign" | "files" | "transcribe" | "translate";

/** What the lyrics manager opens on. */
export type LyricsManagerRequest = {
  tab: LyricsManagerTab;
  /** The local folder whose lyrics files are shown first. */
  folderId?: number;
  /** Lyrics files of that folder to start with selected, by their path below it. */
  paths?: string[];
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
  canTranslate = false,
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
  /** Whether the viewer may start LLM lyrics translations and review their results. */
  canTranslate?: boolean;
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
  const translateAvailable = (canTranslate || demo) && entries.audio.length > 0;
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
  const [previewAudioID, setPreviewAudioID] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const changes = useMemo(() => lyricsAssignmentChanges(entries.audio, drafts), [entries.audio, drafts]);
  const languageCounts = useMemo(() => lyricsLanguageTrackCounts(entries.audio, drafts), [entries.audio, drafts]);
  const groups = useMemo(() => groupAudioByFolder(entries.audio), [entries.audio]);
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
    setPreviewAudioID(null);
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
    ...(translateAvailable
      ? [{ value: "translate" as const, icon: Languages, label: t("lyricsManager.tabTranslate") }]
      : []),
  ];

  return (
    <Dialog
      onClose={onClose}
      size="full"
      dismissible={!busy}
      marker="lyrics-manager"
      className={cn(
        filesAvailable
          ? "h-[var(--dialog-max-height)] max-w-7xl md:h-[min(90dvh,var(--dialog-max-height))]"
          : "max-h-[min(90vh,var(--dialog-max-height))] max-w-4xl",
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
      ) : tab === "translate" && translateAvailable ? (
        <LyricsTranslationPanel
          work={work}
          audio={entries.audio}
          lyrics={entries.lyrics}
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
          initialPaths={folder.id === request.folderId ? request.paths : undefined}
          localOnly={Boolean(work.customWork)}
          onFolderChange={setFolderId}
          onBusyChange={setFilesBusy}
          onApplied={onSaved}
          onClose={onClose}
        />
      ) : (
        <>
          {entries.audio.length > 0 && entries.lyrics.length > 0 && (
            <div className="shrink-0 space-y-2 border-b px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <LyricsLanguageTabs selected={language} counts={languageCounts} onSelect={selectLanguage} />
                {editable && folders.length > 0 && (
                  <div className="flex min-w-0 flex-1 items-center justify-end gap-2 basis-72">
                    <div className="min-w-0 flex-1 sm:max-w-56">
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
                        contentClassName="min-w-56 max-w-[min(24rem,calc(100vw-1.5rem))]"
                      />
                    </div>
                    <Button
                      variant="outline"
                      className="shrink-0 max-sm:w-[var(--control-height)] max-sm:px-0"
                      aria-label={t("lyricsManager.alignByOrder")}
                      title={t("lyricsManager.alignByOrder")}
                      onClick={alignByOrder}
                    >
                      <ListOrdered className="h-4 w-4" />
                      <span className="hidden sm:inline">{t("lyricsManager.alignByOrder")}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground"
                      aria-label={
                        language === allLyricsLanguages
                          ? t("lyricsManager.restoreAutomatic")
                          : t("lyricsManager.clearLanguage")
                      }
                      title={
                        language === allLyricsLanguages
                          ? t("lyricsManager.restoreAutomatic")
                          : t("lyricsManager.clearLanguage")
                      }
                      onClick={clearLanguage}
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {language === allLyricsLanguages ? t("lyricsManager.fallbackHint") : t("lyricsManager.languageHint")}
              </p>
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
          <DialogBody className="space-y-5">
            {readOnly && <p className="text-sm text-muted-foreground">{t("lyricsManager.readOnly")}</p>}
            {entries.audio.length === 0 ? (
              <LyricsNote icon={<AudioLines aria-hidden="true" />}>{t("lyricsManager.noAudio")}</LyricsNote>
            ) : entries.lyrics.length === 0 ? (
              <LyricsNote icon={<Captions aria-hidden="true" />}>
                {filesAvailable ? t("lyricsManager.noLyricsTryFiles") : t("lyricsManager.noLyrics")}
              </LyricsNote>
            ) : (
              groups.map(([folder, audio]) => {
                const covered = audio.filter(
                  (entry) => effectiveLyricsMediaItemId(entry, drafts, language) !== null,
                ).length;
                return (
                  <section
                    key={folder}
                    aria-label={folder || t("lyricsManager.rootFolder")}
                    className="overflow-hidden rounded-lg border bg-card"
                  >
                    <h4 className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground sm:px-4">
                      <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 truncate text-foreground">
                        {folder || t("lyricsManager.rootFolder")}
                      </span>
                      <span
                        className="ml-auto shrink-0 tabular-nums"
                        title={t("lyricsManager.groupCoverage", { count: covered, total: audio.length })}
                      >
                        <span aria-hidden="true">
                          {covered}/{audio.length}
                        </span>
                        <span className="sr-only">
                          {t("lyricsManager.groupCoverage", { count: covered, total: audio.length })}
                        </span>
                      </span>
                    </h4>
                    <ul className="divide-y">
                      {audio.map((entry) => (
                        <LyricsAssignmentRow
                          key={entry.mediaItemId}
                          entry={entry}
                          language={language}
                          draftValue={draftLyricsMediaItemId(entry, drafts, language)}
                          effectiveLyrics={
                            lyricsByID.get(effectiveLyricsMediaItemId(entry, drafts, language) ?? 0) ?? null
                          }
                          lyrics={entries.lyrics}
                          lyricsByID={lyricsByID}
                          disabled={!editable}
                          previewOpen={previewAudioID === entry.mediaItemId}
                          onAssign={(lyricsID) => assign(entry.mediaItemId, lyricsID)}
                          onTogglePreview={() =>
                            setPreviewAudioID((current) => (current === entry.mediaItemId ? null : entry.mediaItemId))
                          }
                        />
                      ))}
                    </ul>
                  </section>
                );
              })
            )}
          </DialogBody>
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

/** The language strip: every language, then each language lyrics can declare, with its track count. */
function LyricsLanguageTabs({
  selected,
  counts,
  onSelect,
}: {
  selected: string;
  counts: ReadonlyMap<string, number>;
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
          return (
            <button
              key={language || "all"}
              type="button"
              role="tab"
              aria-selected={active}
              className={segmentedItemClassName(active, "h-9 gap-1.5 sm:h-8")}
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
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LyricsAssignmentRow({
  entry,
  language,
  draftValue,
  effectiveLyrics,
  lyrics,
  lyricsByID,
  disabled,
  previewOpen,
  onAssign,
  onTogglePreview,
}: {
  entry: LyricsManagerAudio;
  language: string;
  draftValue: number | null;
  effectiveLyrics: LyricsManagerFile | null;
  lyrics: LyricsManagerFile[];
  lyricsByID: ReadonlyMap<number, LyricsManagerFile>;
  disabled: boolean;
  previewOpen: boolean;
  onAssign: (lyricsID: number | null) => void;
  onTogglePreview: () => void;
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
  const changed = draftValue !== storedLyricsMediaItemId(entry, language);
  const duration = formatTrackDuration(entry.durationSeconds);
  const previewLabel = t("lyricsManager.previewOf", { title: entry.title });
  return (
    <li className={cn("relative px-3 py-2.5 sm:px-4", changed && "bg-info-surface/40")}>
      {changed && <span className="absolute inset-y-0 left-0 w-0.5 bg-info" aria-hidden="true" />}
      <div className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 sm:grid-cols-[1rem_minmax(0,1fr)_minmax(0,22rem)_auto]">
        {effectiveLyrics ? (
          <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
        ) : (
          <CircleDashed className="h-4 w-4 text-muted-foreground/60" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" title={entry.path}>
            {entry.title}
          </div>
          <div className="mt-0.5 flex min-h-4 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {duration && <span className="tabular-nums">{duration}</span>}
            {changed ? (
              <Badge variant="info" className="px-1.5 py-0 text-2xs">
                {t("lyricsManager.changed")}
              </Badge>
            ) : draftValue !== null ? (
              <Badge variant="outline" className="px-1.5 py-0 text-2xs text-muted-foreground">
                {t("lyricsManager.assigned")}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="col-span-2 col-start-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-auto sm:row-start-auto">
          <FloatingSelect
            value={draftValue === null ? automaticValue : String(draftValue)}
            options={options}
            onValueChange={(value) => onAssign(value === automaticValue ? null : Number(value))}
            ariaLabel={t("lyricsManager.lyricsFor", { title: entry.title })}
            triggerLabel={
              selectedFile ? (
                <LyricsFileLabel file={selectedFile} inline />
              ) : (
                <UnassignedLabel automatic={automaticApplies}>{unassignedLabel}</UnassignedLabel>
              )
            }
            disabled={disabled}
            contentClassName="max-w-[min(32rem,calc(100vw-1.5rem))]"
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="col-start-3 row-start-1 text-muted-foreground aria-expanded:bg-muted aria-expanded:text-foreground sm:col-start-auto sm:row-start-auto"
          aria-expanded={previewOpen}
          aria-label={previewLabel}
          title={previewLabel}
          disabled={!effectiveLyrics}
          onClick={onTogglePreview}
        >
          <Eye className="h-4 w-4" />
        </Button>
      </div>
      {previewOpen && effectiveLyrics && (
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
