import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Captions,
  FileText,
  Files,
  Folder,
  Languages,
  ListChecks,
  ListOrdered,
  RotateCcw,
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
import { LyricsPreview, loadLocalLyricsText } from "@/features/work-detail/lyrics/LyricsPreview";
import { LyricsTranslationPanel } from "@/features/work-detail/lyrics/LyricsTranslationPanel";
import { TranscriptionPanel } from "@/features/work-detail/lyrics/TranscriptionPanel";
import { formatTrackDuration } from "@/features/work-detail/media/mediaTreeModel";
import { api, type WorkDetail } from "@/lib/api";
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
 * the work's other folders, and remote editions.
 */
export function LyricsManagerDialog({
  work,
  readOnly,
  canDownload = false,
  canTranscribe = false,
  canTranslate = false,
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
  const localFolders = useMemo(
    () => (canDownload ? (work.localFolders ?? []).filter((folder) => folder.state === "active") : []),
    [canDownload, work.localFolders],
  );
  const filesAvailable = localFolders.length > 0;
  const transcribeAvailable = canTranscribe && entries.audio.length > 0;
  const translateAvailable = canTranslate && entries.audio.length > 0;
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
  const groups = useMemo(() => groupByFolder(entries.audio), [entries.audio]);
  const editable = !readOnly && !saving && entries.lyrics.length > 0;
  const busy = saving || filesBusy;

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
    label: `${folder || t("lyricsManager.rootFolder")} (${count})`,
  }));

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
      >
        {(filesAvailable || transcribeAvailable || translateAvailable) && (
          <div className={segmentedListClassName("mt-3")} role="tablist" aria-label={t("lyricsManager.title")}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "assign"}
              className={segmentedItemClassName(tab === "assign")}
              disabled={busy}
              onClick={() => setTab("assign")}
            >
              <ListChecks className="h-4 w-4" />
              {t("lyricsManager.tabAssign")}
            </button>
            {filesAvailable && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === "files"}
                className={segmentedItemClassName(tab === "files")}
                disabled={busy}
                onClick={() => setTab("files")}
              >
                <Files className="h-4 w-4" />
                {t("lyricsManager.tabFiles")}
                {managedCount > 0 && <span className="tabular-nums text-muted-foreground">{managedCount}</span>}
              </button>
            )}
            {transcribeAvailable && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === "transcribe"}
                className={segmentedItemClassName(tab === "transcribe")}
                disabled={busy}
                onClick={() => setTab("transcribe")}
              >
                <AudioLines className="h-4 w-4" />
                {t("lyricsManager.tabTranscribe")}
              </button>
            )}
            {translateAvailable && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === "translate"}
                className={segmentedItemClassName(tab === "translate")}
                disabled={busy}
                onClick={() => setTab("translate")}
              >
                <Languages className="h-4 w-4" />
                {t("lyricsManager.tabTranslate")}
              </button>
            )}
          </div>
        )}
      </DialogHeader>
      {tab === "transcribe" && transcribeAvailable ? (
        <>
          <DialogBody>
            <TranscriptionPanel work={work} audio={entries.audio} onPublished={onSaved} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t("content.close")}
            </Button>
          </DialogFooter>
        </>
      ) : tab === "translate" && translateAvailable ? (
        <>
          <DialogBody>
            <LyricsTranslationPanel work={work} audio={entries.audio} lyrics={entries.lyrics} onPublished={onSaved} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t("content.close")}
            </Button>
          </DialogFooter>
        </>
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
          onFolderChange={setFolderId}
          onBusyChange={setFilesBusy}
          onApplied={onSaved}
          onClose={onClose}
        />
      ) : (
        <>
          {entries.audio.length > 0 && entries.lyrics.length > 0 && (
            <LyricsLanguageTabs selected={language} counts={languageCounts} onSelect={selectLanguage} />
          )}
          {editable && folders.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-end gap-2 border-b px-5 py-3">
              <div className="min-w-0 flex-1 basis-56">
                <div className="mb-1 text-xs font-medium text-muted-foreground">{t("lyricsManager.alignFrom")}</div>
                <FloatingSelect
                  value={alignFolder}
                  options={folderOptions}
                  onValueChange={(value) => {
                    setAlignFolder(value);
                    setAlignMessage("");
                  }}
                  ariaLabel={t("lyricsManager.alignFrom")}
                />
              </div>
              <Button variant="outline" onClick={alignByOrder}>
                <ListOrdered className="h-4 w-4" />
                {t("lyricsManager.alignByOrder")}
              </Button>
              <Button variant="ghost" onClick={clearLanguage}>
                <RotateCcw className="h-4 w-4" />
                {language === allLyricsLanguages
                  ? t("lyricsManager.restoreAutomatic")
                  : t("lyricsManager.clearLanguage")}
              </Button>
              {alignMessage && (
                <p role="status" className="w-full text-xs text-muted-foreground">
                  {alignMessage}
                </p>
              )}
            </div>
          )}
          <DialogBody className="space-y-4">
            {readOnly && <p className="text-sm text-muted-foreground">{t("lyricsManager.readOnly")}</p>}
            {entries.audio.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("lyricsManager.noAudio")}</p>
            ) : entries.lyrics.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {filesAvailable ? t("lyricsManager.noLyricsTryFiles") : t("lyricsManager.noLyrics")}
              </p>
            ) : (
              groups.map(([folder, audio]) => (
                <section key={folder} aria-label={folder || t("lyricsManager.rootFolder")}>
                  <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Folder className="h-3.5 w-3.5" />
                    <span className="truncate">{folder || t("lyricsManager.rootFolder")}</span>
                  </h4>
                  <ul className="divide-y rounded-lg border">
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
              ))
            )}
          </DialogBody>
          <DialogFooter>
            <span className="mr-auto text-xs text-muted-foreground" role="status">
              {changes.length > 0
                ? t("lyricsManager.pending", { count: changes.length })
                : t("lyricsManager.noChanges")}
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
    <div className="shrink-0 space-y-2 border-b px-5 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Languages className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t("lyricsManager.language")}
      </p>
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
              {count > 0 && <span className="tabular-nums text-muted-foreground">{count}</span>}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {selected === allLyricsLanguages ? t("lyricsManager.allLanguagesHint") : t("lyricsManager.languageHint")}
      </p>
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
  const unassignedLabel =
    language !== allLyricsLanguages
      ? t("lyricsManager.languageUnset")
      : automatic
        ? t("lyricsManager.automaticMatch", { title: automatic.title })
        : t("lyricsManager.automaticNone");
  const options: FloatingSelectOption[] = [
    { value: automaticValue, label: unassignedLabel },
    ...lyrics.map((file) => ({
      value: String(file.mediaItemId),
      label: <LyricsFileLabel file={file} />,
    })),
  ];
  const changed = draftValue !== storedLyricsMediaItemId(entry, language);
  const duration = formatTrackDuration(entry.durationSeconds);
  return (
    <li className="px-3 py-2.5">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,20rem)_auto] sm:items-center">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" title={entry.path}>
            {entry.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {duration && <span className="tabular-nums">{duration}</span>}
            {changed ? (
              <Badge variant="info">{t("lyricsManager.changed")}</Badge>
            ) : draftValue !== null ? (
              <Badge variant="secondary">{t("lyricsManager.assigned")}</Badge>
            ) : null}
          </div>
        </div>
        <FloatingSelect
          value={draftValue === null ? automaticValue : String(draftValue)}
          options={options}
          onValueChange={(value) => onAssign(value === automaticValue ? null : Number(value))}
          ariaLabel={t("lyricsManager.lyricsFor", { title: entry.title })}
          disabled={disabled}
          contentClassName="max-w-[min(32rem,calc(100vw-1.5rem))]"
        />
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start sm:justify-self-auto"
          aria-expanded={previewOpen}
          aria-label={t("lyricsManager.previewOf", { title: entry.title })}
          disabled={!effectiveLyrics}
          onClick={onTogglePreview}
        >
          <FileText className="h-4 w-4" />
          {t("lyricsManager.preview")}
        </Button>
      </div>
      {previewOpen && effectiveLyrics && (
        <LyricsPreview
          label={effectiveLyrics.path}
          loadKey={`local:${effectiveLyrics.locationId}`}
          load={() => loadLocalLyricsText(effectiveLyrics.locationId)}
          durationSeconds={entry.durationSeconds}
        />
      )}
    </li>
  );
}

function LyricsFileLabel({ file }: { file: LyricsManagerFile }) {
  return (
    <span className="flex min-w-0 flex-col" title={file.path}>
      <span className="truncate">{file.title}</span>
      {file.folder && <span className="truncate text-xs text-muted-foreground">{file.folder}</span>}
    </span>
  );
}

function groupByFolder(audio: LyricsManagerAudio[]) {
  const groups = new Map<string, LyricsManagerAudio[]>();
  for (const entry of audio) groups.set(entry.folder, [...(groups.get(entry.folder) ?? []), entry]);
  return [...groups.entries()];
}
