import type { LyricsManagerAudio } from "@/features/work-detail/lyrics/lyricsManagerModel";
import { suggestRemoteLyricsMapping } from "@/features/work-detail/lyrics/remoteLyricsModel";
import type { WorkFolderEditAddition, WorkFolderEditAssignment, WorkFolderEditItem } from "@/lib/api";

import { folderEditItemKey } from "./folderEditModel";

/**
 * Suggests the track each added lyrics file belongs to, per language: a
 * matching file name first, then track order. Audio already in the folder is
 * named by its media item and keeps the lyrics it has in a language; audio the
 * same change adds is named by its path below the folder. A lyrics file the
 * plan leaves out is not assigned.
 */
export function folderEditAssignments({
  audio,
  addedAudio,
  additions,
  items,
}: {
  audio: readonly LyricsManagerAudio[];
  /** Paths below the folder of the audio files the change adds. */
  addedAudio: readonly string[];
  additions: readonly WorkFolderEditAddition[];
  items: readonly WorkFolderEditItem[];
}): WorkFolderEditAssignment[] {
  const left = new Set(
    items.filter((item) => item.action === "conflict" || item.action === "exclude").map((item) => item.itemKey),
  );
  const added: LyricsManagerAudio[] = addedAudio.map((path, index) => ({
    mediaItemId: -(index + 1),
    title: path.split("/").pop() ?? path,
    path,
    folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    durationSeconds: null,
    assignedLyrics: {},
    autoLyricsMediaItemId: null,
  }));
  const tracks = [...audio, ...added];
  // Files of one place in one language are matched together, so track order means something.
  const groups = new Map<string, { language: string; additions: WorkFolderEditAddition[] }>();
  for (const addition of additions) {
    if (addition.language === undefined) continue;
    const itemKey = folderEditItemKey(addition);
    if (left.has(itemKey)) continue;
    const key = `${addition.language}\n${itemKey.slice(0, itemKey.length - addition.path.length)}`;
    const group = groups.get(key) ?? { language: addition.language, additions: [] };
    group.additions.push(addition);
    groups.set(key, group);
  }
  const taken = new Set<string>();
  const assignments: WorkFolderEditAssignment[] = [];
  for (const { language, additions: group } of groups.values()) {
    const free = tracks.filter(
      (track) => track.assignedLyrics[language] === undefined && !taken.has(`${track.mediaItemId}:${language}`),
    );
    const byPath = new Map(group.map((addition) => [addition.path, addition]));
    const mapping = suggestRemoteLyricsMapping(
      free,
      group.map((addition) => ({
        path: addition.path,
        title: addition.path.split("/").pop() ?? addition.path,
        folder: addition.path.includes("/") ? addition.path.slice(0, addition.path.lastIndexOf("/")) : "",
        sizeBytes: null,
      })),
    );
    for (const [audioId, path] of mapping) {
      const addition = path ? byPath.get(path) : undefined;
      if (!addition) continue;
      taken.add(`${audioId}:${language}`);
      const itemKey = folderEditItemKey(addition);
      assignments.push(
        audioId > 0 ? { audioMediaItemId: audioId, itemKey } : { audioPath: added[-audioId - 1].path, itemKey },
      );
    }
  }
  return assignments;
}
