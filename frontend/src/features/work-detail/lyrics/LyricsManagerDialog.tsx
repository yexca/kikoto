import { useEffect, useMemo, useRef, useState } from "react";
import { Captions, CloudDownload, FileText, Folder, ListChecks, ListOrdered, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { FloatingSelect, type FloatingSelectOption } from "@/components/ui/floating-select";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  alignLyricsByOrder,
  effectiveLyricsMediaItemId,
  initialLyricsAssignmentDraft,
  lyricsAssignmentChanges,
  lyricsFolders,
  lyricsManagerEntries,
  rebaseLyricsAssignmentDraft,
  type LyricsManagerAudio,
  type LyricsManagerFile,
} from "@/features/work-detail/lyrics/lyricsManagerModel";
import { LyricsPreview, loadLocalLyricsText } from "@/features/work-detail/lyrics/LyricsPreview";
import {
  RemoteLyricsDownloadButton,
  RemoteLyricsPanel,
  useRemoteLyricsFetch,
} from "@/features/work-detail/lyrics/RemoteLyricsPanel";
import { formatTrackDuration } from "@/features/work-detail/media/mediaTreeModel";
import { api, type LibrarySource, type WorkDetail } from "@/lib/api";

const automaticValue = "auto";

type LyricsManagerTab = "assign" | "remote";

/**
 * Lets a library manager choose the lyrics file every listener uses for each
 * local track. Personal player choices still override these assignments.
 */
export function LyricsManagerDialog({
  work,
  readOnly,
  remoteSources = [],
  canDownload = false,
  onClose,
  onSaved,
}: {
  work: WorkDetail;
  readOnly: boolean;
  /** Enabled compatible remote sources that may hold an edition of this work. */
  remoteSources?: LibrarySource[];
  /** Whether the viewer may download files into the library. */
  canDownload?: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const entries = useMemo(() => lyricsManagerEntries(work.mediaItems), [work.mediaItems]);
  const folders = useMemo(() => lyricsFolders(entries.lyrics), [entries.lyrics]);
  const lyricsByID = useMemo(() => new Map(entries.lyrics.map((file) => [file.mediaItemId, file])), [entries.lyrics]);
  const [draft, setDraft] = useState(() => initialLyricsAssignmentDraft(entries.audio));
  const [tab, setTab] = useState<LyricsManagerTab>("assign");
  const remote = useRemoteLyricsFetch({
    work,
    audio: entries.audio,
    sources: remoteSources,
    canAssign: !readOnly,
    onFetched: async () => {
      await onSaved();
      setTab("assign");
    },
  });
  const remoteAvailable = canDownload && remote.available && entries.audio.length > 0;
  // A download reloads the work. Keep the user's unsaved edits on the new entries.
  const previousAudio = useRef(entries.audio);
  useEffect(() => {
    if (previousAudio.current === entries.audio) return;
    const previous = previousAudio.current;
    previousAudio.current = entries.audio;
    setDraft((current) => rebaseLyricsAssignmentDraft(previous, entries.audio, current));
  }, [entries.audio]);
  const [alignFolder, setAlignFolder] = useState(() => folders[0]?.folder ?? "");
  const [alignMessage, setAlignMessage] = useState("");
  const [previewAudioID, setPreviewAudioID] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const changes = useMemo(() => lyricsAssignmentChanges(entries.audio, draft), [entries.audio, draft]);
  const groups = useMemo(() => groupByFolder(entries.audio), [entries.audio]);
  const editable = !readOnly && !saving && entries.lyrics.length > 0;
  const busy = saving || remote.fetching;

  const assign = (audioID: number, lyricsID: number | null) =>
    setDraft((current) => new Map(current).set(audioID, lyricsID));

  const alignByOrder = () => {
    const aligned = alignLyricsByOrder(entries.audio, entries.lyrics, alignFolder);
    if (aligned.size > 0) {
      setDraft((current) => {
        const next = new Map(current);
        for (const [audioID, lyricsID] of aligned) next.set(audioID, lyricsID);
        return next;
      });
    }
    setAlignMessage(
      aligned.size > 0 ? t("lyricsManager.alignResult", { count: aligned.size }) : t("lyricsManager.alignNone"),
    );
  };

  const restoreAutomatic = () => {
    setDraft(new Map(entries.audio.map((entry) => [entry.mediaItemId, null])));
    setAlignMessage("");
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
      className="max-h-[min(90vh,var(--dialog-max-height))] max-w-4xl"
    >
      <DialogHeader
        title={t("lyricsManager.title")}
        description={t("lyricsManager.description")}
        icon={<Captions className="h-4 w-4" />}
        onClose={busy ? undefined : onClose}
        closeLabel={t("content.close")}
      >
        {remoteAvailable && (
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
            <button
              type="button"
              role="tab"
              aria-selected={tab === "remote"}
              className={segmentedItemClassName(tab === "remote")}
              disabled={busy}
              onClick={() => setTab("remote")}
            >
              <CloudDownload className="h-4 w-4" />
              {t("lyricsManager.tabRemote")}
            </button>
          </div>
        )}
      </DialogHeader>
      {tab === "remote" && remoteAvailable ? (
        <>
          <DialogBody>
            <RemoteLyricsPanel state={remote} audio={entries.audio} />
          </DialogBody>
          <DialogFooter>
            <span className="mr-auto text-xs text-muted-foreground" role="status">
              {remote.listing.status === "ready"
                ? t("lyricsManager.downloadSummary", {
                    files: remote.request.files.length,
                    tracks: remote.request.assignments.length,
                  })
                : ""}
            </span>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t("lyricsManager.cancel")}
            </Button>
            <RemoteLyricsDownloadButton state={remote} />
          </DialogFooter>
        </>
      ) : (
        <>
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
              <Button variant="ghost" onClick={restoreAutomatic}>
                <RotateCcw className="h-4 w-4" />
                {t("lyricsManager.restoreAutomatic")}
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
                {remoteAvailable ? t("lyricsManager.noLyricsTryRemote") : t("lyricsManager.noLyrics")}
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
                        draftValue={draft.has(entry.mediaItemId) ? (draft.get(entry.mediaItemId) ?? null) : null}
                        effectiveLyrics={lyricsByID.get(effectiveLyricsMediaItemId(entry, draft) ?? 0) ?? null}
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

function LyricsAssignmentRow({
  entry,
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
  const options: FloatingSelectOption[] = [
    {
      value: automaticValue,
      label: automatic
        ? t("lyricsManager.automaticMatch", { title: automatic.title })
        : t("lyricsManager.automaticNone"),
    },
    ...lyrics.map((file) => ({
      value: String(file.mediaItemId),
      label: <LyricsFileLabel file={file} />,
    })),
  ];
  const changed = draftValue !== entry.assignedLyricsMediaItemId;
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
