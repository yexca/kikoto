import { Star } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwindClassNames";

const stars = [1, 2, 3, 4, 5] as const;

/**
 * The viewer's own one-to-five-star rating: a star showing the current number,
 * which opens a popover of stars to rate the work or clear the rating. The
 * card variant matches the icon actions of a work card footer.
 */
export function WorkRatingControl({
  value,
  disabled,
  variant = "outline",
  showLabel = false,
  onChange,
}: {
  value: number | null;
  disabled?: boolean;
  variant?: "outline" | "card";
  /** Names the unrated control beside its star, so a lone star does not read as a favorite toggle. */
  showLabel?: boolean;
  onChange: (rating: number | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const rated = value !== null;
  const title = rated ? t("workCard.userRatingValue", { value }) : t("workCard.rateWork");
  const shown = preview ?? value ?? 0;
  const choose = (rating: number | null) => {
    setOpen(false);
    setPreview(null);
    if (rating !== value) onChange(rating);
  };

  return (
    <div className="relative" ref={ref}>
      <Button
        type="button"
        variant={variant === "card" ? "ghost" : "outline"}
        size="sm"
        className={cn(
          "h-8",
          rated || showLabel ? (variant === "card" ? "gap-1 px-1.5" : "gap-1.5 px-2.5") : "w-8 px-0",
        )}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <Star className={cn("h-4 w-4", rated ? "fill-current text-primary" : "text-muted-foreground")} />
        {rated ? (
          <span className="font-semibold tabular-nums">{value}</span>
        ) : (
          showLabel && <span>{t("workCard.rateShort")}</span>
        )}
      </Button>
      <AnchoredPopover
        open={open && !disabled}
        anchorRef={ref}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setPreview(null);
        }}
        ariaLabel={t("workCard.userRating")}
        bottomCollisionPadding={isMobileViewport() ? 168 : 12}
        className="p-2 text-sm"
      >
        <div className="mb-1 px-1 text-xs font-medium text-muted-foreground">{t("workCard.userRating")}</div>
        <div
          role="group"
          aria-label={t("workCard.userRating")}
          className="flex items-center"
          onPointerLeave={() => setPreview(null)}
        >
          {stars.map((star) => {
            const label = t("workCard.rateStars", { count: star });
            return (
              <button
                key={star}
                type="button"
                className="flex h-11 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
                aria-label={label}
                aria-pressed={star === value}
                title={label}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") setPreview(star);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  choose(star);
                }}
              >
                <Star className={cn("h-5 w-5", star <= shown && "fill-current text-primary")} />
              </button>
            );
          })}
        </div>
        {rated && (
          <button
            type="button"
            className="mt-1 flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
            onClick={(event) => {
              event.stopPropagation();
              choose(null);
            }}
          >
            {t("workCard.clearUserRating")}
          </button>
        )}
      </AnchoredPopover>
    </div>
  );
}

/** Phones keep the popover above the bottom navigation and player. */
function isMobileViewport() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
}
