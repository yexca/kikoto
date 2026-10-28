import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlignLeft, Languages, ListTree, Loader2, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { CoverageBar } from "@/components/ui/coverage-bar";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  DisplayNameGroupSection,
  DisplayNameLanguageTabs,
  DisplayNamePanel,
  type DisplayNameRowProps,
  displayNameFieldAttribute,
} from "@/features/work-detail/dialogs/FileDisplayNamesList";
import { DisplayNamesTextView } from "@/features/work-detail/dialogs/FileDisplayNamesText";
import {
  type DisplayNameDrafts,
  type DisplayNameRow,
  displayNameChange,
  displayNameGroups,
  displayNameInvalid,
  displayNameMatches,
  displayNameRows,
  displayNamesText,
  namedRowCount,
  realNamesText,
  textDisplayNames,
  textLines,
} from "@/features/work-detail/dialogs/fileDisplayNamesModel";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { api, type FileDisplayNames } from "@/lib/api";
import { FILE_DISPLAY_NAMES_CHANGED_EVENT } from "@/lib/appEvents";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { interfaceLyricsLanguage } from "@/lib/translationTargets";
import { cn } from "@/lib/tailwindClassNames";

const panelQuery = "(min-width: 1024px)";

/**
 * Edits the names the directory shows for a work's local files and folders, one
 * metadata language at a time as a list of fields or as one text with a line
 * per entry, and every language of the selected row beside it on wide screens.
 * Files on disk keep their names, and an empty name shows the real name.
 */
export function FileDisplayNamesDialog({
  workId,
  onClose,
  onSaved,
}: {
  workId: number;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [entries, setEntries] = useState<FileDisplayNames | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [language, setLanguage] = useState(() => interfaceLyricsLanguage(i18n.resolvedLanguage));
  const languageChosen = useRef(false);
  const [drafts, setDrafts] = useState<Record<string, DisplayNameDrafts>>({});
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "text">("list");
  // The text view's text, and the drafts of its language it started from.
  const [text, setText] = useState("");
  const [textBase, setTextBase] = useState<DisplayNameDrafts>({});
  const [saving, setSaving] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery(panelQuery);

  useEffect(() => {
    const controller = new AbortController();
    setLoadFailed(false);
    api
      .getWorkFileDisplayNames(workId, controller.signal)
      .then(setEntries)
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, [workId, loadAttempt]);

  // The editor starts on the editor's own metadata language, else the interface language.
  useEffect(() => {
    const controller = new AbortController();
    api
      .getUserPreferences(controller.signal)
      .then((preferences) => {
        const preferred = (preferences.metadataLanguages ?? []).find((candidate) =>
          metadataTagNameLanguages.some(([supported]) => supported === candidate),
        );
        if (preferred && !languageChosen.current) setLanguage(preferred);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const rows = useMemo(() => (entries ? displayNameRows(entries) : []), [entries]);

  const startText = (textLanguage: string) => {
    const base = drafts[textLanguage] ?? {};
    setTextBase(base);
    setText(displayNamesText(rows, base, textLanguage));
  };

  const chooseLanguage = (next: string) => {
    languageChosen.current = true;
    setLanguage(next);
    if (view === "text") startText(next);
  };

  const chooseView = (next: "list" | "text") => {
    if (next === "text" && view !== "text") startText(language);
    setView(next);
  };

  const editText = (next: string) => {
    setText(next);
    setDrafts((current) => ({ ...current, [language]: textDisplayNames(rows, textBase, next) }));
  };
  const groups = useMemo(() => displayNameGroups(rows), [rows]);
  const languageDrafts = drafts[language] ?? {};
  const changes = useMemo(
    () =>
      metadataTagNameLanguages
        .map(([candidate]) => displayNameChange(rows, drafts[candidate] ?? {}, candidate))
        .filter((change) => change !== null),
    [drafts, rows],
  );
  const changedNames = changes.reduce((sum, change) => sum + change.files.length + change.folders.length, 0);
  const pendingLanguages = useMemo(() => new Set(changes.map((change) => change.language)), [changes]);
  const languageCounts = useMemo(
    () =>
      new Map<string, number>(
        metadataTagNameLanguages.map(([candidate]) => [
          candidate,
          namedRowCount(rows, drafts[candidate] ?? {}, candidate),
        ]),
      ),
    [drafts, rows],
  );
  const named = languageCounts.get(language) ?? 0;
  // Stored names are valid, so only an edit can make one invalid.
  const anyInvalid = Object.values(drafts).some((values) => Object.values(values).some(displayNameInvalid));

  const visibleGroups = useMemo(
    () =>
      groups
        .map((group) => {
          const files = group.files.filter((file) => displayNameMatches(file, query, language));
          const folderMatches = !group.folder || displayNameMatches(group.folder, query, language);
          return { group, files, visible: files.length > 0 || (Boolean(group.folder) && folderMatches) };
        })
        .filter((entry) => entry.visible),
    [groups, language, query],
  );

  const panel = wide && rows.length > 0;
  const panelRow = rows.find((row) => row.key === selectedKey) ?? rows[0] ?? null;

  const setDraftIn = (draftLanguage: string, key: string, value: string) =>
    setDrafts((current) => ({ ...current, [draftLanguage]: { ...(current[draftLanguage] ?? {}), [key]: value } }));

  // The panel edits the text view's language through its line, so both stay one edit.
  const setPanelDraft = (draftLanguage: string, row: DisplayNameRow, value: string) => {
    const index = rows.indexOf(row);
    const lines = textLines(text);
    if (view !== "text" || draftLanguage !== language || index >= lines.length) {
      setDraftIn(draftLanguage, row.key, value);
      return;
    }
    lines[index] = value;
    editText(lines.join("\n"));
  };

  const revert = (key: string) =>
    setDrafts((current) => {
      const next = { ...(current[language] ?? {}) };
      delete next[key];
      return { ...current, [language]: next };
    });

  // Enter steps to the next name and Shift+Enter back, outside an IME composition.
  const stepField = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const fields = Array.from(
      listRef.current?.querySelectorAll<HTMLInputElement>(`[${displayNameFieldAttribute}]`) ?? [],
    );
    const next = fields[fields.indexOf(event.currentTarget) + (event.shiftKey ? -1 : 1)];
    if (!next) return;
    next.focus();
    next.select();
  };

  const rowProps = (row: DisplayNameRow): DisplayNameRowProps => ({
    row,
    drafts: languageDrafts,
    language,
    selected: panel ? row.key === panelRow?.key : null,
    onSelect: () => setSelectedKey(row.key),
    onChange: (value) => setDraftIn(language, row.key, value),
    onRevert: () => revert(row.key),
    onFieldKeyDown: stepField,
  });

  const save = async () => {
    if (changes.length === 0 || anyInvalid) return;
    setSaving(true);
    try {
      let saved: FileDisplayNames | null = null;
      for (const change of changes) saved = await api.setWorkFileDisplayNames(workId, change);
      if (saved) setEntries(saved);
      setDrafts({});
      // Queued tracks of this work take the new names.
      window.dispatchEvent(new CustomEvent(FILE_DISPLAY_NAMES_CHANGED_EVENT, { detail: { workId } }));
      toast.success(t("fileDisplayNames.saved"));
      await onSaved();
      onClose();
    } catch (error) {
      toast.notify(toastFromError(error, t("fileDisplayNames.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const copyRealNames = async () => {
    try {
      await navigator.clipboard.writeText(realNamesText(rows));
      toast.success(t("fileDisplayNames.realNamesCopied", { count: rows.length }));
    } catch {
      toast.error(t("fileDisplayNames.copyFailed"));
    }
  };

  const languageLabel = t(metadataTagNameLanguages.find(([candidate]) => candidate === language)?.[1] ?? "");

  const views = [
    ["list", ListTree, t("fileDisplayNames.viewList")],
    ["text", AlignLeft, t("fileDisplayNames.viewText")],
  ] as const;

  const list =
    view === "text" ? (
      <DisplayNamesTextView
        rows={rows}
        drafts={languageDrafts}
        language={language}
        languageLabel={languageLabel}
        text={text}
        onTextChange={editText}
        onLineSelect={(row) => row && setSelectedKey(row.key)}
        onCopyRealNames={() => void copyRealNames()}
      />
    ) : (
      <div ref={listRef} className="space-y-3">
        {visibleGroups.map(({ group, files }) => (
          <DisplayNameGroupSection key={group.path || "."} group={group} files={files} rowProps={rowProps} />
        ))}
        {visibleGroups.length === 0 && (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            {t("fileDisplayNames.noMatches", { query: query.trim() })}
          </p>
        )}
      </div>
    );

  return (
    <Dialog
      onClose={onClose}
      size="workspace"
      dismissible={!saving && changes.length === 0}
      marker="file-display-names"
    >
      <DialogHeader
        icon={<Languages className="h-4 w-4" />}
        title={t("fileDisplayNames.title")}
        description={t("fileDisplayNames.description")}
        onClose={saving ? undefined : onClose}
        closeLabel={t("content.close")}
      />
      {rows.length > 0 && (
        <div className="shrink-0 space-y-2.5 border-b bg-muted/20 px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <DisplayNameLanguageTabs
              selected={language}
              counts={languageCounts}
              total={rows.length}
              pending={pendingLanguages}
              onSelect={chooseLanguage}
            />
            <div className="flex min-w-0 flex-1 basis-64 items-center justify-end gap-1.5">
              {view === "list" && (
                <label className="relative min-w-0 flex-1 sm:max-w-64">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    type="search"
                    fieldSize="sm"
                    className="w-full pl-8"
                    value={query}
                    placeholder={t("fileDisplayNames.filter")}
                    aria-label={t("fileDisplayNames.filter")}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
              )}
              <div role="group" aria-label={t("fileDisplayNames.view")} className={segmentedListClassName("shrink-0")}>
                {views.map(([value, Icon, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={view === value}
                    className={segmentedItemClassName(view === value, "h-9 gap-1.5 px-2.5 sm:h-7")}
                    onClick={() => chooseView(value)}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <p className="min-w-0 flex-1 basis-80 text-xs text-muted-foreground">
              {view === "text" ? (
                t("fileDisplayNames.textHint", { language: languageLabel })
              ) : (
                <>
                  {t("fileDisplayNames.languageHint", { language: languageLabel })}
                  <span className="hidden pointer-fine:inline"> {t("fileDisplayNames.keyboardHint")}</span>
                </>
              )}
            </p>
            <p className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <CoverageBar count={named} total={rows.length} className="w-24" />
              <span className="tabular-nums">
                {t("fileDisplayNames.coverage", { count: named, total: rows.length })}
              </span>
            </p>
          </div>
        </div>
      )}
      {rows.length === 0 ? (
        <DialogBody>
          {!entries && !loadFailed && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("fileDisplayNames.loading")}
            </div>
          )}
          {loadFailed && (
            <div className="flex flex-wrap items-center gap-3 py-6 text-sm text-muted-foreground">
              {t("fileDisplayNames.loadFailed")}
              <Button variant="outline" size="sm" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
                {t("fileDisplayNames.retry")}
              </Button>
            </div>
          )}
          {entries && !loadFailed && (
            <p className="py-6 text-sm text-muted-foreground">{t("fileDisplayNames.noLocalFiles")}</p>
          )}
        </DialogBody>
      ) : panel ? (
        <div className="flex min-h-0 flex-1">
          <DialogBody className="min-w-0">{list}</DialogBody>
          <DisplayNamePanel
            row={panelRow}
            drafts={drafts}
            language={language}
            onLanguage={chooseLanguage}
            onChange={(draftLanguage, value) => panelRow && setPanelDraft(draftLanguage, panelRow, value)}
          />
        </div>
      ) : (
        <DialogBody>{list}</DialogBody>
      )}
      <DialogFooter>
        <span
          className={cn(
            "mr-auto flex min-w-0 items-center gap-2 text-xs",
            anyInvalid ? "text-error" : changedNames > 0 ? "font-medium text-foreground" : "text-muted-foreground",
          )}
          role="status"
        >
          {!anyInvalid && changedNames > 0 && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-info" aria-hidden="true" />
          )}
          {anyInvalid
            ? t("fileDisplayNames.invalidName")
            : changedNames > 0
              ? t("fileDisplayNames.pending", { count: changedNames })
              : t("fileDisplayNames.noChanges")}
        </span>
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          {t("content.cancel")}
        </Button>
        <Button onClick={() => void save()} disabled={saving || changes.length === 0 || anyInvalid}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {saving ? t("fileDisplayNames.saving") : t("fileDisplayNames.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
