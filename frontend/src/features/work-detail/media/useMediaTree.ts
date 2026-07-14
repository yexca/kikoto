import { useEffect, useState } from "react";

import type { MediaItem, RemoteTrack, RemoteWorkDetail } from "@/lib/api";

export function useMediaTree<TTree>({
  mediaLoading,
  localItems,
  localCode,
  fileSourceId,
  selectionKey,
  remoteSelected,
  remoteDetail,
  trackedUnavailable,
  emptyTree,
  buildLocalTree,
  buildRemoteTree,
}: {
  mediaLoading: boolean;
  localItems: MediaItem[];
  localCode: string;
  fileSourceId: number | null;
  selectionKey: string;
  remoteSelected: boolean;
  remoteDetail: RemoteWorkDetail | null;
  trackedUnavailable: boolean;
  emptyTree: () => TTree;
  buildLocalTree: (items: MediaItem[], fileSourceId: number | null, workCode: string) => TTree;
  buildRemoteTree: (tracks: RemoteTrack[]) => TTree;
}) {
  const [tree, setTree] = useState<TTree>(() => emptyTree());
  const [isDirectoryLoading, setIsDirectoryLoading] = useState(false);

  useEffect(() => {
    if (mediaLoading && localItems.length === 0 && !remoteDetail) {
      setIsDirectoryLoading(true);
      return;
    }
    let cancelled = false;
    setIsDirectoryLoading(true);
    const timer = window.setTimeout(() => {
      const nextTree = remoteSelected && !remoteDetail
        ? emptyTree()
        : trackedUnavailable
          ? emptyTree()
          : remoteDetail
            ? buildRemoteTree(remoteDetail.tracks)
            : buildLocalTree(localItems, fileSourceId, localCode);
      if (!cancelled) {
        setTree(nextTree);
        setIsDirectoryLoading(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    buildLocalTree,
    buildRemoteTree,
    emptyTree,
    fileSourceId,
    localCode,
    localItems,
    mediaLoading,
    remoteDetail,
    remoteSelected,
    selectionKey,
    trackedUnavailable,
  ]);

  return { tree, isDirectoryLoading };
}
