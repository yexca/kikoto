import { Inbox, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CollectionPagination } from "@/components/collection/CollectionPagination";
import { api, ApiError, type MetadataCircle, type MetadataTag } from "@/lib/api";
import { MaintenanceToolbar, useMaintenanceSearch, type MaintenanceToolbarSlots } from "./MaintenanceControls";
import { MetadataTagDialog } from "./MetadataTagDialog";
import { MetadataTagTable } from "./MetadataTagTable";
import { MetadataCircleDialog } from "./MetadataCircleDialog";
import { MetadataCircleTable } from "./MetadataCircleTable";

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
  const [result, setResult] = useState<{
    entries: (MetadataTag | MetadataCircle)[];
    total: number;
    pendingWorkCount?: number;
  }>({
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
  const [createFailed, setCreateFailed] = useState<string | null>(null);
  const reload = () => setRefresh((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const options = { page, pageSize, query: search.query, signal: controller.signal };
    const request =
      kind === "tags"
        ? api
            .listMetadataTags({ ...options, includeHidden: true, sort: "id" })
            .then((next) => ({ entries: next.tags, total: next.total, pendingWorkCount: next.pendingWorkCount }))
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
    setCreateFailed(null);
    try {
      const next = await api.createMetadataTag(name.trim());
      setCreating(false);
      setName("");
      setManaged(next);
      reload();
    } catch (error) {
      setCreateFailed(
        error instanceof ApiError && error.code === "metadata_tag_hidden"
          ? "metadataEntries.hiddenNameConflict"
          : "metadataEntries.saveFailed",
      );
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
        placeholder={t(kind === "tags" ? "metadataEntries.nameOrId" : "metadataEntries.nameOrCode")}
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
      {kind === "tags" && (result.pendingWorkCount ?? 0) > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("metadataEntries.pendingWorks", { count: result.pendingWorkCount })}
        </p>
      )}
      {(loaded || !failed) && <CollectionPagination {...pagination} placement="top" compactMobile compactTop />}
      {failed && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
          <span>{t("metadataEntries.loadFailed")}</span>
          <Button variant="outline" size="sm" onClick={reload}>
            {t("metadataEntries.retry")}
          </Button>
        </div>
      )}
      <section className="overflow-hidden rounded-lg border bg-card" aria-busy={loading}>
        {loading && !loaded ? (
          <p className="grid min-h-48 place-items-center p-4 text-sm text-muted-foreground" role="status">
            {t("common.loading")}
          </p>
        ) : (
          <>
            <div className="relative overflow-x-auto">
              {kind === "tags" ? (
                <MetadataTagTable tags={result.entries as MetadataTag[]} onManage={setManaged} />
              ) : (
                <MetadataCircleTable circles={result.entries as MetadataCircle[]} onManage={setManaged} />
              )}
            </div>
            {!result.entries.length && !failed && (
              <div className="grid min-h-48 place-items-center px-6 py-10 text-center">
                <div>
                  <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
                    {search.query ? <Search className="h-4 w-4" /> : <Inbox className="h-4 w-4" />}
                  </div>
                  <p className="text-sm font-medium">{t("metadataEntries.empty")}</p>
                  {search.query && (
                    <Button className="mt-4" size="sm" variant="outline" onClick={search.clear}>
                      {t("unlinked.clearSearch")}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </section>
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
                {t(createFailed)}
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
