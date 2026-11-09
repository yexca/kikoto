import { ChevronRight, Folder, Image as ImageIcon, Play, RefreshCw, ScanLine, Video } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useAuth } from "@/auth/AuthProvider";
import { assetURL, api, type RecordAsset, type RecordFolder, type RecordRoot } from "@/lib/api";

type Breadcrumb = { id: number; name: string };

export function RecordsPage() {
  const auth = useAuth();
  const { notify } = useToast();
  const [root, setRoot] = useState<RecordRoot | null>(null);
  const [folderId, setFolderId] = useState(0);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [folders, setFolders] = useState<RecordFolder[]>([]);
  const [assets, setAssets] = useState<RecordAsset[]>([]);
  const [selected, setSelected] = useState<RecordAsset | null>(null);
  const [loading, setLoading] = useState(true);
  const [treeLoading, setTreeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRoot = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getRecordRoot();
      setRoot(result.root);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The record library could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFolder = useCallback(async (nextID: number, nextBreadcrumbs: Breadcrumb[]) => {
    setTreeLoading(true);
    try {
      const result = await api.listRecordTree(nextID || undefined);
      setFolderId(nextID);
      setBreadcrumbs(nextBreadcrumbs);
      setFolders(result.folders);
      setAssets(result.assets);
      setSelected(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The record directory could not be read.");
    } finally {
      setTreeLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  useEffect(() => {
    if (root?.state === "online") void loadFolder(0, []);
  }, [loadFolder, root?.state]);

  const initialize = async () => {
    try {
      const result = await api.initializeRecordRoot();
      setRoot(result.root);
      notify({ kind: "success", message: "Home video library initialized." });
    } catch (cause) {
      notify({ kind: "error", message: cause instanceof Error ? cause.message : "Initialization failed." });
    }
  };

  const scan = async () => {
    try {
      await api.queueRecordScan();
      notify({ kind: "success", message: "Record library scan queued." });
      await loadRoot();
    } catch (cause) {
      notify({ kind: "error", message: cause instanceof Error ? cause.message : "The scan could not be queued." });
    }
  };

  const openFolder = (folder: RecordFolder) => {
    void loadFolder(folder.id, [...breadcrumbs, { id: folder.id, name: folder.name }]);
  };

  const goToBreadcrumb = (index: number) => {
    if (index < 0) {
      void loadFolder(0, []);
      return;
    }
    const target = breadcrumbs[index];
    void loadFolder(target.id, breadcrumbs.slice(0, index + 1));
  };

  const title =
    breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].name : (root?.displayName ?? "Home videos");

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading home videos…</div>;

  if (auth.demoMode) {
    return (
      <section className="mx-auto max-w-2xl rounded-[var(--card-radius)] border bg-card p-6">
        <h2 className="text-lg font-semibold">Home videos are unavailable in Demo</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect to a normal Kikoto instance to configure a record root.
        </p>
      </section>
    );
  }

  if (!root || root.state === "unconfigured") {
    return (
      <section className="mx-auto flex max-w-2xl flex-col gap-4 rounded-[var(--card-radius)] border bg-card p-6 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold">Set up home videos</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Initialize the independent record root, then scan it for videos and images.
          </p>
        </div>
        {auth.hasPermission("sources:write") ? (
          <Button onClick={() => void initialize()}>Initialize root</Button>
        ) : (
          <p className="text-sm text-muted-foreground">An administrator must initialize the record root.</p>
        )}
      </section>
    );
  }

  if (root.state !== "online") {
    return (
      <section className="mx-auto flex max-w-2xl flex-col gap-4 rounded-[var(--card-radius)] border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Home video root unavailable</h2>
        <p className="text-sm text-muted-foreground">
          The record root is {root.state}. Existing records remain preserved until the directory is available again.
        </p>
        <Button variant="outline" onClick={() => void loadRoot()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </section>
    );
  }

  return (
    <div className="flex min-h-[60vh] flex-col gap-4 lg:flex-row">
      <aside className="w-full shrink-0 rounded-[var(--card-radius)] border bg-card p-3 lg:w-64">
        <div className="mb-2 flex items-center justify-between gap-2 px-2">
          <span className="text-sm font-medium">Folders</span>
          {auth.hasPermission("library:write") && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Scan record library"
              title="Scan record library"
              onClick={() => void scan()}
            >
              <ScanLine className="h-4 w-4" />
            </Button>
          )}
        </div>
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
          onClick={() => goToBreadcrumb(-1)}
        >
          <Folder className="h-4 w-4 text-primary" />
          {root.displayName}
        </button>
        {breadcrumbs.map((crumb, index) => (
          <button
            key={crumb.id}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 pl-6 text-left text-sm hover:bg-muted"
            onClick={() => goToBreadcrumb(index)}
          >
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            {crumb.name}
          </button>
        ))}
      </aside>

      <section className="min-w-0 flex-1 rounded-[var(--card-radius)] border bg-card p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="text-sm text-muted-foreground">
              {folders.length} folders · {assets.filter((asset) => asset.kind === "video").length} videos
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadFolder(folderId, breadcrumbs)}
            disabled={treeLoading}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
        {error && (
          <p className="mb-4 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground">
            {error}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {folders.map((folder) => (
            <button
              key={folder.id}
              className="group flex min-h-24 items-center gap-3 rounded-lg border p-3 text-left hover:border-primary/50 hover:bg-muted/40"
              onClick={() => openFolder(folder)}
            >
              {folder.artwork.posterUrl ? (
                <img src={assetURL(folder.artwork.posterUrl)} alt="" className="h-16 w-16 rounded object-cover" />
              ) : (
                <span className="grid h-16 w-16 place-items-center rounded bg-primary/10">
                  <Folder className="h-7 w-7 text-primary" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate font-medium">{folder.name}</span>
                <span className="text-xs text-muted-foreground">
                  {folder.childCount} folders · {folder.assetCount} files
                </span>
              </span>
            </button>
          ))}
          {assets
            .filter((asset) => asset.kind !== "subtitle" && asset.kind !== "metadata" && asset.kind !== "other")
            .map((asset) => (
              <button
                key={asset.id}
                className="group flex min-h-24 items-center gap-3 rounded-lg border p-3 text-left hover:border-primary/50 hover:bg-muted/40"
                onClick={() => setSelected(asset)}
              >
                <span className="grid h-16 w-16 place-items-center rounded bg-muted">
                  {asset.kind === "video" ? (
                    <Video className="h-7 w-7 text-primary" />
                  ) : (
                    <ImageIcon className="h-7 w-7 text-muted-foreground" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{asset.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {asset.kind === "video" ? formatDuration(asset.durationSeconds) : "Image"}
                  </span>
                </span>
              </button>
            ))}
        </div>
        {selected && <RecordPreview asset={selected} onProgressSaved={() => {}} />}
      </section>
    </div>
  );
}

function RecordPreview({ asset, onProgressSaved }: { asset: RecordAsset; onProgressSaved: () => void }) {
  const [progress, setProgress] = useState(0);
  const [initialPosition, setInitialPosition] = useState(0);
  const source = asset.streamUrl ? assetURL(asset.streamUrl) : "";
  useEffect(() => {
    if (asset.kind !== "video") return;
    void api
      .getRecordProgress(asset.id)
      .then((saved) => setInitialPosition(saved.positionSeconds || 0))
      .catch(() => {});
  }, [asset.id, asset.kind]);
  if (asset.kind === "image") {
    return (
      <div className="mt-6 overflow-hidden rounded-lg border bg-black/5 p-3">
        <img src={source} alt={asset.name} className="mx-auto max-h-[60vh] max-w-full object-contain" />
      </div>
    );
  }
  if (asset.kind !== "video" || !source) return null;
  return (
    <div className="mt-6 overflow-hidden rounded-lg border bg-black p-2">
      <video
        className="mx-auto max-h-[65vh] max-w-full"
        controls
        preload="metadata"
        src={source}
        onLoadedMetadata={(event) => {
          if (
            initialPosition > 0 &&
            Number.isFinite(initialPosition) &&
            initialPosition < event.currentTarget.duration
          ) {
            event.currentTarget.currentTime = initialPosition;
          }
          setProgress(event.currentTarget.currentTime);
        }}
        onTimeUpdate={(event) => setProgress(event.currentTarget.currentTime)}
        onPause={(event) => {
          void api
            .updateRecordProgress(asset.id, {
              positionSeconds: event.currentTarget.currentTime,
              durationSeconds: event.currentTarget.duration || undefined,
              completed: event.currentTarget.ended,
            })
            .then(onProgressSaved)
            .catch(() => {});
        }}
      />
      <div className="flex items-center gap-2 px-2 pt-2 text-xs text-white/70">
        <Play className="h-3.5 w-3.5" />
        {formatDuration(progress)} · {asset.name}
      </div>
    </div>
  );
}

function formatDuration(value?: number) {
  if (!value || !Number.isFinite(value)) return "Video";
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (total % 60).toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}
