import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CollectionPagination } from "@/components/collection/CollectionPagination";
import { api, type MetadataCircle, type MetadataTag } from "@/lib/api";
import { MaintenanceToolbar, useMaintenanceSearch, type MaintenanceToolbarSlots } from "./MaintenanceControls";
import { MetadataTagDialog } from "./MetadataTagDialog";
import { MetadataCircleDialog } from "./MetadataCircleDialog";

const PAGE_SIZES = [25, 50, 100] as const;

export function MetadataEntryMaintenance({
  kind,
  canManage,
  toolbar,
}: {
  kind: "tags" | "circles";
  canManage: boolean;
  toolbar: MaintenanceToolbarSlots;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const search = useMaintenanceSearch(() => setPage(1));
  const [result, setResult] = useState<{ entries: (MetadataTag | MetadataCircle)[]; total: number }>({
    entries: [],
    total: 0,
  });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [managed, setManaged] = useState<MetadataTag | MetadataCircle | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  const reload = () => setRefresh((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const options = { page, pageSize, query: search.query, signal: controller.signal };
    const request =
      kind === "tags"
        ? api
            .listMetadataTags({ ...options, includeHidden: true })
            .then((next) => ({ entries: next.tags, total: next.total }))
        : api.listMetadataCircles(options).then((next) => ({ entries: next.circles, total: next.total }));
    void request
      .then((next) => {
        if (controller.signal.aborted) return;
        if (page > 1 && next.total <= (page - 1) * pageSize) {
          setPage(Math.max(1, Math.ceil(next.total / pageSize)));
          return;
        }
        setResult(next);
        setLoaded(true);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [kind, page, pageSize, search.query, refresh]);
  const create = async () => {
    setBusy(true);
    setCreateFailed(false);
    try {
      const next = await api.createMetadataTag(name.trim());
      setCreating(false);
      setName("");
      setManaged(next);
      reload();
    } catch {
      setCreateFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const pagination = {
    page,
    pageSize,
    totalItems: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
    itemLabel: t(`metadataEntries.${kind}`),
    onPageChange: setPage,
  };
  return (
    <div className="min-w-0 space-y-3" id={`metadata-${kind}`} role="tabpanel" aria-labelledby={`metadata-tab-${kind}`}>
      <MaintenanceToolbar
        slots={toolbar}
        query={search.draft}
        label={t(kind === "tags" ? "metadataEntries.searchTags" : "metadataEntries.searchCircles")}
        placeholder={t("metadataEntries.name")}
        loading={loading}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZES}
        onQueryChange={search.setDraft}
        onQueryCommit={search.commit}
        onClear={search.clear}
        onRefresh={reload}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
      >
        {kind === "tags" && canManage && (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            {t("metadataEntries.createTag")}
          </Button>
        )}
      </MaintenanceToolbar>
      {(loaded || !failed) && <CollectionPagination {...pagination} placement="top" compactMobile compactTop />}
      {failed && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
          <span>{t("metadataEntries.loadFailed")}</span>
          <Button variant="outline" size="sm" onClick={reload}>
            {t("metadataEntries.retry")}
          </Button>
        </div>
      )}
      {loading && !loaded ? (
        <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm" aria-label={t(`metadataEntries.${kind}`)}>
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t("metadataEntries.name")}</th>
                <th className="px-3 py-2">{t("metadataEntries.knownNames")}</th>
                <th className="px-3 py-2">{t("metadataEntries.workCount")}</th>
                {kind === "tags" && <th className="px-3 py-2">{t("metadataEntries.status")}</th>}
                <th className="px-3 py-2">
                  <span className="sr-only">{t("metadataEntries.manage")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {result.entries.map((entry) => {
                const tag = kind === "tags" ? (entry as MetadataTag) : null;
                const names = tag
                  ? [...new Set(tag.names.map((value) => value.name))]
                  : (entry as MetadataCircle).aliases.map((value) => value.alias);
                return (
                  <tr key={entry.id} className="border-b last:border-0">
                    <td className="px-3 py-3 font-medium">{entry.displayName}</td>
                    <td className="max-w-sm px-3 py-3 text-muted-foreground">{names.join(" · ") || "—"}</td>
                    <td className="px-3 py-3 tabular-nums">{entry.workCount}</td>
                    {tag && (
                      <td className="px-3 py-3 text-muted-foreground">
                        {t(
                          tag.hidden
                            ? "metadataEntries.hidden"
                            : tag.mergedIntoTagId
                              ? "metadataEntries.merged"
                              : "metadataEntries.active",
                        )}
                      </td>
                    )}
                    <td className="px-3 py-3 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t("metadataEntries.manageFor", { name: entry.displayName })}
                        onClick={() => setManaged(entry)}
                      >
                        {t("metadataEntries.manage")}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!result.entries.length && !failed && (
            <p className="p-6 text-center text-sm text-muted-foreground">{t("metadataEntries.empty")}</p>
          )}
        </div>
      )}
      <CollectionPagination {...pagination} placement="bottom" />
      {managed &&
        (kind === "tags" ? (
          <MetadataTagDialog
            key={managed.id}
            entry={managed as MetadataTag}
            canManage={canManage}
            onClose={() => setManaged(null)}
            onChanged={reload}
          />
        ) : (
          <MetadataCircleDialog
            key={managed.id}
            entry={managed as MetadataCircle}
            canManage={canManage}
            onClose={() => setManaged(null)}
            onChanged={reload}
          />
        ))}
      {creating && (
        <Dialog onClose={() => setCreating(false)} dismissible={!busy} size="sm">
          <DialogHeader
            title={t("metadataEntries.createTag")}
            onClose={busy ? undefined : () => setCreating(false)}
            closeLabel={t("common.close")}
          />
          <DialogBody>
            <label className="block space-y-1 text-sm">
              <span className="block">{t("metadataEntries.tagName")}</span>
              <Input
                className="w-full"
                disabled={busy}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {createFailed && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {t("metadataEntries.saveFailed")}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCreating(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={busy || !name.trim()} onClick={() => void create()}>
              {t("metadataEntries.createTag")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}
