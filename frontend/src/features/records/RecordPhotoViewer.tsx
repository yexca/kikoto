import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { assetURL, type RecordAsset } from "@/lib/api";

import { RecordOverlay } from "./RecordOverlay";
import { baseName } from "./recordsModel";

/** A horizontal touch swipe longer than this steps to the neighbouring photo. */
const swipeThresholdPx = 48;

/** The full-screen photo viewer: previous and next by button, arrow key, or touch swipe. */
export function RecordPhotoViewer({
  photo,
  index,
  total,
  previous,
  next,
  onStep,
  onClose,
}: {
  photo: RecordAsset;
  index: number;
  total: number;
  previous: RecordAsset | null;
  next: RecordAsset | null;
  onStep: (id: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const swipe = useRef<{ x: number; y: number; pointerId: number } | null>(null);
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
    <RecordOverlay
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
      </div>
      <div
        className="relative grid min-h-0 flex-1 touch-pan-y select-none place-items-center"
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse")
            swipe.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
        }}
        onPointerCancel={() => {
          swipe.current = null;
        }}
        onPointerUp={(event) => {
          const start = swipe.current;
          swipe.current = null;
          if (!start || start.pointerId !== event.pointerId) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (Math.abs(dx) < swipeThresholdPx || Math.abs(dx) < Math.abs(dy)) return;
          const target = dx < 0 ? next : previous;
          if (target) onStep(target.id);
        }}
      >
        <img
          key={photo.id}
          src={photo.streamUrl ? assetURL(photo.streamUrl) : undefined}
          alt={title}
          decoding="async"
          draggable={false}
          className="max-h-full max-w-full object-contain duration-150 animate-in fade-in-0"
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
    </RecordOverlay>
  );
}
