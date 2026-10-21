import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderSearch,
  Inbox,
  ListTree,
  PencilLine,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEventHandler, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AcceptanceNotice } from "@/components/AcceptanceNotice";
import { badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  api,
  ApiError,
  type CustomWorkCreated,
  type CustomWorkFolder,
  type CustomWorkTree,
  type CustomWorkTreeFolder,
} from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { cn } from "@/lib/tailwindClassNames";
import { useMaintenanceSearch } from "./MaintenanceControls";

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

type PickMethod = "found" | "browse" | "path";
const pickMethods: Array<{ id: PickMethod; icon: typeof Folder }> = [
  { id: "found", icon: FolderSearch },
  { id: "browse", icon: ListTree },
  { id: "path", icon: PencilLine },
];

/**
 * Adds a custom work in two steps: choose a library folder without a work
 * code, from the folders a walk found, a folder tree that leaves out work
 * folders, or a typed path; then confirm its title and the rename. The page
 * opens it only once the rename notice is accepted.
 */
export function CustomWorkAddDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<PickMethod>("found");
  // Each method keeps its own choice, so Next always uses the folder shown.
  const [choices, setChoices] = useState<Record<PickMethod, CustomWorkFolder | null>>({
    found: null,
    browse: null,
    path: null,
  });
  const selected = choices[method];
  const [step, setStep] = useState<"choose" | "confirm">("choose");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<CustomWorkCreated | null>(null);

  const chooser = (from: PickMethod) => (folder: CustomWorkFolder | null) => {
    setChoices((current) => ({ ...current, [from]: folder }));
    setFailure(null);
  };
  const next = () => {
    if (!selected) return;
    setTitle(selected.name);
    setStep("confirm");
  };
  const create = async () => {
    if (!selected) return;
    setBusy(true);
    setFailure(null);
    try {
      setCreated(await api.createCustomWork({ path: selected.path, title: title.trim() }));
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
    onClose();
    window.history.pushState({}, "", event.currentTarget.getAttribute("href"));
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  const choosing = !created && step === "choose";
  return (
    <Dialog onClose={onClose} dismissible={!busy} size={choosing ? "xl" : "md"} marker="custom-work-add">
      <DialogHeader
        title={t("customWorks.addTitle")}
        description={choosing ? t("customWorks.addDescription") : undefined}
        onClose={busy ? undefined : onClose}
        closeLabel={t("common.close")}
      />
      {created ? (
        <>
          <DialogBody>
            <p role="status" className="text-sm">
              {t("customWorks.created", { code: created.code, path: created.path })}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t("common.close")}
            </Button>
            <Button asChild>
              <a href={`/${created.code}`} onClick={openWork}>
                {t("customWorks.openWork")}
              </a>
            </Button>
          </DialogFooter>
        </>
      ) : step === "confirm" && selected ? (
        <>
          <DialogBody>
            <div className="space-y-3 text-sm">
              <div className="space-y-1">
                <span className="block text-muted-foreground">{t("customWorks.folder")}</span>
                <p className="break-all">{selected.path}</p>
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
                <p className="break-all font-medium">{t("customWorks.newNameValue", { name: selected.name.trim() })}</p>
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
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setStep("choose")}>
              {t("customWorks.back")}
            </Button>
            <Button disabled={busy} onClick={() => void create()}>
              {t("customWorks.confirm")}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <>
          <DialogBody className="space-y-3">
            {/* The picker keeps one height across methods, so the centered dialog does not jump. */}
            <div className="min-h-[min(32rem,60vh)] space-y-3">
              <div role="tablist" aria-label={t("customWorks.methodLabel")} className={segmentedListClassName()}>
                {pickMethods.map(({ id, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    id={`custom-work-method-${id}`}
                    aria-selected={method === id}
                    aria-controls={`custom-work-panel-${id}`}
                    className={segmentedItemClassName(method === id)}
                    onClick={() => setMethod(id)}
                  >
                    <Icon className="h-4 w-4 max-sm:hidden" />
                    {t(`customWorks.methods.${id}`)}
                  </button>
                ))}
              </div>
              {/* Each method keeps its state while another is shown. */}
              <FoundFolders hidden={method !== "found"} selected={choices.found} onSelect={chooser("found")} />
              <FolderTree hidden={method !== "browse"} selected={choices.browse} onSelect={chooser("browse")} />
              <TypedPath hidden={method !== "path"} selected={choices.path} onSelect={chooser("path")} />
            </div>
          </DialogBody>
          <DialogFooter className="justify-between">
            <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground" aria-live="polite">
              {selected ? t("customWorks.selected", { path: selected.path }) : t("customWorks.noneSelected")}
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button disabled={!selected} onClick={next}>
                {t("customWorks.next")}
              </Button>
            </div>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}

function ReasonBadge({ reason }: { reason: NonNullable<CustomWorkTreeFolder["reason"]> }) {
  const { t } = useTranslation();
  // Fetch holding a folder is a temporary state worth a warning; the others only explain the folder.
  return (
    <span className={cn(badgeVariants({ variant: reason === "in_use" ? "warning" : "secondary" }), "shrink-0")}>
      {t(`customWorks.reasons.${reason}`)}
    </span>
  );
}

function sameFolder(selected: CustomWorkFolder | null, path: string) {
  return selected?.path === path;
}

function FolderRowLabel({ name, path, muted }: { name: string; path?: string; muted?: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <span className={cn("block truncate text-sm font-medium", muted && "text-muted-foreground")}>{name}</span>
      {path && <span className="block truncate text-xs text-muted-foreground">{path}</span>}
    </span>
  );
}

/**
 * The folders a walk of the library finds that can become custom works. The
 * walk reads every folder within the scan depth, so it starts only when asked.
 */
function FoundFolders({
  hidden,
  selected,
  onSelect,
}: {
  hidden: boolean;
  selected: CustomWorkFolder | null;
  onSelect: (folder: CustomWorkFolder) => void;
}) {
  const { t } = useTranslation();
  const search = useMaintenanceSearch(() => undefined);
  const [folders, setFolders] = useState<CustomWorkFolder[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // Zero until the first scan is requested; each request walks the library again.
  const [refresh, setRefresh] = useState(0);
  const scan = () => setRefresh((value) => value + 1);

  useEffect(() => {
    if (refresh === 0) return;
    const controller = new AbortController();
    setLoading(true);
    void api
      .listCustomWorkFolders(search.query, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setFolders(next.folders);
        setTruncated(next.truncated);
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
    <div
      role="tabpanel"
      id="custom-work-panel-found"
      aria-labelledby="custom-work-method-found"
      hidden={hidden}
      className="space-y-3"
    >
      <p className="text-sm text-muted-foreground">{t("customWorks.foundIntro")}</p>
      {refresh === 0 ? (
        <div className="grid min-h-64 place-items-center rounded-lg border border-dashed bg-card px-6 py-10 text-center">
          <div>
            <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
              <FolderSearch className="h-4 w-4" />
            </div>
            <p className="text-sm text-muted-foreground">{t("customWorks.scanHint")}</p>
            <Button className="mt-4" onClick={scan}>
              <FolderSearch className="h-4 w-4" />
              {t("customWorks.scan")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="w-full pl-8"
                aria-label={t("customWorks.search")}
                placeholder={t("customWorks.searchPlaceholder")}
                value={search.draft}
                onChange={(event) => search.setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") search.commit();
                }}
              />
            </div>
            <Button variant="outline" disabled={loading} onClick={scan}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              {t("customWorks.rescan")}
            </Button>
          </div>
          {failed && (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <span>{t("customWorks.loadFailed")}</span>
              <Button variant="outline" size="sm" onClick={scan}>
                {t("metadataEntries.retry")}
              </Button>
            </div>
          )}
          <section
            className="max-h-[min(24rem,50vh)] overflow-y-auto rounded-lg border bg-card app-scrollbar"
            aria-label={t("customWorks.folders")}
            aria-busy={loading}
          >
            {loading && !loaded ? (
              <p className="grid min-h-40 place-items-center p-4 text-sm text-muted-foreground" role="status">
                {t("common.loading")}
              </p>
            ) : folders.length ? (
              <ul className="divide-y">
                {folders.map((folder) => {
                  const active = sameFolder(selected, folder.path);
                  return (
                    <li key={folder.path}>
                      <button
                        type="button"
                        disabled={folder.inUse}
                        aria-pressed={active}
                        className={cn(
                          "flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:hover:bg-transparent",
                          active && "bg-primary/10 hover:bg-primary/10",
                        )}
                        onClick={() => onSelect(folder)}
                      >
                        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <FolderRowLabel name={folder.name} path={folder.path} muted={folder.inUse} />
                        {folder.inUse && <ReasonBadge reason="in_use" />}
                        {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              !failed && (
                <div className="grid min-h-40 place-items-center px-6 py-8 text-center">
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
        </>
      )}
    </div>
  );
}

type TreeLevel = { state: "loading" } | { state: "failed" } | ({ state: "loaded" } & CustomWorkTree);

/**
 * The library's folders as a tree that leaves out work folders. A folder that
 * holds works stays visible so the folders beside its works can be reached.
 */
function FolderTree({
  hidden,
  selected,
  onSelect,
}: {
  hidden: boolean;
  selected: CustomWorkFolder | null;
  onSelect: (folder: CustomWorkFolder) => void;
}) {
  const { t } = useTranslation();
  const [levels, setLevels] = useState<Record<string, TreeLevel>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [started, setStarted] = useState(false);

  const load = (path: string) => {
    setLevels((current) => ({ ...current, [path]: { state: "loading" } }));
    api.listCustomWorkTree(path).then(
      (tree) => setLevels((current) => ({ ...current, [path]: { state: "loaded", ...tree } })),
      () => setLevels((current) => ({ ...current, [path]: { state: "failed" } })),
    );
  };
  // The tree reads the library only once it is first shown.
  useEffect(() => {
    if (hidden || started) return;
    setStarted(true);
    load("");
  }, [hidden, started]);

  const toggle = (path: string) => {
    const opening = !expanded.has(path);
    if (opening && (!levels[path] || levels[path].state === "failed")) load(path);
    setExpanded((current) => {
      const nextExpanded = new Set(current);
      if (opening) nextExpanded.add(path);
      else nextExpanded.delete(path);
      return nextExpanded;
    });
  };

  const renderLevel = (path: string, depth: number) => {
    const level = levels[path];
    const indent = { paddingLeft: `${depth * 1.25 + 0.5}rem` };
    if (!level || level.state === "loading") {
      return (
        <p role="status" className="py-2 text-sm text-muted-foreground" style={indent}>
          {t("common.loading")}
        </p>
      );
    }
    if (level.state === "failed") {
      return (
        <div role="alert" className="flex items-center gap-3 py-2 text-sm" style={indent}>
          <span>{t("customWorks.treeLoadFailed")}</span>
          <Button variant="outline" size="sm" onClick={() => load(path)}>
            {t("metadataEntries.retry")}
          </Button>
        </div>
      );
    }
    if (level.folders.length === 0) {
      return (
        <p className="py-2 text-sm text-muted-foreground" style={indent}>
          {path ? t("customWorks.treeEmptyFolder") : t("customWorks.empty")}
        </p>
      );
    }
    return (
      <ul role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? t("customWorks.methods.browse") : undefined}>
        {level.folders.map((folder) => (
          <TreeRow
            key={folder.path}
            folder={folder}
            depth={depth}
            open={expanded.has(folder.path)}
            active={sameFolder(selected, folder.path)}
            onToggle={() => toggle(folder.path)}
            onSelect={() => onSelect({ path: folder.path, name: folder.name, inUse: false })}
          >
            {expanded.has(folder.path) && renderLevel(folder.path, depth + 1)}
          </TreeRow>
        ))}
        {level.truncated && (
          <li className="py-2 text-xs text-muted-foreground" style={indent}>
            {t("customWorks.truncated", { count: level.folders.length })}
          </li>
        )}
      </ul>
    );
  };

  return (
    <div
      role="tabpanel"
      id="custom-work-panel-browse"
      aria-labelledby="custom-work-method-browse"
      hidden={hidden}
      className="space-y-3"
    >
      <p className="text-sm text-muted-foreground">{t("customWorks.browseIntro")}</p>
      <div className="max-h-[min(26rem,55vh)] overflow-y-auto rounded-lg border bg-card py-1 app-scrollbar">
        {renderLevel("", 0)}
      </div>
    </div>
  );
}

function TreeRow({
  folder,
  depth,
  open,
  active,
  onToggle,
  onSelect,
  children,
}: {
  folder: CustomWorkTreeFolder;
  depth: number;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  onSelect: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  // A folder that cannot be selected opens instead, so the whole row stays useful.
  const activate = () => (folder.selectable ? onSelect() : folder.hasChildren && onToggle());
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!folder.hasChildren) return;
    if ((event.key === "ArrowRight" && !open) || (event.key === "ArrowLeft" && open)) {
      event.preventDefault();
      onToggle();
    }
  };
  return (
    <li
      role="treeitem"
      aria-expanded={folder.hasChildren ? open : undefined}
      aria-selected={folder.selectable ? active : undefined}
      aria-label={folder.name}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-1 pr-2 transition-colors hover:bg-muted/60",
          active && "bg-primary/10 hover:bg-primary/10",
        )}
        style={{ paddingLeft: `${depth * 1.25 + 0.25}rem` }}
      >
        {folder.hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            className="grid h-7 w-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t(open ? "customWorks.collapse" : "customWorks.expand", { name: folder.name })}
            onClick={onToggle}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="h-7 w-7 shrink-0" />
        )}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left disabled:cursor-default"
          disabled={!folder.selectable && !folder.hasChildren}
          onClick={activate}
          onKeyDown={onKeyDown}
        >
          <Folder className={cn("h-4 w-4 shrink-0", folder.selectable ? "text-primary" : "text-muted-foreground")} />
          <FolderRowLabel name={folder.name} muted={!folder.selectable} />
          {folder.reason && <ReasonBadge reason={folder.reason} />}
          {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
        </button>
      </div>
      {children}
    </li>
  );
}

/** A folder path typed or pasted by the administrator, checked by the server. */
function TypedPath({
  hidden,
  selected,
  onSelect,
}: {
  hidden: boolean;
  selected: CustomWorkFolder | null;
  onSelect: (folder: CustomWorkFolder | null) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ folder: CustomWorkFolder } | { error: string } | null>(null);
  const inputId = useId();
  // Editing the path during a check makes that check's answer stale.
  const request = useRef(0);

  const check = async () => {
    if (!value.trim()) return;
    const current = ++request.current;
    setChecking(true);
    setResult(null);
    onSelect(null);
    try {
      const folder = await api.getCustomWorkFolder(value);
      if (current !== request.current) return;
      setResult({ folder });
      onSelect(folder.inUse ? null : folder);
    } catch (error) {
      if (current !== request.current) return;
      setResult({
        error:
          error instanceof ApiError && (error.status === 409 || error.status === 400)
            ? "customWorks.pathUnavailable"
            : "customWorks.pathCheckFailed",
      });
    } finally {
      if (current === request.current) setChecking(false);
    }
  };

  return (
    <div
      role="tabpanel"
      id="custom-work-panel-path"
      aria-labelledby="custom-work-method-path"
      hidden={hidden}
      className="space-y-3"
    >
      <div className="space-y-1">
        <label htmlFor={inputId} className="block text-sm">
          {t("customWorks.pathLabel")}
        </label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            className="min-w-0 flex-1 font-mono"
            placeholder={t("customWorks.pathPlaceholder")}
            aria-describedby={`${inputId}-hint`}
            value={value}
            onChange={(event) => {
              request.current += 1;
              setChecking(false);
              setValue(event.target.value);
              setResult(null);
              onSelect(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void check();
            }}
          />
          <Button variant="outline" disabled={checking || !value.trim()} onClick={() => void check()}>
            {t("customWorks.checkPath")}
          </Button>
        </div>
        <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
          {t("customWorks.pathHint")}
        </p>
      </div>
      {result && "folder" in result && (
        <div
          role="status"
          className={cn(
            "flex items-center gap-3 rounded-md border p-3 text-sm",
            sameFolder(selected, result.folder.path) && "border-primary/40 bg-primary/10",
          )}
        >
          <Folder className="h-4 w-4 shrink-0 text-primary" />
          <FolderRowLabel name={result.folder.name} path={result.folder.path} />
          {result.folder.inUse ? (
            <ReasonBadge reason="in_use" />
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">{t("customWorks.pathAvailable")}</span>
          )}
        </div>
      )}
      {result && "error" in result && (
        <p role="alert" className="text-sm text-destructive">
          {t(result.error)}
        </p>
      )}
    </div>
  );
}
