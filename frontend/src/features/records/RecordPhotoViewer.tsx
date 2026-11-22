import { ChevronLeft, ChevronRight, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { MediaOverlay } from "@/components/media-overlay";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { type ImageZoom, ZoomableImage } from "@/components/zoomable-image";
import { assetURL, type RecordAsset } from "@/lib/api";

import { baseName } from "./recordsModel";

/**
 * The full-screen photo viewer: previous and next by button, arrow key, or
 * touch swipe, and zoom by click, wheel, pinch, or keys. Each photo opens fitted.
 */
export function RecordPhotoViewer({
  photo,
  index,
  total,
  previous,
  next,
  onStep,
  onDelete,
  onClose,
}: {
  photo: RecordAsset;
  index: number;
  total: number;
  previous: RecordAsset | null;
  next: RecordAsset | null;
  onStep: (id: number) => void;
  /** Reviews deleting the photo; absent for a viewer who may not delete files. */
  onDelete?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [zoomState, setZoomState] = useState<{ id: number; zoom: ImageZoom }>({ id: photo.id, zoom: "fit" });
  const zoom = zoomState.id === photo.id ? zoomState.zoom : "fit";
  const title = baseName(photo.name);

  // Warm the neighbours so stepping shows them without a blank frame.
  useEffect(() => {
    for (const neighbour of [previous, next]) {
      if (!neighbour?.streamUrl) continue;
      const image = new Image();
      image.decoding = "async";
      image.src = assetURL(neighbour.streamUrl);
    }
  }, [previous, next]);

  return (
    <MediaOverlay
      label={t("records.photo.label", { name: title })}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" && previous) {
          event.preventDefault();
          onStep(previous.id);
        } else if (event.key === "ArrowRight" && next) {
          event.preventDefault();
          onStep(next.id);
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-1 px-2 py-2 sm:gap-2 sm:px-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label={t("records.photo.close")}
          onClick={onClose}
        >
          <X className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium sm:text-base">{title}</h2>
          <p className="text-xs tabular-nums text-muted-foreground">
            {t("records.photo.position", { current: index + 1, total })}
          </p>
        </div>
        {onDelete && (
          <ActionMenu
            quiet
            label={t("records.actions.more")}
            buttonLabel={t("records.actions.more")}
            buttonLabelClassName="hidden"
            triggerClassName="h-11 w-11"
            items={[
              {
                key: "delete",
                label: t("records.delete.action"),
                icon: <Trash2 className="h-4 w-4" />,
                destructive: true,
                onSelect: onDelete,
              },
            ]}
          />
        )}
      </div>
      <div className="relative flex min-h-0 flex-1 select-none">
        <ZoomableImage
          key={photo.id}
          src={photo.streamUrl ? assetURL(photo.streamUrl) : undefined}
          alt={title}
          zoom={zoom}
          onZoomChange={(value) => setZoomState({ id: photo.id, zoom: value })}
          onSwipe={(direction) => {
            const target = direction > 0 ? next : previous;
            if (target) onStep(target.id);
          }}
          className="flex-1"
          imageClassName="duration-150 animate-in fade-in-0"
        />
        <Button
          variant="ghost"
          size="icon"
          className="absolute left-2 top-1/2 h-11 w-11 -translate-y-1/2 bg-background/40 sm:left-4"
          aria-label={t("records.photo.previous")}
          title={t("records.photo.previous")}
          disabled={!previous}
          onClick={() => previous && onStep(previous.id)}
        >
          <ChevronLeft className="h-6 w-6" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-2 top-1/2 h-11 w-11 -translate-y-1/2 bg-background/40 sm:right-4"
          aria-label={t("records.photo.next")}
          title={t("records.photo.next")}
          disabled={!next}
          onClick={() => next && onStep(next.id)}
        >
          <ChevronRight className="h-6 w-6" />
        </Button>
      </div>
    </MediaOverlay>
  );
}
