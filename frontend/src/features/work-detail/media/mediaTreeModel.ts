import type { MediaItem, RemoteTrack, RemoteWorkDetail, WorkDetail, WorkProgressSummary } from "../../../lib/api";
import type { PlayerTrack, PlayerTrackLocation } from "../../../player/PlayerProvider";
import {
  findLyricsMatches,
  findRemoteLyricsMatches,
  isLyricsPath,
  type LyricsChoice,
} from "../../../player/lyricsMatching";
import { playbackKeyForLocation, remotePlaybackKey } from "../../../player/playbackIdentity";
import { remoteMediaURL } from "../../../player/mediaPlayback";
import { applyTrackLocation, preferredTrackLocation } from "../../../player/trackLocations";

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
  textPreviewUrl?: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  hasAudio: boolean | null;
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
  playbackKey?: string;
  lyricsChoices?: LyricsChoice[];
  autoLyricsLocationId?: number | null;
  preferredLyricsMediaItemId?: number | null;
  lyricsPreferencePersistable?: boolean;
};

export type RemoteTreeIdentity = {
  sourceId: number;
  workCode: string;
};

export type TreeStats = {
  files: number;
  audio: number;
  video: number;
  playable: number;
  sizeBytes: number;
  knownSizeFiles: number;
  durationSeconds: number;
  knownDurationMedia: number;
};

export function emptyTree(): TreeNode {
  return { name: "", path: "", children: new Map(), files: [] };
}

export function buildTree(items: MediaItem[], fileSourceId: number | null, workCode: string): TreeNode {
  const root = emptyTree();
  const lyricsMatchPathsByLocationID = new Map<number, string>();
  for (const item of items) {
    const sourceLocations =
      fileSourceId === null
        ? item.locations
        : item.locations.filter((location) => location.fileSourceId === fileSourceId);
    const location =
      sourceLocations.find((candidate) => candidate.availability === "available" && candidate.streamUrl) ??
      sourceLocations.find((candidate) => candidate.availability === "available") ??
      sourceLocations.find(
        (candidate) => candidate.availability === "remote" && (candidate.streamUrl || candidate.downloadUrl),
      );
    if (!location) continue;
    const cacheLocation = sourceLocations.find(
      (candidate) => candidate.locationType === "cache" && candidate.availability === "available",
    );
    const localLocation = sourceLocations.find(
      (candidate) => candidate.locationType === "local" && candidate.availability === "available",
    );
    const parts = displayPathParts(location.path, location.locationType, workCode);
    const fileName = parts.pop() ?? item.title;
    const locationStreamUrl = playbackStreamURLForLocation(
      location.id,
      location.locationType,
      item.kind,
      location.streamUrl,
    );
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
      streamUrl: locationStreamUrl,
      downloadUrl: location.downloadUrl,
      assetUrl:
        location.locationType === "local"
          ? versionedMediaAssetURL(location.id, item.fingerprint, location.sizeBytes)
          : location.downloadUrl,
      textPreviewUrl: "",
      sizeBytes: location.sizeBytes,
      durationSeconds: location.durationSeconds ?? item.durationSeconds,
      hasAudio: item.hasAudio ?? null,
      availability: location.availability,
      cacheLocationId: cacheLocation?.id ?? null,
      cachePath: cacheLocation?.path ?? "",
      cacheAvailable: Boolean(cacheLocation),
      cacheStreamUrl: cacheLocation ? `/api/media/${cacheLocation.id}/stream` : "",
      localLocationId: localLocation?.id ?? null,
      localPath: localLocation?.path ?? "",
      localAvailable: Boolean(localLocation),
      progress: item.progress,
      playbackKey: playbackKeyForLocation(location.id),
      locations: item.locations
        .filter((candidate) => candidate.streamUrl && ["available", "remote"].includes(candidate.availability))
        .map((candidate) => ({
          locationId: candidate.id,
          locationType: candidate.locationType,
          streamUrl: playbackStreamURLForLocation(candidate.id, candidate.locationType, item.kind, candidate.streamUrl),
          sourceId: candidate.fileSourceId,
          sourceName: candidate.fileSourceName,
          availability: candidate.availability,
        })),
    });
    lyricsMatchPathsByLocationID.set(location.id, location.path);
  }
  const displayRoot = normalizeDisplayTree(root);
  attachLocalLyricsChoices(displayRoot, items, lyricsMatchPathsByLocationID);
  return displayRoot;
}

function playbackStreamURLForLocation(locationId: number, locationType: string, kind: string, streamUrl: string) {
  if (locationType === "remote_stream" && (kind === "audio" || kind === "video") && locationId > 0) {
    return `/api/media/${locationId}/stream`;
  }
  return streamUrl;
}

export function buildRemoteTree(tracks: RemoteTrack[], identity?: RemoteTreeIdentity): TreeNode {
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
      const sourcePath = cursor.path ? `${cursor.path}/${title}` : title;
      const hasCache = node.cacheAvailable && node.cacheLocationId !== null;
      const remoteKind = remotePlayableKind(node.type, title);
      const hasRemoteMedia = Boolean(node.streamUrl || node.downloadUrl);
      const remoteStreamUrl =
        identity && !hasCache && hasRemoteMedia && (remoteKind === "audio" || remoteKind === "video")
          ? remoteMediaURL(identity.sourceId, identity.workCode, sourcePath)
          : node.streamUrl;
      cursor.files.push({
        mediaItemId: nextID,
        locationId: hasCache ? node.cacheLocationId! : nextID,
        title,
        baseName: baseNameWithoutExtension(title),
        sourcePath,
        kind: remoteKind,
        folderPath: cursor.path,
        locationType: hasCache ? "cache" : "remote_stream",
        streamUrl: hasCache ? `/api/media/${node.cacheLocationId}/stream` : remoteStreamUrl,
        downloadUrl: node.downloadUrl,
        assetUrl: hasCache ? `/api/media/${node.cacheLocationId}/asset` : node.downloadUrl || node.streamUrl,
        textPreviewUrl:
          identity && (node.type === "text" || mediaKindFromRemotePath(title) === "text")
            ? `/api/remote-sources/${identity.sourceId}/works/${encodeURIComponent(identity.workCode)}/text?path=${encodeURIComponent(sourcePath)}`
            : "",
        sizeBytes: node.sizeBytes,
        durationSeconds: node.durationSeconds,
        hasAudio: null,
        availability: hasCache ? "available" : node.streamUrl || node.downloadUrl ? "remote" : "metadata",
        cacheLocationId: node.cacheLocationId,
        cachePath: node.cachePath,
        cacheAvailable: node.cacheAvailable,
        cacheStreamUrl:
          node.cacheAvailable && node.cacheLocationId !== null ? `/api/media/${node.cacheLocationId}/stream` : "",
        localLocationId: node.localLocationId,
        localPath: node.localPath,
        localAvailable: node.localAvailable,
        progress: null,
        playbackKey: identity
          ? remotePlaybackKey(identity.sourceId, identity.workCode, sourcePath)
          : `remote-path:${sourcePath}`,
        locations: [
          ...(node.localAvailable && node.localLocationId
            ? [
                {
                  locationId: node.localLocationId,
                  locationType: "local",
                  streamUrl: `/api/media/${node.localLocationId}/stream`,
                  sourceId: 0,
                  sourceName: "Local",
                  availability: "available",
                },
              ]
            : []),
          ...(node.cacheAvailable && node.cacheLocationId
            ? [
                {
                  locationId: node.cacheLocationId,
                  locationType: "cache",
                  streamUrl: `/api/media/${node.cacheLocationId}/stream`,
                  sourceId: 0,
                  sourceName: "Cache",
                  availability: "available",
                },
              ]
            : []),
          ...(remoteStreamUrl
            ? [
                {
                  locationId: nextID,
                  locationType: "remote_stream",
                  streamUrl: remoteStreamUrl,
                  sourceId: 0,
                  sourceName: "Remote",
                  availability: "remote",
                },
              ]
            : []),
        ],
      });
      nextID -= 1;
    });
  };
  walk(tracks, root);
  const displayRoot = normalizeDisplayTree(root);
  attachRemoteLyricsChoices(displayRoot);
  return displayRoot;
}

export function playableFiles(files: TreeTrack[]) {
  return files.filter(
    (file) =>
      (file.kind === "audio" || (file.kind === "video" && file.hasAudio !== false)) &&
      ["available", "remote"].includes(file.availability) &&
      file.streamUrl,
  );
}

export function sortedTreeChildren(node: TreeNode) {
  return Array.from(node.children.values()).sort((left, right) => naturalTreeNameCompare(left.name, right.name));
}

export function sortedTreeFiles(node: TreeNode) {
  return [...node.files].sort((left, right) => naturalTreeNameCompare(left.title, right.title));
}

export function folderPlaybackTracks(node: TreeNode) {
  return playableFiles(sortedTreeFiles(node));
}

export function flattenTracks(root: TreeNode) {
  const tracks: TreeTrack[] = [];
  const visit = (node: TreeNode) => {
    for (const child of sortedTreeChildren(node)) visit(child);
    tracks.push(...folderPlaybackTracks(node));
  };
  visit(root);
  return tracks;
}

function naturalTreeNameCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export function flattenTreeFiles(root: TreeNode) {
  const files: TreeTrack[] = [];
  const visit = (node: TreeNode) => {
    files.push(...node.files);
    for (const child of node.children.values()) visit(child);
  };
  visit(root);
  return files;
}

export type DirectoryLyricsAttachments = {
  hiddenLocationIds: Set<number>;
  sharedLocationIds: Set<number>;
};

export function directoryLyricsAttachments(root: TreeNode): DirectoryLyricsAttachments {
  const files = flattenTreeFiles(root);
  const filesByLocationID = new Map(files.map((file) => [file.locationId, file]));
  const links = new Map<number, { audioLocationIds: Set<number>; shared: boolean }>();
  for (const audio of files) {
    if (audio.kind !== "audio") continue;
    for (const choice of audio.lyricsChoices ?? []) {
      const attachment = filesByLocationID.get(choice.locationId);
      if (!attachment || attachment.folderPath !== audio.folderPath) continue;
      if (!isLyricsPath(attachment.sourcePath || attachment.title)) continue;
      const link = links.get(choice.locationId) ?? { audioLocationIds: new Set<number>(), shared: false };
      link.audioLocationIds.add(audio.locationId);
      link.shared ||= choice.reason === "shared_folder";
      links.set(choice.locationId, link);
    }
  }
  const hiddenLocationIds = new Set<number>();
  const sharedLocationIds = new Set<number>();
  for (const [locationID, link] of links) {
    hiddenLocationIds.add(locationID);
    if (link.shared || link.audioLocationIds.size > 1) sharedLocationIds.add(locationID);
  }
  return { hiddenLocationIds, sharedLocationIds };
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
  const stats: TreeStats = {
    files: 0,
    audio: 0,
    video: 0,
    playable: 0,
    sizeBytes: 0,
    knownSizeFiles: 0,
    durationSeconds: 0,
    knownDurationMedia: 0,
  };
  const visit = (cursor: TreeNode) => {
    for (const file of cursor.files) {
      stats.files += 1;
      if (file.kind === "audio") stats.audio += 1;
      if (file.kind === "video") stats.video += 1;
      if (file.kind === "audio" || (file.kind === "video" && file.hasAudio !== false)) stats.playable += 1;
      if (file.sizeBytes !== null && file.sizeBytes >= 0) {
        stats.sizeBytes += file.sizeBytes;
        stats.knownSizeFiles += 1;
      }
      if (
        (file.kind === "audio" || (file.kind === "video" && file.hasAudio !== false)) &&
        file.durationSeconds !== null &&
        file.durationSeconds > 0
      ) {
        stats.durationSeconds += file.durationSeconds;
        stats.knownDurationMedia += 1;
      }
    }
    for (const child of cursor.children.values()) visit(child);
  };
  visit(node);
  return stats;
}

export function formatTreeStats(stats: TreeStats) {
  const parts = [
    stats.audio > 0 ? `${stats.audio} audio` : "",
    stats.video > 0 ? `${stats.video} video` : "",
    stats.audio === 0 && stats.video === 0 && stats.files > 0 ? `${stats.files} files` : "",
    stats.knownSizeFiles > 0 ? formatBytes(stats.sizeBytes) : "",
    stats.knownDurationMedia > 0 ? formatDuration(stats.durationSeconds) : "",
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
  return minutes > 0 ? `${minutes}m` : "<1m";
}

export function formatTrackDuration(value: number | null) {
  if (!value || value <= 0) return "";
  const totalSeconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function toPlayerTrack(track: TreeTrack, work: WorkDetail): PlayerTrack {
  const lyricsChoices = track.lyricsChoices ?? findLyricsMatches(track.sourcePath || track.title, work.mediaItems);
  const audioItem = work.mediaItems.find((item) => item.id === track.mediaItemId);
  const automaticLyrics = lyricsChoices[0] ?? null;
  const preferredLyricsMediaItemId =
    track.preferredLyricsMediaItemId !== undefined
      ? track.preferredLyricsMediaItemId
      : (audioItem?.preferredLyricsMediaItemId ?? null);
  const lyrics = lyricsChoices.find((choice) => choice.mediaItemId === preferredLyricsMediaItemId) ?? automaticLyrics;
  return {
    ...track,
    kind: track.kind === "video" ? "video" : "audio",
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
    preferredLyricsMediaItemId,
    playbackKey: track.playbackKey ?? playbackKeyForLocation(track.locationId),
  };
}

export function toPreferredPlayerTrack(track: TreeTrack, work: WorkDetail): PlayerTrack {
  const playerTrack = toPlayerTrack(track, work);
  const preferredLocation = preferredTrackLocation(playerTrack);
  return preferredLocation ? applyTrackLocation(playerTrack, preferredLocation) : playerTrack;
}

export type WorkResumeQueue = {
  tracks: PlayerTrack[];
  locationId: number;
  positionSeconds: number;
};

export function buildWorkResumeQueue(
  tracks: TreeTrack[],
  work: WorkDetail,
  cursor: WorkProgressSummary | null,
): WorkResumeQueue | null {
  if (
    !cursor?.mediaItemId ||
    cursor.completed ||
    !Number.isFinite(cursor.positionSeconds) ||
    cursor.positionSeconds <= 0 ||
    (cursor.mediaWorkId !== null && cursor.mediaWorkId !== work.id)
  ) {
    return null;
  }
  const queue = tracks.map((track) => toPreferredPlayerTrack(track, work));
  const startIndex = queue.findIndex((track) => track.mediaItemId === cursor.mediaItemId);
  if (startIndex < 0) return null;

  const startTrack = queue[startIndex];
  const usableLocations =
    startTrack.locations?.filter(
      (location) => Boolean(location.streamUrl) && ["available", "remote"].includes(location.availability),
    ) ?? [];
  const cursorLocation =
    usableLocations.find((location) => location.locationId === cursor.locationId) ??
    usableLocations.find(
      (location) => location.sourceId === cursor.fileSourceId && location.locationType === cursor.locationType,
    ) ??
    usableLocations.find((location) => location.sourceId === cursor.fileSourceId) ??
    preferredTrackLocation(startTrack);
  if (!cursorLocation) return null;

  queue[startIndex] = applyTrackLocation(startTrack, cursorLocation);
  return {
    tracks: queue,
    locationId: cursorLocation.locationId,
    positionSeconds: cursor.positionSeconds,
  };
}

export function toRemotePreviewPlayerTrack(
  track: TreeTrack,
  detail: RemoteWorkDetail,
  files: TreeTrack[] = [],
): PlayerTrack {
  const remoteWorkCode = detail.remoteCode || detail.primaryCode || detail.remoteId;
  const remoteLyrics =
    track.lyricsChoices ?? findRemoteLyricsMatches(track.sourcePath || track.title, files.map(remoteLyricsCandidate));
  const automaticLyrics = remoteLyrics[0] ?? null;
  return {
    ...track,
    kind: track.kind === "video" ? "video" : "audio",
    workId: detail.workId ?? 0,
    workCode: remoteWorkCode,
    workTitle: detail.title,
    coverUrl: detail.coverUrl,
    circle: detail.circle,
    progress: null,
    progressRecordable: false,
    lyricsLocationId: automaticLyrics?.locationId ?? null,
    lyricsTitle: automaticLyrics?.title ?? "",
    lyricsChoices: remoteLyrics,
    autoLyricsLocationId: automaticLyrics?.locationId ?? null,
    preferredLyricsMediaItemId: null,
    remoteSourceId: detail.sourceId,
    remoteWorkCode,
    remotePath: track.sourcePath,
    playbackKey: track.playbackKey ?? remotePlaybackKey(detail.sourceId, remoteWorkCode, track.sourcePath),
  };
}

function attachLocalLyricsChoices(
  root: TreeNode,
  items: MediaItem[],
  lyricsMatchPathsByLocationID: ReadonlyMap<number, string>,
) {
  const files = flattenTreeFiles(root);
  const itemsByID = new Map(items.map((item) => [item.id, item]));
  const displayFilesByLocationID = new Map(files.map((file) => [file.locationId, file]));
  for (const file of files) {
    if (file.kind !== "audio" && file.kind !== "video") continue;
    const choices = findLyricsMatches(
      lyricsMatchPathsByLocationID.get(file.locationId) || file.sourcePath || file.title,
      items,
    ).map((choice) => ({
      ...choice,
      displayPath: displayFilesByLocationID.get(choice.locationId)?.sourcePath,
    }));
    const item = itemsByID.get(file.mediaItemId);
    file.lyricsChoices = choices;
    file.autoLyricsLocationId = choices[0]?.locationId ?? null;
    file.preferredLyricsMediaItemId = item?.preferredLyricsMediaItemId ?? null;
    file.lyricsPreferencePersistable = true;
  }
}

function attachRemoteLyricsChoices(root: TreeNode) {
  const files = flattenTreeFiles(root);
  const displayFilesByLocationID = new Map(files.map((file) => [file.locationId, file]));
  const candidates = files.map(remoteLyricsCandidate);
  for (const file of files) {
    if (file.kind !== "audio" && file.kind !== "video") continue;
    const choices = findRemoteLyricsMatches(file.sourcePath || file.title, candidates).map((choice) => ({
      ...choice,
      displayPath: displayFilesByLocationID.get(choice.locationId)?.sourcePath,
    }));
    file.lyricsChoices = choices;
    file.autoLyricsLocationId = choices[0]?.locationId ?? null;
    file.preferredLyricsMediaItemId = null;
    file.lyricsPreferencePersistable = false;
  }
}

function remoteLyricsCandidate(file: TreeTrack) {
  return {
    mediaItemId: file.mediaItemId,
    locationId: file.locationId,
    title: file.title,
    path: file.sourcePath,
    url: file.textPreviewUrl || file.streamUrl || file.downloadUrl,
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

function mediaKindFromRemotePath(path: string) {
  const index = path.lastIndexOf(".");
  const extension = index >= 0 ? path.slice(index).toLowerCase() : "";
  return [
    ".txt",
    ".md",
    ".json",
    ".lrc",
    ".cue",
    ".srt",
    ".vtt",
    ".ass",
    ".csv",
    ".log",
    ".ini",
    ".yaml",
    ".yml",
  ].includes(extension)
    ? "text"
    : "file";
}

function remotePlayableKind(kind: string, path: string) {
  const normalizedKind = kind.trim().toLowerCase();
  if (["audio", "video", "image", "text", "folder"].includes(normalizedKind)) return normalizedKind;
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if ([".mp3", ".m4a", ".aac", ".flac", ".wav", ".wma", ".ogg", ".oga", ".opus"].includes(extension)) {
    return "audio";
  }
  if (
    [
      ".mp4",
      ".m4v",
      ".mov",
      ".webm",
      ".mkv",
      ".avi",
      ".wmv",
      ".flv",
      ".f4v",
      ".mpeg",
      ".mpg",
      ".mpe",
      ".m2v",
      ".m2ts",
      ".mts",
      ".ts",
      ".3gp",
      ".3g2",
      ".ogv",
      ".asf",
      ".rm",
      ".rmvb",
      ".vob",
      ".divx",
      ".xvid",
      ".mxf",
      ".ogm",
      ".svi",
      ".nsv",
      ".wtv",
      ".amv",
      ".mjpeg",
      ".mjpg",
      ".dv",
      ".y4m",
      ".ismv",
      ".ism",
    ].includes(extension)
  ) {
    return "video";
  }
  return normalizedKind || "file";
}

function versionedMediaAssetURL(locationId: number, fingerprint: string, sizeBytes: number | null) {
  const revision = `${fingerprint}:${sizeBytes ?? "unknown"}`;
  return `/api/media/${locationId}/asset?v=${encodeURIComponent(revision)}`;
}
