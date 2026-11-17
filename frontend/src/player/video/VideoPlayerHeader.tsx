import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

import { VideoShortcutsButton } from "./VideoShortcutsButton";

type Step = {
  label: string;
  /** Absent at either end of the list. */
  onStep: (() => void) | null;
};

/**
 * The header of a full-screen video player: close, the title with the item's
 * place in its list, the shortcut guide, the caller's own actions, and
 * previous and next.
 */
export function VideoPlayerHeader({
  title,
  index,
  total,
  shortcuts,
  previous,
  next,
  onClose,
  children,
}: {
  title: string;
  /** The item's zero-based place in the list it steps through. */
  index: number;
  total: number;
  /** Offers the shortcut guide; shortcuts need a keyboard, so phones leave it out. */
  shortcuts: boolean;
  previous: Step;
  next: Step;
  onClose: () => void;
  /** Actions shown before previous and next. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-1 px-2 py-2 sm:gap-2 sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="h-11 w-11"
        aria-label={t("videoPlayback.closePlayer")}
        onClick={onClose}
      >
        <X className="h-5 w-5" />
      </Button>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-medium sm:text-base" title={title}>
          {title}
        </h2>
        <p className="text-xs tabular-nums text-muted-foreground">
          {t("videoPlayback.position", { current: index + 1, total })}
        </p>
      </div>
      {shortcuts && <VideoShortcutsButton />}
      {children}
      {[
        { step: previous, Icon: ChevronLeft },
        { step: next, Icon: ChevronRight },
      ].map(({ step, Icon }) => (
        <Button
          key={step.label}
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label={step.label}
          title={step.label}
          disabled={!step.onStep}
          onClick={() => step.onStep?.()}
        >
          <Icon className="h-6 w-6" />
        </Button>
      ))}
    </div>
  );
}
