import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMetadataEntrySuggestions } from "@/hooks/useMetadataEntrySuggestions";
import { api, type MetadataTag } from "@/lib/api";
import { metadataTagLanguages } from "@/lib/metadataTagModel";

function manualNames(tag: MetadataTag): Record<string, string> {
  return Object.fromEntries(
    tag.names.filter((name) => name.source === "manual").map((name) => [name.language, name.name]),
  );
}

export function MetadataTagDialog({
  entry,
  canManage,
  onClose,
  onChanged,
}: {
  entry: MetadataTag;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [tag, setTag] = useState(entry);
  const [names, setNames] = useState(() => manualNames(entry));
  const [hidden, setHidden] = useState(entry.hidden);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<MetadataTag | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const suggestions = useMetadataEntrySuggestions("tags", query);
  const mutate = async (request: () => Promise<MetadataTag>) => {
    setBusy(true);
    setFailed(false);
    try {
      const next = await request();
      setTag(next);
      setNames(manualNames(next));
      setHidden(next.hidden);
      setQuery("");
      setTarget(null);
      onChanged();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    const previous = manualNames(tag);
    const changed = Object.fromEntries(
      metadataTagLanguages
        .map(([language]) => [language, (names[language] ?? "").trim()])
        .filter(([language, name]) => name !== (previous[language] ?? "")),
    );
    return mutate(() =>
      api.updateMetadataTag(tag.id, { names: changed, ...(hidden !== tag.hidden ? { hidden } : {}) }),
    );
  };
  return (
    <Dialog onClose={onClose} size="xl" dismissible={!busy}>
      <DialogHeader
        title={t("metadataEntries.manageFor", { name: tag.displayName })}
        onClose={busy ? undefined : onClose}
        closeLabel={t("common.close")}
      />
      <DialogBody>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t("metadataEntries.workCount")}: {tag.workCount} ·{" "}
            {tag.dlsiteGenreId ? `DLsite #${tag.dlsiteGenreId}` : t("metadataEntries.createTag")}
          </p>
          {tag.pendingWorkCount > 0 && (
            <p role="status" className="text-sm text-muted-foreground">
              {t("metadataEntries.pendingWorks", { count: tag.pendingWorkCount })}
            </p>
          )}
          <fieldset disabled={!canManage || busy} className="space-y-3 border-0 p-0">
            <h3 className="text-sm font-semibold">{t("metadataEntries.manualNames")}</h3>
            <p className="text-sm text-muted-foreground">{t("metadataEntries.namePriority")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {metadataTagLanguages.map(([language, label]) => (
                <label key={language} className="block space-y-1 text-sm">
                  <span className="block">{t(label)}</span>
                  <Input
                    className="w-full"
                    value={names[language] ?? ""}
                    placeholder={tag.names.find((name) => name.language === language && name.source !== "manual")?.name}
                    onChange={(event) => setNames((current) => ({ ...current, [language]: event.target.value }))}
                  />
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />
              {t(tag.mergedIntoTagId ? "metadataEntries.hiddenAfterUndo" : "metadataEntries.hideTag")}
            </label>
            <p className="text-sm text-muted-foreground">{t("metadataEntries.mergeVisibility")}</p>
            <Button size="sm" onClick={() => void save()}>
              {t("content.save")}
            </Button>
          </fieldset>
          <div className="space-y-1 text-sm">
            <h3 className="font-semibold">{t("metadataEntries.dictionaryNames")}</h3>
            {tag.names
              .filter((name) => name.source !== "manual")
              .map((name) => (
                <p key={name.language} className="text-muted-foreground">
                  {t(
                    metadataTagLanguages.find(([language]) => language === name.language)?.[1] ??
                      "metadataEntries.allLanguages",
                  )}
                  : {name.name}
                </p>
              ))}
          </div>
          {tag.mergedFromTagIds.length > 0 && (
            <p className="text-sm">
              {t("metadataEntries.mergedFrom")}: {tag.mergedFromTagIds.join(", ")}
            </p>
          )}
          <fieldset disabled={!canManage || busy} className="space-y-3 border-0 border-t pt-3">
            {tag.mergedIntoTagId ? (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {t("metadataEntries.merged")}: #{tag.mergedIntoTagId}
                </span>
                <Button variant="outline" size="sm" onClick={() => void mutate(() => api.undoMetadataTagMerge(tag.id))}>
                  {t("metadataEntries.undoMerge")}
                </Button>
              </div>
            ) : (
              <>
                <label className="block space-y-1 text-sm">
                  <span className="block">{t("metadataEntries.mergeTarget")}</span>
                  <Input
                    className="w-full"
                    value={query}
                    placeholder={t("metadataEntries.searchMergeTarget")}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setTarget(null);
                    }}
                  />
                </label>
                <div className="flex flex-wrap gap-1">
                  {suggestions.entries
                    .filter((candidate) => candidate.id !== tag.id)
                    .map((candidate) => (
                      <Button
                        key={candidate.id}
                        variant="outline"
                        size="sm"
                        onClick={() => setTarget(candidate as MetadataTag)}
                      >
                        {candidate.displayName}
                      </Button>
                    ))}
                </div>
                {suggestions.failed && (
                  <p role="alert" className="text-sm text-muted-foreground">
                    {t("metadataEntries.loadFailed")}
                  </p>
                )}
                {target && (
                  <div className="space-y-2 rounded-md border p-3">
                    <p className="text-sm">
                      {t("metadataEntries.mergeConfirm", { source: tag.displayName, target: target.displayName })}
                    </p>
                    <Button size="sm" onClick={() => void mutate(() => api.mergeMetadataTag(tag.id, target.id))}>
                      {t("metadataEntries.merge")}
                    </Button>
                  </div>
                )}
              </>
            )}
          </fieldset>
          {failed && (
            <p role="alert" className="text-sm text-destructive">
              {t("metadataEntries.saveFailed")}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          {t("common.close")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
