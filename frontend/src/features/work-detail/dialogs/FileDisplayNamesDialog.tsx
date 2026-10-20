import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCopy, ClipboardPaste, FileText, Folder, Languages, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  type DisplayNameDrafts,
  displayNameChange,
  displayNameInvalid,
  displayNameRows,
  displayNameValue,
  pasteDisplayNames,
  realNamesText,
} from "@/features/work-detail/dialogs/fileDisplayNamesModel";
import { api, type FileDisplayNames } from "@/lib/api";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { interfaceLyricsLanguage } from "@/lib/translationTargets";
import { cn } from "@/lib/tailwindClassNames";

/**
 * Edits the names the directory shows for a work's local files and folders, one
 * metadata language at a time. Files on disk keep their names, and an empty
 * field shows the real name.
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
  const [language, setLanguage] = useState(() => interfaceLyricsLanguage(i18n.resolvedLanguage));
  const languageChosen = useRef(false);
  const [drafts, setDrafts] = useState<Record<string, DisplayNameDrafts>>({});
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .getWorkFileDisplayNames(workId, controller.signal)
      .then(setEntries)
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, [workId]);

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

  const chooseLanguage = (next: string) => {
    languageChosen.current = true;
    setLanguage(next);
  };

  const rows = useMemo(() => (entries ? displayNameRows(entries) : []), [entries]);
  const languageDrafts = drafts[language] ?? {};
  const changes = useMemo(
    () =>
      metadataTagNameLanguages
        .map(([candidate]) => displayNameChange(rows, drafts[candidate] ?? {}, candidate))
        .filter((change) => change !== null),
    [drafts, rows],
  );
  // Stored names are valid, so only an edit can make one invalid.
  const anyInvalid = Object.values(drafts).some((values) => Object.values(values).some(displayNameInvalid));

  const setDraft = (key: string, value: string) =>
    setDrafts((current) => ({ ...current, [language]: { ...(current[language] ?? {}), [key]: value } }));

  const save = async () => {
    if (changes.length === 0 || anyInvalid) return;
    setSaving(true);
    try {
      let saved: FileDisplayNames | null = null;
      for (const change of changes) saved = await api.setWorkFileDisplayNames(workId, change);
      if (saved) setEntries(saved);
      setDrafts({});
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

  const applyPaste = () => {
    setDrafts((current) => ({ ...current, [language]: pasteDisplayNames(rows, current[language] ?? {}, pasteText) }));
    setPasteText("");
    setPasteOpen(false);
  };

  return (
    <Dialog onClose={onClose} size="xl" dismissible={!saving && changes.length === 0}>
      <DialogHeader
        icon={<Languages className="h-4 w-4" />}
        title={t("fileDisplayNames.title")}
        description={t("fileDisplayNames.description")}
        onClose={onClose}
        closeLabel={t("content.close")}
      />
      <DialogBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label={t("fileDisplayNames.language")} className={segmentedListClassName()}>
            {metadataTagNameLanguages.map(([candidate, labelKey]) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={candidate === language}
                className={segmentedItemClassName(candidate === language)}
                onClick={() => chooseLanguage(candidate)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="outline" size="sm" disabled={rows.length === 0} onClick={() => void copyRealNames()}>
              <ClipboardCopy className="h-4 w-4" />
              {t("fileDisplayNames.copyRealNames")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0}
              aria-expanded={pasteOpen}
              onClick={() => setPasteOpen((open) => !open)}
            >
              <ClipboardPaste className="h-4 w-4" />
              {t("fileDisplayNames.pasteNames")}
            </Button>
          </div>
        </div>
        {pasteOpen && (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">{t("fileDisplayNames.pasteHint", { count: rows.length })}</p>
            <Textarea
              className="min-h-28 w-full py-2"
              value={pasteText}
              aria-label={t("fileDisplayNames.pasteNames")}
              onChange={(event) => setPasteText(event.target.value)}
            />
            <div className="flex justify-end">
              <Button size="sm" disabled={!pasteText.trim()} onClick={applyPaste}>
                {t("fileDisplayNames.applyPaste")}
              </Button>
            </div>
          </div>
        )}
        {!entries && !loadFailed && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("fileDisplayNames.loading")}
          </div>
        )}
        {loadFailed && <p className="py-6 text-sm text-muted-foreground">{t("fileDisplayNames.loadFailed")}</p>}
        {entries && rows.length === 0 && (
          <p className="py-6 text-sm text-muted-foreground">{t("fileDisplayNames.noLocalFiles")}</p>
        )}
        {rows.length > 0 && (
          <ul className="space-y-1">
            {rows.map((row) => {
              const value = displayNameValue(row, languageDrafts, language);
              const rowInvalid = displayNameInvalid(value);
              const Icon = row.kind === "folder" ? Folder : FileText;
              return (
                <li
                  key={row.key}
                  className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:gap-3"
                >
                  <span
                    className="flex min-w-0 items-center gap-2 text-sm"
                    style={{ paddingLeft: Math.min(row.depth, 6) * 12 }}
                    title={row.path}
                  >
                    <Icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        row.kind === "folder" ? "text-primary" : "text-muted-foreground",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 truncate">
                      {row.baseName}
                      {row.extension && <span className="text-muted-foreground">{row.extension}</span>}
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Input
                      fieldSize="sm"
                      className="min-w-0 flex-1"
                      value={value}
                      placeholder={row.baseName}
                      maxLength={255}
                      aria-label={t("fileDisplayNames.nameFor", { name: row.baseName + row.extension })}
                      aria-invalid={rowInvalid}
                      onChange={(event) => setDraft(row.key, event.target.value)}
                    />
                    {/* Every row keeps the same suffix width, so the fields line up. */}
                    <span className="w-10 shrink-0 truncate text-xs text-muted-foreground" aria-hidden="true">
                      {row.extension}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </DialogBody>
      <DialogFooter>
        {anyInvalid && <span className="mr-auto text-xs text-error">{t("fileDisplayNames.invalidName")}</span>}
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t("content.cancel")}
        </Button>
        <Button onClick={() => void save()} disabled={saving || changes.length === 0 || anyInvalid}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("fileDisplayNames.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
