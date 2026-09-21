import { useEffect, useState } from "react";
import { ImageIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogHeader } from "@/components/ui/dialog";
import { VideoPreview } from "@/features/work-detail/media/VideoPreview";
import i18n from "@/i18n";
import { api, assetURL } from "@/lib/api";
import { usePlayer } from "@/player/PlayerProvider";

export type FilePreviewState =
  | { kind: "image"; title: string; url: string; locationId: number; canSetCover: boolean }
  | {
      kind: "video";
      title: string;
      url: string;
      locationId: number;
      durationSeconds: number | null;
      canTranscode: boolean;
    }
  | { kind: "text"; title: string; locationId: number; url?: string };

export function FilePreviewDialog({
  preview,
  onClose,
  onSetCover,
}: {
  preview: FilePreviewState;
  onClose: () => void;
  onSetCover?: (locationId: number) => void | Promise<void>;
}) {
  const player = usePlayer();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setText(null);
    setError("");
    if (preview.kind !== "text") return;
    const request = preview.url
      ? fetch(assetURL(preview.url), { headers: { Accept: "text/plain,text/*" } }).then(async (response) => {
          if (!response.ok) throw new Error(i18n.t("libraryDetail.textPreviewHttpError", { status: response.status }));
          const length = Number(response.headers.get("content-length") ?? 0);
          if (length > 512 * 1024) throw new Error(i18n.t("libraryDetail.textFileTooLarge"));
          const content = await response.text();
          if (content.length > 512 * 1024) throw new Error(i18n.t("libraryDetail.textFileTooLarge"));
          return { content };
        })
      : api.getMediaText(preview.locationId);
    request
      .then((result) => setText(result.content))
      .catch((err) => {
        setError(err instanceof Error ? err.message : i18n.t("libraryDetail.textPreviewFailed"));
      });
  }, [preview]);

  return (
    <Dialog onClose={onClose} size="2xl" className="max-h-[86vh] sm:max-h-[86vh]">
      <DialogHeader
        title={<span className="block truncate">{preview.title}</span>}
        onClose={onClose}
        closeLabel={i18n.t("content.close")}
      >
        {preview.kind === "image" && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={!onSetCover || !preview.canSetCover}
            onClick={() => void onSetCover?.(preview.locationId)}
          >
            <ImageIcon className="h-4 w-4" />
            {i18n.t("libraryDetail.setCover")}
          </Button>
        )}
      </DialogHeader>
      <div className="app-scroll min-h-0 flex-1 overflow-auto bg-background p-4">
        {preview.kind === "image" ? (
          <img
            src={assetURL(preview.url)}
            alt=""
            className="mx-auto max-h-[72vh] max-w-full rounded-md object-contain"
          />
        ) : preview.kind === "video" ? (
          <div className="grid min-h-[240px] place-items-center">
            <VideoPreview
              locationId={preview.locationId}
              fallbackUrl={preview.url}
              durationSeconds={preview.durationSeconds}
              canTranscode={preview.canTranscode}
              pauseRequested={player.isPlaying}
              onPlay={player.pause}
            />
          </div>
        ) : error ? (
          <div className="text-sm text-muted-foreground">{error}</div>
        ) : text === null ? (
          <TextPreviewSkeleton />
        ) : (
          <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</pre>
        )}
      </div>
    </Dialog>
  );
}

function TextPreviewSkeleton() {
  return (
    <div className="space-y-3" aria-label={i18n.t("libraryDetail.loadingTextPreview")}>
      <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      <div className="space-y-2">
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="h-4 w-11/12 animate-pulse rounded bg-muted" />
        <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
        <div className="h-4 w-10/12 animate-pulse rounded bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}
