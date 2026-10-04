import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMetadataEntrySuggestions } from "@/hooks/useMetadataEntrySuggestions";
import { api, type CircleMergeReview, type MetadataCircle } from "@/lib/api";

export function MetadataCircleDialog({
  entry,
  canManage,
  onClose,
  onChanged,
}: {
  entry: MetadataCircle;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [circle, setCircle] = useState(entry);
  const [name, setName] = useState(entry.manualName);
  const [alias, setAlias] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<MetadataCircle | null>(null);
  const [history, setHistory] = useState<CircleMergeReview[]>([]);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const suggestions = useMetadataEntrySuggestions("circles", query);
  useEffect(() => {
    let cancelled = false;
    void api
      .listCircleMerges(entry.id)
      .then((reviews) => {
        if (!cancelled) {
          setHistory(reviews);
          setHistoryFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setHistoryFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.id, refresh]);
  const mutate = async (request: () => Promise<unknown>, undo = false) => {
    setBusy(true);
    setError("");
    try {
      await request();
      const next = await api.getMetadataCircle(circle.id);
      setCircle(next);
      setName(next.manualName);
      setAlias("");
      setSource(null);
      setQuery("");
      setRefresh((value) => value + 1);
      onChanged();
    } catch {
      setError(t(undo ? "metadataEntries.undoConflict" : "metadataEntries.saveFailed"));
    } finally {
      setBusy(false);
    }
  };
  const latest = history.find((review) => review.status === "merged")?.id;
  return (
    <Dialog onClose={onClose} size="xl" dismissible={!busy}>
      <DialogHeader
        title={t("metadataEntries.manageFor", { name: circle.displayName })}
        onClose={busy ? undefined : onClose}
        closeLabel={t("common.close")}
      />
      <DialogBody>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t("metadataEntries.providerName")}: {circle.providerName} · {t("metadataEntries.workCount")}:{" "}
            {circle.workCount}
          </p>
          {circle.externalIds.length > 0 && (
            <p className="text-xs text-muted-foreground">{circle.externalIds.join(" · ")}</p>
          )}
          <fieldset disabled={!canManage || busy} className="space-y-4 border-0 p-0">
            <label className="block space-y-1 text-sm">
              <span className="block">{t("metadataEntries.manualName")}</span>
              <Input
                className="w-full"
                value={name}
                placeholder={circle.providerName}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void mutate(() => api.renameMetadataCircle(circle.id, name))}>
                {t("content.save")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!circle.manualName}
                onClick={() => void mutate(() => api.renameMetadataCircle(circle.id, ""))}
              >
                {t("metadataEntries.resetName")}
              </Button>
            </div>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t("metadataEntries.aliases")}</h3>
              {circle.aliases.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>{item.alias}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("metadataEntries.removeAlias", { name: item.alias })}
                    onClick={() => void mutate(() => api.deleteCircleAlias(circle.id, item.id))}
                  >
                    {t("common.remove")}
                  </Button>
                </div>
              ))}
              <label className="block space-y-1 text-sm">
                <span className="block">{t("metadataEntries.aliasName")}</span>
                <Input className="w-full" value={alias} onChange={(event) => setAlias(event.target.value)} />
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={!alias.trim()}
                onClick={() => void mutate(() => api.addCircleAlias(circle.id, alias))}
              >
                {t("metadataEntries.addAlias")}
              </Button>
            </section>
            <section className="space-y-2 border-t pt-3">
              <label className="block space-y-1 text-sm">
                <span className="block">{t("metadataEntries.merge")}</span>
                <Input
                  className="w-full"
                  value={query}
                  placeholder={t("metadataEntries.searchCircles")}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSource(null);
                  }}
                />
              </label>
              <div className="flex flex-wrap gap-1">
                {suggestions.entries
                  .filter((candidate) => candidate.id !== circle.id)
                  .map((candidate) => (
                    <Button
                      key={candidate.id}
                      variant="outline"
                      size="sm"
                      onClick={() => setSource(candidate as MetadataCircle)}
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
              {source && (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="text-sm">
                    {t("metadataEntries.mergeCircleConfirm", {
                      source: source.displayName,
                      target: circle.displayName,
                    })}
                  </p>
                  <Button size="sm" onClick={() => void mutate(() => api.mergeMetadataCircle(circle.id, source.id))}>
                    {t("metadataEntries.merge")}
                  </Button>
                </div>
              )}
            </section>
          </fieldset>
          <section className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-semibold">{t("metadataEntries.mergeHistory")}</h3>
            {historyFailed && (
              <p role="alert" className="text-sm">
                {t("metadataEntries.loadFailed")}{" "}
                <Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)}>
                  {t("metadataEntries.retry")}
                </Button>
              </p>
            )}
            {history.map((review) => (
              <div key={review.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {review.sourceName} → {review.targetName}{" "}
                  <span className="text-muted-foreground">{review.createdAt}</span>
                </span>
                {review.status === "merged" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canManage || busy || review.id !== latest}
                    onClick={() => void mutate(() => api.undoCircleMerge(circle.id, review.id), true)}
                  >
                    {t("metadataEntries.undoMerge")}
                  </Button>
                )}
              </div>
            ))}
          </section>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
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
