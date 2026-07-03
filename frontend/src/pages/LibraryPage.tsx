import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  Clock3,
  FileAudio,
  Filter,
  Folder,
  Headphones,
  ExternalLink,
  Pause,
  Play,
  Search,
  Star,
  Tags,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, assetURL, type ListeningStatus, type MediaItem, type Work, type WorkDetail } from "@/lib/api";
import { type PlayerTrack, usePlayer } from "@/player/PlayerProvider";

const WORK_CODE_PATTERN = /^\/((?:RJ|BJ|VJ|CC)\d{4,8})\/?$/i;
const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Paused" },
];

export function LibraryPage() {
  const [works, setWorks] = useState<Work[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(() => codeFromPath(window.location.pathname));
  const [selectedWork, setSelectedWork] = useState<WorkDetail | null>(null);
  const [isAPIAvailable, setIsAPIAvailable] = useState(false);
  const [statusFilter, setStatusFilter] = useState<ListeningStatus | "all">("all");

  useEffect(() => {
    api
      .listWorks()
      .then((items) => {
        setWorks(items);
        setIsAPIAvailable(true);
      })
      .catch(() => {
        setWorks([]);
        setIsAPIAvailable(false);
      });
  }, []);

  useEffect(() => {
    if (selectedCode === null) {
      setSelectedWork(null);
      return;
    }
    const work = works.find((item) => item.primaryCode.toUpperCase() === selectedCode.toUpperCase());
    if (!work) {
      if (works.length > 0) {
        setSelectedWork(null);
      }
      return;
    }
    api.getWork(work.id).then(setSelectedWork).catch(() => setSelectedWork(null));
  }, [selectedCode, works]);

  useEffect(() => {
    const handlePopState = () => setSelectedCode(codeFromPath(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const openWork = (work: Work) => {
    const path = `/${work.primaryCode}`;
    window.history.pushState({}, "", path);
    setSelectedCode(work.primaryCode);
  };

  const backToLibrary = () => {
    window.history.pushState({}, "", "/");
    setSelectedCode(null);
  };

  const updateWorkStatus = async (workID: number, status: ListeningStatus) => {
    const result = await api.updateWorkUserState(workID, { listeningStatus: status });
    setWorks((items) =>
      items.map((item) => (item.id === workID ? { ...item, listeningStatus: result.listeningStatus } : item)),
    );
    setSelectedWork((item) => (item?.id === workID ? { ...item, listeningStatus: result.listeningStatus } : item));
  };

  if (selectedCode !== null) {
    return <WorkDetailView code={selectedCode} work={selectedWork} onBack={backToLibrary} onStatusChange={updateWorkStatus} />;
  }

  const visibleWorks = statusFilter === "all" ? works : works.filter((work) => work.listeningStatus === statusFilter);

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-h-10 flex-1 items-center gap-2 rounded-lg border bg-card px-3 text-sm text-muted-foreground lg:max-w-xl">
          <Search className="h-4 w-4" />
          <span>Search title, code, circle, tag, or creator</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            className="h-8 rounded-md border bg-card px-3 text-xs font-medium outline-none focus:ring-2 focus:ring-ring"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as ListeningStatus | "all")}
            aria-label="Listening status filter"
          >
            <option value="all">All marks</option>
            {listeningStatusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm">
            <Filter className="h-4 w-4" />
            Filters
          </Button>
          <Button size="sm">
            <Headphones className="h-4 w-4" />
            {isAPIAvailable ? `${visibleWorks.length} works` : "Preview data"}
          </Button>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {visibleWorks.map((work) => (
          <WorkCard key={work.id} work={work} onOpen={() => openWork(work)} onStatusChange={updateWorkStatus} />
        ))}
      </section>
    </div>
  );
}

function WorkCard({
  work,
  onOpen,
  onStatusChange,
}: {
  work: Work;
  onOpen: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
}) {
  return (
    <button className="group text-left" onClick={onOpen}>
      <Card className="h-full overflow-hidden transition-colors hover:border-primary/50">
        <CardContent className="p-0">
          <div className="relative aspect-[4/3] overflow-hidden bg-muted">
            {work.coverUrl ? (
              <img
                src={assetURL(work.coverUrl)}
                alt=""
                className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]"
              />
            ) : (
              <div className="grid h-full place-items-center bg-secondary text-2xl font-bold text-secondary-foreground">
                {work.primaryCode.slice(0, 2)}
              </div>
            )}
            <a
              className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold hover:text-primary"
              href={work.dlsiteUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
            >
              {work.primaryCode}
              <ExternalLink className="h-3 w-3" />
            </a>
            <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">
              <Star className="h-3.5 w-3.5 fill-current" />
              {work.rating === null ? "No rating" : work.rating.toFixed(2)}
            </div>
          </div>
          <div className="space-y-3 p-4">
            <div className="space-y-1">
              <h2 className="line-clamp-2 min-h-10 text-base font-semibold leading-snug">{work.title}</h2>
              <p className="truncate text-sm text-muted-foreground">{work.circle || "Unknown circle"}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {work.listeningStatus !== "none" && <Badge variant="warning">{listeningStatusLabel(work.listeningStatus)}</Badge>}
              {work.availability.map((item) => (
                <Badge key={item} variant={item === "missing" ? "warning" : "secondary"}>
                  {item}
                </Badge>
              ))}
              {work.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <UserRound className="h-3.5 w-3.5" />
                <span className="truncate">{work.voiceActors.join(", ") || "No voice actor metadata"}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <FileAudio className="h-3.5 w-3.5" />
                <span>
                  {work.trackCount} tracks, {work.availableLocations} local files
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Tags className="h-3.5 w-3.5" />
                <select
                  className="h-7 min-w-0 flex-1 rounded-md border bg-card px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                  value={work.listeningStatus}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    event.stopPropagation();
                    void onStatusChange(work.id, event.target.value as ListeningStatus);
                  }}
                  aria-label={`Mark ${work.title}`}
                >
                  {listeningStatusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </button>
  );
}

function WorkDetailView({
  code,
  work,
  onBack,
  onStatusChange,
}: {
  code: string;
  work: WorkDetail | null;
  onBack: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
}) {
  const tree = useMemo(() => buildTree(work?.mediaItems ?? []), [work]);
  const allTracks = useMemo(() => flattenTracks(tree), [tree]);
  const player = usePlayer();

  const playTracks = (tracks: TreeTrack[], locationId: number) => {
    if (!work || tracks.length === 0) return;
    player.playQueue(tracks.map((track) => toPlayerTrack(track, work)), locationId);
    if (work.listeningStatus === "none" || work.listeningStatus === "want_to_listen") {
      void onStatusChange(work.id, "listening");
    }
  };

  const playAll = () => {
    if (work && allTracks.length > 0) {
      playTracks(allTracks, allTracks[0].locationId);
    }
  };

  if (!work) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">Loading {code}...</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Button variant="outline" size="sm" onClick={onBack}>
        <ChevronLeft className="h-4 w-4" />
        Back to library
      </Button>

      <section className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="self-start overflow-hidden rounded-lg border bg-muted">
          <div className="aspect-[4/3]">
            {work.coverUrl ? (
              <img src={assetURL(work.coverUrl)} alt="" className="h-full w-full object-contain" />
            ) : (
              <div className="grid h-full place-items-center text-4xl font-bold">{work.primaryCode.slice(0, 2)}</div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <div className="text-sm font-semibold text-primary">{work.primaryCode}</div>
            <h2 className="mt-1 text-2xl font-semibold leading-tight lg:text-3xl">{work.title}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{work.circle || "Unknown circle"}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={playAll} disabled={allTracks.length === 0}>
              <Play className="h-4 w-4" />
              Play
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={work.dlsiteUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                DLsite
              </a>
            </Button>
            <Button variant="outline" size="sm">
              Sync DLsite
            </Button>
            <select
              className="h-8 rounded-md border bg-card px-3 text-xs font-medium outline-none focus:ring-2 focus:ring-ring"
              value={work.listeningStatus}
              onChange={(event) => void onStatusChange(work.id, event.target.value as ListeningStatus)}
              aria-label="Listening mark"
            >
              {listeningStatusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <MetaTile icon={<Star className="h-4 w-4 fill-current" />} label="DL rating" value={work.rating === null ? "No rating" : work.rating.toFixed(2)} />
            <MetaTile icon={<Clock3 className="h-4 w-4" />} label="Released" value={work.releaseDate ?? "Unknown"} />
            <MetaTile icon={<FileAudio className="h-4 w-4" />} label="Local files" value={`${work.mediaItems.length} tracks`} />
          </div>

          <InfoRow icon={<CircleUserRound className="h-4 w-4" />} label="Voice" value={work.voiceActors.join(", ") || "No voice actor metadata"} />
          <InfoRow icon={<Tags className="h-4 w-4" />} label="Tags" value={work.tags.join(", ") || "No tag metadata"} />
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-lg font-semibold">Local directory</h3>
          <p className="text-sm text-muted-foreground">Files detected for this work under the configured local source.</p>
        </div>
        <Card>
          <CardContent className="p-4">
            <DirectoryTree root={tree} currentLocationId={player.currentTrack?.locationId ?? null} onPlayFolder={playTracks} />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function MetaTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <div className="break-words text-muted-foreground">{value}</div>
      </div>
    </div>
  );
}

type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  files: TreeTrack[];
};

type TreeTrack = {
  mediaItemId: number;
  locationId: number;
  title: string;
  folderPath: string;
  streamUrl: string;
  sizeBytes: number | null;
  availability: string;
  progress: MediaItem["progress"];
};

function buildTree(items: MediaItem[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), files: [] };
  for (const item of items) {
    const location = item.locations.find((candidate) => candidate.availability === "available" && candidate.streamUrl) ?? item.locations[0];
    if (!location) continue;
    const parts = location.path.split("/").filter(Boolean);
    const fileName = parts.pop() ?? item.title;
    let cursor = root;
    for (const part of parts) {
      if (!cursor.children.has(part)) {
        const childPath = cursor.path ? `${cursor.path}/${part}` : part;
        cursor.children.set(part, { name: part, path: childPath, children: new Map(), files: [] });
      }
      cursor = cursor.children.get(part)!;
    }
    cursor.files.push({
      mediaItemId: item.id,
      locationId: location.id,
      title: fileName,
      folderPath: cursor.path,
      streamUrl: location.streamUrl,
      sizeBytes: location.sizeBytes,
      availability: location.availability,
      progress: item.progress,
    });
  }
  return root;
}

function DirectoryTree({
  root,
  currentLocationId,
  onPlayFolder,
}: {
  root: TreeNode;
  currentLocationId: number | null;
  onPlayFolder: (tracks: TreeTrack[], locationId: number) => void;
}) {
  const folders = Array.from(root.children.values());
  if (folders.length === 0 && root.files.length === 0) {
    return <div className="text-sm text-muted-foreground">No local files detected.</div>;
  }
  return (
    <div className="space-y-2">
      {root.files.map((file) => (
        <TreeFile
          key={file.locationId}
          file={file}
          files={root.files}
          depth={0}
          isActive={file.locationId === currentLocationId}
          onPlayFolder={onPlayFolder}
        />
      ))}
      {folders.map((node) => (
        <TreeFolder
          key={node.path}
          node={node}
          depth={0}
          currentLocationId={currentLocationId}
          onPlayFolder={onPlayFolder}
        />
      ))}
    </div>
  );
}

function TreeFolder({
  node,
  depth,
  currentLocationId,
  onPlayFolder,
}: {
  node: TreeNode;
  depth: number;
  currentLocationId: number | null;
  onPlayFolder: (tracks: TreeTrack[], locationId: number) => void;
}) {
  const [isOpen, setIsOpen] = useState(depth < 2);
  const childFolders = Array.from(node.children.values());
  const playableFiles = node.files.filter((file) => file.availability === "available" && file.streamUrl);
  return (
    <div className="space-y-1">
      <button
        className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-muted"
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => setIsOpen((value) => !value)}
      >
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <Folder className="h-4 w-4 shrink-0 text-primary" />
        <span className="truncate">{node.name}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {playableFiles.length} audio
        </span>
      </button>
      {isOpen && (
        <>
          {childFolders.map((child) => (
            <TreeFolder
              key={child.path}
              node={child}
              depth={depth + 1}
              currentLocationId={currentLocationId}
              onPlayFolder={onPlayFolder}
            />
          ))}
          {node.files.map((file) => (
            <TreeFile
              key={file.locationId}
              file={file}
              files={playableFiles}
              depth={depth + 1}
              isActive={file.locationId === currentLocationId}
              onPlayFolder={onPlayFolder}
            />
          ))}
        </>
      )}
    </div>
  );
}

function TreeFile({
  file,
  files,
  depth,
  isActive,
  onPlayFolder,
}: {
  file: TreeTrack;
  files: TreeTrack[];
  depth: number;
  isActive: boolean;
  onPlayFolder: (tracks: TreeTrack[], locationId: number) => void;
}) {
  const canPlay = file.availability === "available" && file.streamUrl;
  return (
    <button
      className={`flex min-h-9 w-full items-center justify-between gap-3 rounded-md border px-3 text-left text-sm ${
        isActive ? "border-primary bg-secondary" : "bg-background hover:bg-muted"
      }`}
      style={{ marginLeft: depth * 14, width: `calc(100% - ${depth * 14}px)` }}
      disabled={!canPlay}
      onClick={() => onPlayFolder(files, file.locationId)}
    >
      <div className="flex min-w-0 items-center gap-2">
        {isActive ? <Pause className="h-4 w-4 text-primary" /> : <FileAudio className="h-4 w-4 text-muted-foreground" />}
        <span className="truncate">{file.title}</span>
      </div>
      <div className="shrink-0 text-xs text-muted-foreground">
        {formatBytes(file.sizeBytes)} · {file.availability}
      </div>
    </button>
  );
}

function flattenTracks(root: TreeNode) {
  const tracks: TreeTrack[] = [];
  const visit = (node: TreeNode) => {
    tracks.push(...node.files.filter((file) => file.availability === "available" && file.streamUrl));
    for (const child of node.children.values()) {
      visit(child);
    }
  };
  visit(root);
  return tracks;
}

function toPlayerTrack(track: TreeTrack, work: WorkDetail): PlayerTrack {
  return {
    ...track,
    workId: work.id,
    workCode: work.primaryCode,
    workTitle: work.title,
    coverUrl: work.coverUrl,
    circle: work.circle,
    progress: track.progress,
  };
}

function formatBytes(value: number | null) {
  if (value === null) return "unknown";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function listeningStatusLabel(status: ListeningStatus) {
  return listeningStatusOptions.find((option) => option.value === status)?.label ?? "Unmarked";
}

function codeFromPath(path: string) {
  const match = path.match(WORK_CODE_PATTERN);
  return match ? match[1].toUpperCase() : null;
}
