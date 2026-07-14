import type { MediaItem, RemoteTrack, RemoteWorkDetail, WorkDetail } from "../../../lib/api";
import type { PlayerTrack, PlayerTrackLocation } from "../../../player/PlayerProvider";
import { findLyricsMatches } from "../../../player/lyricsMatching";

export type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  files: TreeTrack[];
};

export type TreeTrack = {
  mediaItemId: number;
  locationId: number;
  title: string;
  baseName: string;
  sourcePath: string;
  kind: string;
  folderPath: string;
  locationType: string;
  streamUrl: string;
  downloadUrl: string;
  assetUrl: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  availability: string;
  cacheLocationId: number | null;
  cachePath: string;
  cacheAvailable: boolean;
  cacheStreamUrl: string;
  localLocationId: number | null;
  localPath: string;
  localAvailable: boolean;
  progress: MediaItem["progress"];
  locations: PlayerTrackLocation[];
};

export type TreeStats = {
  files: number;
  audio: number;
  sizeBytes: number;
  knownSizeFiles: number;
  durationSeconds: number;
  knownDurationAudio: number;
};

export function emptyTree(): TreeNode {
  return { name: "", path: "", children: new Map(), files: [] };
}

export function buildTree(items: MediaItem[], fileSourceId: number | null, workCode: string): TreeNode {
  const root = emptyTree();
  for (const item of items) {
    const sourceLocations = fileSourceId === null ? item.locations : item.locations.filter((location) => location.fileSourceId === fileSourceId);
    const location = sourceLocations.find((candidate) => candidate.availability === "available" && candidate.streamUrl) ?? sourceLocations[0];
    if (!location) continue;
    const cacheLocation = sourceLocations.find((candidate) => candidate.locationType === "cache" && candidate.availability === "available");
    const localLocation = sourceLocations.find((candidate) => candidate.locationType === "local" && candidate.availability === "available");
    const parts = displayPathParts(location.path, location.locationType, workCode);
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
      baseName: baseNameWithoutExtension(fileName),
      sourcePath: parts.length > 0 ? `${parts.join("/")}/${fileName}` : fileName,
      kind: item.kind,
      folderPath: cursor.path,
      locationType: location.locationType,
      streamUrl: location.streamUrl,
      downloadUrl: location.downloadUrl,
      assetUrl: location.locationType === "local" ? versionedMediaAssetURL(location.id, item.fingerprint, location.sizeBytes) : location.downloadUrl,
      sizeBytes: location.sizeBytes,
      durationSeconds: location.durationSeconds ?? item.durationSeconds,
      availability: location.availability,
      cacheLocationId: cacheLocation?.id ?? null,
      cachePath: cacheLocation?.path ?? "",
      cacheAvailable: Boolean(cacheLocation),
      cacheStreamUrl: cacheLocation ? `/api/media/${cacheLocation.id}/stream` : "",
      localLocationId: localLocation?.id ?? null,
      localPath: localLocation?.path ?? "",
      localAvailable: Boolean(localLocation),
      progress: item.progress,
      locations: item.locations
        .filter((candidate) => candidate.streamUrl && ["available", "remote"].includes(candidate.availability))
        .map((candidate) => ({
          locationId: candidate.id,
          locationType: candidate.locationType,
          streamUrl: candidate.streamUrl,
          sourceId: candidate.fileSourceId,
          sourceName: candidate.fileSourceName,
          availability: candidate.availability,
        })),
    });
  }
  return normalizeDisplayTree(root);
}

export function buildRemoteTree(tracks: RemoteTrack[]): TreeNode {
  let nextID = -1;
  const root = emptyTree();
  const walk = (nodes: RemoteTrack[], cursor: TreeNode) => {
    nodes.forEach((node, index) => {
      const title = (node.title ?? "").trim() || `Track ${index + 1}`;
      const children = node.children ?? [];
      if (children.length > 0 || node.type === "folder") {
        const childPath = cursor.path ? `${cursor.path}/${title}` : title;
        const child = cursor.children.get(title) ?? { name: title, path: childPath, children: new Map(), files: [] };
        cursor.children.set(title, child);
        walk(children, child);
        return;
      }
      const hasCache = node.cacheAvailable && node.cacheLocationId !== null;
      cursor.files.push({
        mediaItemId: nextID,
        locationId: hasCache ? node.cacheLocationId! : nextID,
        title,
        baseName: baseNameWithoutExtension(title),
        sourcePath: cursor.path ? `${cursor.path}/${title}` : title,
        kind: node.type || "file",
        folderPath: cursor.path,
        locationType: hasCache ? "cache" : "remote_stream",
        streamUrl: hasCache ? `/api/media/${node.cacheLocationId}/stream` : node.streamUrl,
        downloadUrl: node.downloadUrl,
        assetUrl: hasCache ? `/api/media/${node.cacheLocationId}/asset` : node.downloadUrl || node.streamUrl,
        sizeBytes: node.sizeBytes,
        durationSeconds: node.durationSeconds,
        availability: hasCache ? "available" : node.streamUrl || node.downloadUrl ? "remote" : "metadata",
        cacheLocationId: node.cacheLocationId,
        cachePath: node.cachePath,
        cacheAvailable: node.cacheAvailable,
        cacheStreamUrl: node.cacheAvailable && node.cacheLocationId !== null ? `/api/media/${node.cacheLocationId}/stream` : "",
        localLocationId: node.localLocationId,
        localPath: node.localPath,
        localAvailable: node.localAvailable,
        progress: null,
        locations: [
          ...(node.localAvailable && node.localLocationId ? [{
            locationId: node.localLocationId, locationType: "local", streamUrl: `/api/media/${node.localLocationId}/stream`, sourceId: 0, sourceName: "Local", availability: "available",
          }] : []),
          ...(node.cacheAvailable && node.cacheLocationId ? [{
            locationId: node.cacheLocationId, locationType: "cache", streamUrl: `/api/media/${node.cacheLocationId}/stream`, sourceId: 0, sourceName: "Cache", availability: "available",
          }] : []),
          ...(node.streamUrl ? [{
            locationId: nextID, locationType: "remote_stream", streamUrl: node.streamUrl, sourceId: 0, sourceName: "Remote", availability: "remote",
          }] : []),
        ],
      });
      nextID -= 1;
    });
  };
  walk(tracks, root);
  return normalizeDisplayTree(root);
}

export function playableFiles(files: TreeTrack[]) {
  return files.filter((file) => file.kind === "audio" && ["available", "remote"].includes(file.availability) && file.streamUrl);
}

export function flattenTracks(root: TreeNode) {
  const tracks: TreeTrack[] = [];
  const visit = (node: TreeNode) => {
    tracks.push(...playableFiles(node.files));
    for (const child of node.children.values()) visit(child);
  };
  visit(root);
  return tracks;
}

export function latestResumeTrack(tracks: TreeTrack[]) {
  return tracks
    .filter((track) => track.progress && !track.progress.completed && track.progress.positionSeconds > 0)
    .sort((left, right) => {
      const leftTime = left.progress?.lastPlayedAt ? Date.parse(left.progress.lastPlayedAt) : 0;
      const rightTime = right.progress?.lastPlayedAt ? Date.parse(right.progress.lastPlayedAt) : 0;
      return rightTime - leftTime;
    })[0] ?? null;
}

export function countTreeFiles(root: TreeNode) {
  let count = root.files.length;
  for (const child of root.children.values()) count += countTreeFiles(child);
  return count;
}

export function remoteSelectablePaths(root: TreeNode) {
  const paths: string[] = [];
  const visit = (node: TreeNode) => {
    paths.push(...node.files.filter((file) => file.downloadUrl || file.streamUrl).map((file) => file.sourcePath));
    for (const child of node.children.values()) visit(child);
  };
  visit(root);
  return paths;
}

export function treeStats(node: TreeNode): TreeStats {
  const stats: TreeStats = { files: 0, audio: 0, sizeBytes: 0, knownSizeFiles: 0, durationSeconds: 0, knownDurationAudio: 0 };
  const visit = (cursor: TreeNode) => {
    for (const file of cursor.files) {
      stats.files += 1;
      if (file.kind === "audio") stats.audio += 1;
      if (file.sizeBytes !== null && file.sizeBytes >= 0) {
        stats.sizeBytes += file.sizeBytes;
        stats.knownSizeFiles += 1;
      }
      if (file.kind === "audio" && file.durationSeconds !== null && file.durationSeconds > 0) {
        stats.durationSeconds += file.durationSeconds;
        stats.knownDurationAudio += 1;
      }
    }
    for (const child of cursor.children.values()) visit(child);
  };
  visit(node);
  return stats;
}

export function formatTreeStats(stats: TreeStats) {
  const parts = [
    stats.audio > 0 ? `${stats.audio} audio` : stats.files > 0 ? `${stats.files} files` : "",
    stats.knownSizeFiles > 0 ? formatBytes(stats.sizeBytes) : "",
    stats.knownDurationAudio > 0 ? formatDuration(stats.durationSeconds) : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "";
}

export function formatBytes(value: number | null) {
  if (value === null) return "unknown";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function formatDuration(value: number | null) {
  if (!value || value <= 0) return "Unknown";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  return `${minutes}m`;
}

export function toPlayerTrack(track: TreeTrack, work: WorkDetail): PlayerTrack {
  const lyricsChoices = findLyricsMatches(track.sourcePath || track.title, work.mediaItems);
  const audioItem = work.mediaItems.find((item) => item.id === track.mediaItemId);
  const automaticLyrics = lyricsChoices[0] ?? null;
  const lyrics = lyricsChoices.find((choice) => choice.mediaItemId === audioItem?.preferredLyricsMediaItemId) ?? automaticLyrics;
  return {
    ...track,
    workId: work.id,
    workCode: work.primaryCode,
    workTitle: work.title,
    coverUrl: work.coverUrl,
    circle: work.circle,
    progress: track.progress,
    progressRecordable: true,
    lyricsLocationId: lyrics?.locationId ?? null,
    lyricsTitle: lyrics?.title ?? "",
    lyricsChoices,
    autoLyricsLocationId: automaticLyrics?.locationId ?? null,
    preferredLyricsMediaItemId: audioItem?.preferredLyricsMediaItemId ?? null,
  };
}

export function toRemotePreviewPlayerTrack(track: TreeTrack, detail: RemoteWorkDetail): PlayerTrack {
  return {
    ...track,
    workId: detail.workId ?? 0,
    workCode: detail.primaryCode || detail.remoteId,
    workTitle: detail.title,
    coverUrl: detail.coverUrl,
    circle: detail.circle,
    progress: null,
    progressRecordable: false,
    lyricsLocationId: null,
    lyricsTitle: "",
    lyricsChoices: [],
    autoLyricsLocationId: null,
    preferredLyricsMediaItemId: null,
    remoteSourceId: detail.sourceId,
    remoteWorkCode: detail.primaryCode || detail.remoteId,
    remotePath: track.sourcePath,
  };
}

function displayPathParts(path: string, locationType: string, workCode: string) {
  const parts = path.split("/").filter(Boolean);
  if (locationType !== "local" || !workCode) return parts;
  const code = workCode.toUpperCase();
  const workRootIndex = parts.findIndex((part) => {
    const normalized = part.toUpperCase();
    return normalized.includes(code) || /\b(RJ|BJ|VJ)[0-9]{5,8}\b/i.test(part);
  });
  if (workRootIndex < 0 || workRootIndex >= parts.length - 1) return parts;
  return parts.slice(workRootIndex + 1);
}

function normalizeDisplayTree(root: TreeNode): TreeNode {
  let displayRoot = cloneTree(root, "");
  while (displayRoot.files.length === 0 && displayRoot.children.size === 1) {
    const onlyChild = Array.from(displayRoot.children.values())[0];
    if (onlyChild.files.length > 0 || onlyChild.children.size !== 1) break;
    displayRoot = cloneTree(onlyChild, "");
  }
  return collapseSingleChildFolders(displayRoot, true);
}

function cloneTree(node: TreeNode, path: string): TreeNode {
  const clone: TreeNode = { name: node.name, path, children: new Map(), files: [...node.files] };
  for (const child of node.children.values()) {
    const childPath = path ? `${path}/${child.name}` : child.name;
    clone.children.set(child.name, cloneTree(child, childPath));
  }
  return clone;
}

function collapseSingleChildFolders(node: TreeNode, isRoot = false): TreeNode {
  const collapsed: TreeNode = { ...node, children: new Map(), files: [...node.files] };
  for (const child of node.children.values()) {
    let next = collapseSingleChildFolders(child);
    while (!isRoot && next.files.length === 0 && next.children.size === 1) {
      const grandChild = Array.from(next.children.values())[0];
      next = collapseSingleChildFolders({ ...grandChild, name: `${next.name}/${grandChild.name}`, path: next.path });
    }
    collapsed.children.set(next.name, next);
  }
  return collapsed;
}

function baseNameWithoutExtension(name: string) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(0, index) : name;
}

function versionedMediaAssetURL(locationId: number, fingerprint: string, sizeBytes: number | null) {
  const revision = `${fingerprint}:${sizeBytes ?? "unknown"}`;
  return `/api/media/${locationId}/asset?v=${encodeURIComponent(revision)}`;
}
