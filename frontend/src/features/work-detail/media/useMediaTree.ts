import { useEffect, useState } from "react";

import type { MediaItem, RemoteTrack, RemoteWorkDetail } from "@/lib/api";

export function useMediaTree<TTree>({
  mediaLoading,
  localItems,
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
  fileSourceId: number | null;
  selectionKey: string;
  remoteSelected: boolean;
  remoteDetail: RemoteWorkDetail | null;
  trackedUnavailable: boolean;
  emptyTree: () => TTree;
  buildLocalTree: (items: MediaItem[], fileSourceId: number | null) => TTree;
  buildRemoteTree: (tracks: RemoteTrack[], identity?: { sourceId: number; workCode: string }) => TTree;
}) {
  const [tree, setTree] = useState<TTree>(() => emptyTree());
  const [isDirectoryLoading, setIsDirectoryLoading] = useState(false);

  useEffect(() => {
    if (mediaLoading && localItems.length === 0 && !remoteDetail) {
      setIsDirectoryLoading(true);
      return;
    }
    setIsDirectoryLoading(true);
    const timer = window.setTimeout(() => {
      const nextTree =
        remoteSelected && !remoteDetail
          ? emptyTree()
          : trackedUnavailable
            ? emptyTree()
            : remoteDetail
              ? buildRemoteTree(remoteDetail.tracks, {
                  sourceId: remoteDetail.sourceId,
                  workCode: remoteDetail.remoteCode || remoteDetail.primaryCode || remoteDetail.remoteId,
                })
              : buildLocalTree(localItems, fileSourceId);
      setTree(nextTree);
      setIsDirectoryLoading(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    buildLocalTree,
    buildRemoteTree,
    emptyTree,
    fileSourceId,
    localItems,
    mediaLoading,
    remoteDetail,
    remoteSelected,
    selectionKey,
    trackedUnavailable,
  ]);

  return { tree, isDirectoryLoading };
}
