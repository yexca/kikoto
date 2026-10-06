import { FileAudio, FileText, FileVideo, ImageIcon } from "lucide-react";

import { formatBytes, type TreeStats, type TreeTrack } from "@/features/work-detail/media/mediaTreeModel";
import type { MediaDeleteTarget } from "@/features/work-detail/workflows/useMediaCleanupWorkflow";
import i18n from "@/i18n";

export function formatFolderStats(stats: TreeStats, directPlayableCount: number) {
  const countLabel =
    directPlayableCount > 0
      ? i18n.t(stats.video > 0 ? "libraryDetail.playableCount" : "libraryDetail.audioCount", {
          count: directPlayableCount,
        })
      : stats.files > 0
        ? i18n.t("libraryDetail.filesCount", { count: stats.files })
        : "";
  const sizeLabel = stats.knownSizeFiles > 0 ? formatBytes(stats.sizeBytes) : "";
  return [countLabel, sizeLabel].filter(Boolean).join(" · ");
}

export function mediaDeleteTargetKindLabel(target: Pick<MediaDeleteTarget, "kind">) {
  if (target.kind === "cache") return i18n.t("libraryDetail.cache");
  if (target.kind === "local_root") return i18n.t("libraryDetail.workRoot");
  return i18n.t("detailActions.local");
}

export function fileIcon(file: TreeTrack) {
  if (file.kind === "audio") return <FileAudio className="h-4 w-4 text-muted-foreground" />;
  if (file.kind === "video") return <FileVideo className="h-4 w-4 text-muted-foreground" />;
  if (file.kind === "image") return <ImageIcon className="h-4 w-4 text-muted-foreground" />;
  if (file.kind === "text") return <FileText className="h-4 w-4 text-muted-foreground" />;
  return <FileText className="h-4 w-4 text-muted-foreground" />;
}
