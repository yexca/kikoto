import { FolderPlus, Inbox, Search } from "lucide-react";
import { useEffect, useState, type MouseEventHandler } from "react";
import { useTranslation } from "react-i18next";
import { AcceptanceNotice } from "@/components/AcceptanceNotice";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, ApiError, type CustomWorkCreated, type CustomWorkFolder } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { MaintenanceToolbar, useMaintenanceSearch, type MaintenanceToolbarSlots } from "./MaintenanceControls";

/**
 * The notice an administrator accepts before creating custom works: creating
 * one renames its folder on disk. The server refuses creation until then.
 */
export function CustomWorkNotice({ onAccepted }: { onAccepted: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  return (
    <AcceptanceNotice
      title={t("customWorks.notice.title")}
      items={[t("customWorks.notice.rename"), t("customWorks.notice.paths"), t("customWorks.notice.writable")]}
      scope={t("customWorks.notice.scope")}
      agreeLabel={t("customWorks.notice.agree")}
      acceptLabel={t("customWorks.notice.accept")}
      onAccept={async () => {
        try {
          await api.acceptCustomWorkNotice();
          onAccepted();
        } catch (error) {
          toast.notify(toastFromError(error, t("customWorks.notice.acceptFailed")));
        }
      }}
    />
  );
}

/**
 * Lists the library folders that carry no work code and turns one into a
 * custom work. The view unlocks once the rename notice is accepted.
 */
export function CustomWorkMaintenance({
  canCreate,
  toolbar,
}: {
  canCreate: boolean;
  toolbar: MaintenanceToolbarSlots;
}) {
  const { t } = useTranslation();
  const search = useMaintenanceSearch(() => undefined);
  const [folders, setFolders] = useState<CustomWorkFolder[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<CustomWorkFolder | null>(null);
  const [noticeAccepted, setNoticeAccepted] = useState(false);
  const reload = () => setRefresh((value) => value + 1);
  // Until the rename notice is accepted, the view stays visible but cannot be used.
  const locked = loaded && !noticeAccepted;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api
      .listCustomWorkFolders(search.query, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setFolders(next.folders);
        setTruncated(next.truncated);
        setNoticeAccepted(next.noticeAccepted);
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
  }, [search.query, refresh]);

  return (
    <div className="min-w-0 space-y-3" id="metadata-custom" role="tabpanel" aria-labelledby="metadata-tab-custom">
      <MaintenanceToolbar
        slots={toolbar}
        query={search.draft}
        label={t("customWorks.search")}
        placeholder={t("customWorks.searchPlaceholder")}
        loading={loading}
        onQueryChange={search.setDraft}
        onQueryCommit={search.commit}
        onClear={search.clear}
        onRefresh={reload}
      />
      <div className="relative">
        <div className="space-y-3" inert={locked} aria-hidden={locked || undefined}>
          <div role="note" className="space-y-1 rounded-lg border bg-card p-3 text-sm">
            <p>{t("customWorks.intro")}</p>
            <p className="text-muted-foreground">{t("customWorks.renameNotice")}</p>
          </div>
          {failed && (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <span>{t("customWorks.loadFailed")}</span>
              <Button variant="outline" size="sm" onClick={reload}>
                {t("metadataEntries.retry")}
              </Button>
            </div>
          )}
          <section
            className="overflow-hidden rounded-lg border bg-card"
            aria-label={t("customWorks.folders")}
            aria-busy={loading}
          >
            {loading && !loaded ? (
              <p className="grid min-h-48 place-items-center p-4 text-sm text-muted-foreground" role="status">
                {t("common.loading")}
              </p>
            ) : folders.length ? (
              <ul className="divide-y">
                {folders.map((folder) => (
                  <li key={folder.path} className="flex min-w-0 items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{folder.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{folder.path}</p>
                    </div>
                    {canCreate && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        aria-label={t("customWorks.createFor", { name: folder.name })}
                        onClick={() => setSelected(folder)}
                      >
                        <FolderPlus className="h-4 w-4" />
                        <span className="max-sm:sr-only">{t("customWorks.create")}</span>
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              !failed && (
                <div className="grid min-h-48 place-items-center px-6 py-10 text-center">
                  <div>
                    <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
                      {search.query ? <Search className="h-4 w-4" /> : <Inbox className="h-4 w-4" />}
                    </div>
                    <p className="text-sm font-medium">{t("customWorks.empty")}</p>
                    {search.query && (
                      <Button className="mt-4" size="sm" variant="outline" onClick={search.clear}>
                        {t("unlinked.clearSearch")}
                      </Button>
                    )}
                  </div>
                </div>
              )
            )}
          </section>
          {truncated && (
            <p role="status" className="text-sm text-muted-foreground">
              {t("customWorks.truncated", { count: folders.length })}
            </p>
          )}
        </div>
        {locked && (
          <div className="absolute inset-0 z-10 bg-background/70 px-4 pt-6 backdrop-blur-[2px]">
            <CustomWorkNotice onAccepted={() => setNoticeAccepted(true)} />
          </div>
        )}
      </div>
      {selected && (
        <CustomWorkDialog key={selected.path} folder={selected} onClose={() => setSelected(null)} onCreated={reload} />
      )}
    </div>
  );
}

export function CustomWorkDialog({
  folder,
  onClose,
  onCreated,
}: {
  folder: CustomWorkFolder;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(folder.name);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<CustomWorkCreated | null>(null);

  const create = async () => {
    setBusy(true);
    setFailure(null);
    try {
      setCreated(await api.createCustomWork({ path: folder.path, title: title.trim() }));
      onCreated();
    } catch (error) {
      setFailure(
        !(error instanceof ApiError) || error.status !== 409
          ? "customWorks.createFailed"
          : error.code === "custom_work_notice_required"
            ? "customWorks.noticeRequired"
            : "customWorks.unavailable",
      );
    } finally {
      setBusy(false);
    }
  };
  const openWork: MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState({}, "", event.currentTarget.getAttribute("href"));
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  return (
    <Dialog onClose={onClose} dismissible={!busy} size="sm">
      <DialogHeader
        title={t("customWorks.dialogTitle")}
        onClose={busy ? undefined : onClose}
        closeLabel={t("common.close")}
      />
      <DialogBody>
        {created ? (
          <p role="status" className="text-sm">
            {t("customWorks.created", { code: created.code, path: created.path })}
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <span className="block text-muted-foreground">{t("customWorks.folder")}</span>
              <p className="break-all">{folder.path}</p>
            </div>
            <label className="block space-y-1">
              <span className="block">{t("customWorks.title")}</span>
              <Input
                className="w-full"
                disabled={busy}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="space-y-1">
              <span className="block text-muted-foreground">{t("customWorks.newName")}</span>
              <p className="break-all font-medium">{t("customWorks.newNameValue", { name: folder.name.trim() })}</p>
            </div>
            <p className="rounded-md border border-warning-border bg-warning-surface p-2 text-warning-foreground">
              {t("customWorks.renameWarning")}
            </p>
            {failure && (
              <p role="alert" className="text-destructive">
                {t(failure)}
              </p>
            )}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        {created ? (
          <>
            <Button variant="outline" onClick={onClose}>
              {t("common.close")}
            </Button>
            <Button asChild>
              <a href={`/${created.code}`} onClick={openWork}>
                {t("customWorks.openWork")}
              </a>
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button disabled={busy} onClick={() => void create()}>
              {t("customWorks.confirm")}
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
