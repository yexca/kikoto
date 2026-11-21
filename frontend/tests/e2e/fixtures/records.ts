import type {
  RecordAsset,
  RecordFolder,
  RecordSectionName,
  RecordSectionPage,
  RecordSiblings,
  RecordTree,
} from "../../../src/lib/api";

const artworkStems = new Set(["folder", "poster", "cover", "backdrop", "fanart", "background"]);

function stem(name: string) {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/** The section of the folder each asset shows in, as the server splits them. */
function inSection(asset: RecordAsset, section: Exclude<RecordSectionName, "folders">) {
  switch (section) {
    case "videos":
      return asset.kind === "video";
    case "photos":
      return asset.kind === "image" && !artworkStems.has(stem(asset.name));
    case "audio":
      return asset.kind === "audio";
    case "files":
      return ["audio", "subtitle", "metadata", "other"].includes(asset.kind);
  }
}

function page<T>(items: readonly T[], after: number, size: number): RecordSectionPage<T> {
  const slice = items.slice(after, after + size);
  const result: RecordSectionPage<T> = { items: slice, total: items.length };
  if (after + size < items.length) result.next = String(after + size);
  return result;
}

/** A section's children, listed in the order given. */
export function recordSection(
  section: RecordSectionName,
  folders: readonly RecordFolder[],
  assets: readonly RecordAsset[],
): (RecordFolder | RecordAsset)[] {
  return section === "folders" ? [...folders] : assets.filter((asset) => inSection(asset, section));
}

/**
 * Answers a mocked `/api/records/tree` request: the first page of every
 * section, or with `section` the page after the cursor; cursors are offsets.
 */
export function recordTreeResponse(
  url: URL,
  folders: readonly RecordFolder[],
  assets: readonly RecordAsset[],
  pageSize = 100,
) {
  const folderId = Number(url.searchParams.get("folderId") ?? 0);
  const section = url.searchParams.get("section") as RecordSectionName | null;
  if (section) {
    const after = Number(url.searchParams.get("after") ?? 0);
    return { folderId, section, ...page(recordSection(section, folders, assets), after, pageSize) };
  }
  const tree: RecordTree = {
    folderId,
    trail: [],
    sections: {
      folders: page([...folders], 0, pageSize),
      videos: page(recordSection("videos", folders, assets) as RecordAsset[], 0, pageSize),
      photos: page(recordSection("photos", folders, assets) as RecordAsset[], 0, pageSize),
      audio: page(recordSection("audio", folders, assets) as RecordAsset[], 0, pageSize),
      files: page(recordSection("files", folders, assets) as RecordAsset[], 0, pageSize),
    },
  };
  return tree;
}

/** Answers a mocked `/api/records/assets/{id}/siblings` request, or null for a file in no viewer section. */
export function recordSiblingsResponse(assets: readonly RecordAsset[], id: number): RecordSiblings | null {
  const asset = assets.find((item) => item.id === id);
  if (!asset) return null;
  const section = (["videos", "photos", "audio"] as const).find((name) => inSection(asset, name));
  if (!section) return null;
  const items = assets.filter((item) => inSection(item, section));
  const index = items.indexOf(asset);
  const siblings: RecordSiblings = { asset, section, index, total: items.length };
  if (index > 0) siblings.previous = items[index - 1];
  if (index < items.length - 1) siblings.next = items[index + 1];
  return siblings;
}
