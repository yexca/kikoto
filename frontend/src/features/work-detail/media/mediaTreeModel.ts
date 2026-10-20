import type { MediaItem, RemoteTrack, RemoteWorkDetail, WorkDetail, WorkProgressSummary } from "../../../lib/api";
import { mediaItemLyricsAssignments } from "../../../lib/lyricsLanguage";
import type { PlayerTrack, PlayerTrackLocation } from "../../../player/playerTypes";
import {
  audioExtensions,
  findLocalLyricsChoices,
  findRemoteLyricsMatches,
  isLyricsPath,
  type LyricsChoice,
} from "../../../player/lyricsMatching";
import { playbackKeyForLocation, remotePlaybackKey } from "../../../player/playbackIdentity";
import { remoteMediaURL } from "../../../player/mediaPlayback";
import { applyTrackLocation, preferredTrackLocation } from "../../../player/trackLocations";

export type TreeNode = {
  name: string;
  /** The name the viewer's metadata languages give the folder, when it differs from its real name. */
  displayName?: string;
  path: string;
  children: Map<string, TreeNode>;
  files: TreeTrack[];
};

export type TreeTrack = {
  mediaItemId: number;
  locationId: number;
  title: string;
  /** The name the viewer's metadata languages give the file, when it differs from its real name. */
  displayTitle?: string;
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
  const folderLabels = localWorkFolderLabels(items, fileSourceId, workCode);
  for (const item of items) {
    const sourceLocations =
      fileSourceId === null
        ? item.locations
        : item.locations.filter((location) => location.fileSourceId === fileSourceId);
    const location =
      sourceLocations.find((candidate) => candidate.availability === "available" && candidate.streamUrl) ??
      sourceLocations.find(
        (candidate) =>
          candidate.availability === "available" && candidate.locationType === "remote_stream" && candidate.downloadUrl,
      ) ??
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
    const parts = displayPathParts(location.path, location.locationType, workCode, folderLabels);
    const names = displayPathNames(location, parts.length);
    const fileName = parts.pop() ?? item.title;
    const displayTitle = names.pop();
    const locationStreamUrl = playbackStreamURLForLocation(
      location.id,
      location.locationType,
      item.kind,
      locationPlaybackURL(location),
    );
    let cursor = root;
    parts.forEach((part, index) => {
      if (!cursor.children.has(part)) {
        const childPath = cursor.path ? `${cursor.path}/${part}` : part;
        cursor.children.set(part, { name: part, path: childPath, children: new Map(), files: [] });
      }
      cursor = cursor.children.get(part)!;
      // Any file below a folder carries the folder's display name.
      if (names[index] && !cursor.displayName) cursor.displayName = names[index];
    });
    cursor.files.push({
      mediaItemId: item.id,
      locationId: location.id,
      title: fileName,
      ...(displayTitle ? { displayTitle } : {}),
      baseName: baseNameWithoutExtension(fileName),
      sourcePath: parts.length > 0 ? `${parts.join("/")}/${fileName}` : fileName,
      kind: item.kind,
      folderPath: cursor.path,
      locationType: location.locationType,
      streamUrl: locationStreamUrl,
      downloadUrl: location.downloadUrl,
      assetUrl:
        location.locationType === "local" || location.locationType === "cache"
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
        .filter(
          (candidate) => locationPlaybackURL(candidate) && ["available", "remote"].includes(candidate.availability),
        )
        .map((candidate) => ({
          locationId: candidate.id,
          locationType: candidate.locationType,
          streamUrl: playbackStreamURLForLocation(
            candidate.id,
            candidate.locationType,
            item.kind,
            locationPlaybackURL(candidate),
          ),
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

function locationPlaybackURL(location: { locationType: string; streamUrl: string; downloadUrl: string }) {
  return location.streamUrl || (location.locationType === "remote_stream" ? location.downloadUrl : "");
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

// localeCompare with options builds a collator per call; sorting is hot enough to share one.
const naturalTreeNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function naturalTreeNameCompare(left: string, right: string) {
  return naturalTreeNameCollator.compare(left, right);
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

export function treePathForTrack(
  root: TreeNode,
  match: { playbackKey?: string | null; locationId?: number | null },
): string[] | null {
  const playbackKey = match.playbackKey?.trim() ?? "";
  if (playbackKey) {
    const path = findTreeTrackPath(root, (file) => file.playbackKey === playbackKey);
    if (path) return path;
  }
  if (typeof match.locationId === "number" && Number.isFinite(match.locationId)) {
    return findTreeTrackPath(root, (file) => file.locationId === match.locationId);
  }
  return null;
}

function findTreeTrackPath(root: TreeNode, predicate: (file: TreeTrack) => boolean) {
  const visit = (node: TreeNode, path: string[]): string[] | null => {
    if (node.files.some(predicate)) return path;
    for (const child of node.children.values()) {
      const result = visit(child, [...path, child.name]);
      if (result) return result;
    }
    return null;
  };
  return visit(root, []);
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

export function toPlayerTrack(track: TreeTrack, work: WorkDetail, fallbackCoverUrl = ""): PlayerTrack {
  const audioItem = work.mediaItems.find((item) => item.id === track.mediaItemId);
  const lyricsChoices =
    track.lyricsChoices ??
    findLocalLyricsChoices(track.sourcePath || track.title, work.mediaItems, mediaItemLyricsAssignments(audioItem));
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
    coverUrl: work.coverUrl || fallbackCoverUrl,
    circle: work.circle,
    progress: track.progress,
    progressRecordable: true,
    lyricsLocationId: lyrics?.locationId ?? null,
    lyricsTitle: lyrics?.title ?? "",
    lyricsChoices,
    autoLyricsLocationId: automaticLyrics?.locationId ?? null,
    preferredLyricsMediaItemId,
    lyricsOffsetMs: audioItem?.lyricsOffsetMs ?? 0,
    playbackKey: track.playbackKey ?? playbackKeyForLocation(track.locationId),
  };
}

export function toPreferredPlayerTrack(track: TreeTrack, work: WorkDetail, fallbackCoverUrl = ""): PlayerTrack {
  const playerTrack = toPlayerTrack(track, work, fallbackCoverUrl);
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
  fallbackCoverUrl = "",
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
  const queue = tracks.map((track) => toPreferredPlayerTrack(track, work, fallbackCoverUrl));
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
    const item = itemsByID.get(file.mediaItemId);
    const choices = findLocalLyricsChoices(
      lyricsMatchPathsByLocationID.get(file.locationId) || file.sourcePath || file.title,
      items,
      mediaItemLyricsAssignments(item),
    ).map((choice) => ({
      ...choice,
      displayPath: displayFilesByLocationID.get(choice.locationId)?.sourcePath,
    }));
    file.lyricsChoices = choices;
    file.autoLyricsLocationId = choices[0]?.locationId ?? null;
    file.preferredLyricsMediaItemId = item?.preferredLyricsMediaItemId ?? null;
    // The library stores a lyric choice per audio item only.
    file.lyricsPreferencePersistable = file.kind === "audio";
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

function displayPathParts(
  path: string,
  locationType: string,
  workCode: string,
  folderLabels: ReadonlyMap<string, string> = noFolderLabels,
) {
  const parts = path.split("/").filter(Boolean);
  if (locationType !== "local" || !workCode) return parts;
  const workRootIndex = localWorkRootIndex(parts, workCode);
  if (workRootIndex < 0 || workRootIndex >= parts.length - 1) return parts;
  const inside = parts.slice(workRootIndex + 1);
  const label = folderLabels.get(parts.slice(0, workRootIndex + 1).join("/"));
  return label ? [label, ...inside] : inside;
}

const noFolderLabels: ReadonlyMap<string, string> = new Map();

/**
 * The display names of the last `count` segments of a location's path, one per
 * segment and undefined where the segment keeps its real name. A display path
 * names the same segments as the path it stands for.
 */
function displayPathNames(location: { path: string; displayPath?: string }, count: number) {
  const names: (string | undefined)[] = Array.from({ length: count }, () => undefined);
  if (!location.displayPath) return names;
  const real = location.path.split("/").filter(Boolean);
  const shown = location.displayPath.split("/").filter(Boolean);
  if (real.length !== shown.length || count > real.length) return names;
  const offset = real.length - count;
  for (let index = 0; index < count; index++) {
    if (shown[offset + index] !== real[offset + index]) names[index] = shown[offset + index];
  }
  return names;
}

/** The index of the path segment that is the work's folder, or -1 when no segment names the work. */
function localWorkRootIndex(parts: string[], workCode: string) {
  const code = workCode.toUpperCase();
  return parts.findIndex((part) => {
    const normalized = part.toUpperCase();
    return normalized.includes(code) || /\b(RJ|BJ|VJ)[0-9]{5,8}\b/i.test(part);
  });
}

/**
 * Names each work folder when the work's local files lie in several, so the
 * tree shows one folder per copy instead of mixing their files. A work in a
 * single folder needs no labels. A label is the folder's name, extended by its
 * parent folders while two folders share a name.
 */
function localWorkFolderLabels(items: MediaItem[], fileSourceId: number | null, workCode: string) {
  const roots = new Set<string>();
  if (!workCode) return noFolderLabels;
  for (const item of items) {
    for (const location of item.locations) {
      if (location.locationType !== "local" || location.availability !== "available") continue;
      if (fileSourceId !== null && location.fileSourceId !== fileSourceId) continue;
      const parts = location.path.split("/").filter(Boolean);
      const index = localWorkRootIndex(parts, workCode);
      if (index >= 0 && index < parts.length - 1) roots.add(parts.slice(0, index + 1).join("/"));
    }
  }
  if (roots.size < 2) return noFolderLabels;
  const labels = new Map<string, string>();
  for (const root of roots) {
    const segments = root.split("/");
    let depth = 1;
    const label = () => segments.slice(-depth).join(" / ");
    while (
      depth < segments.length &&
      [...roots].some((other) => other !== root && other.split("/").slice(-depth).join(" / ") === label())
    ) {
      depth += 1;
    }
    labels.set(root, label());
  }
  return labels;
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
  if (node.displayName) clone.displayName = node.displayName;
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
      const displayName =
        next.displayName || grandChild.displayName
          ? `${next.displayName ?? next.name}/${grandChild.displayName ?? grandChild.name}`
          : undefined;
      next = collapseSingleChildFolders({
        ...grandChild,
        name: `${next.name}/${grandChild.name}`,
        displayName,
        path: next.path,
      });
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
    ".ssa",
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
  if (audioExtensions.includes(extension)) {
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
