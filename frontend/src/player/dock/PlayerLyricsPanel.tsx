import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { FloatingSelect } from "@/components/ui/floating-select";
import { cn } from "@/lib/tailwindClassNames";
import { lyricsChoiceDisplayLabel, type LyricsChoice } from "@/player/lyricsMatching";

import type { ParsedLyrics } from "./timedLyrics";

export function LyricsLoadingSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4 p-5" aria-label={t("player.loadingLyrics")}>
      <div className="h-3 w-24 animate-pulse rounded-full bg-foreground/10" />
      <div className="space-y-3 pt-2">
        <div className="h-5 w-4/5 animate-pulse rounded-full bg-foreground/10" />
        <div className="h-5 w-2/3 animate-pulse rounded-full bg-foreground/10" />
        <div className="h-5 w-5/6 animate-pulse rounded-full bg-foreground/10" />
        <div className="h-5 w-3/5 animate-pulse rounded-full bg-foreground/10" />
      </div>
    </div>
  );
}

export function LyricsPanel({
  title,
  text,
  parsed,
  activeIndex,
  choices,
  activeLocationId,
  automatic,
  onChoiceChange,
  onSeek,
}: {
  title: string;
  text: string;
  parsed: ParsedLyrics;
  activeIndex: number;
  choices: LyricsChoice[];
  activeLocationId: number;
  automatic: boolean;
  onChoiceChange: (locationId: number | null) => void;
  onSeek: (seconds: number) => void;
}) {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const manualScrollUntilRef = useRef(0);
  const [following, setFollowing] = useState(true);

  const centerActiveLine = useCallback((behavior: ScrollBehavior) => {
    const scroller = scrollerRef.current;
    const line = activeRef.current;
    if (!scroller || !line) return;
    const top = line.offsetTop - scroller.clientHeight * 0.38 + line.clientHeight / 2;
    scroller.scrollTo({ top: Math.max(0, top), behavior });
  }, []);

  useEffect(() => {
    if (!following) return;
    centerActiveLine("smooth");
  }, [activeIndex, centerActiveLine, following]);

  useEffect(() => {
    centerActiveLine("auto");
  }, [centerActiveLine, text]);

  useEffect(() => {
    if (following) return;
    const timer = window.setInterval(() => {
      if (Date.now() >= manualScrollUntilRef.current) setFollowing(true);
    }, 500);
    return () => window.clearInterval(timer);
  }, [following]);

  const noteManualScroll = () => {
    manualScrollUntilRef.current = Date.now() + 4000;
    setFollowing(false);
  };

  const selector = (
    <LyricsSourceSelector
      title={title}
      choices={choices}
      activeLocationId={activeLocationId}
      automatic={automatic}
      onChoiceChange={onChoiceChange}
    />
  );

  if (!parsed.timed) {
    return (
      <div className="app-scroll h-full space-y-3 overflow-auto px-5 py-4">
        {selector}
        <pre className="whitespace-pre-wrap break-words font-sans text-base leading-relaxed">{text}</pre>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-5 pt-3">{selector}</div>
      <div
        ref={scrollerRef}
        className="lyrics-scroller app-scroll relative min-h-0 flex-1 overflow-auto px-3"
        onWheel={noteManualScroll}
        onTouchMove={noteManualScroll}
      >
        <div className="pb-[55%] pt-[30%]">
          {parsed.lines.map((line, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={`${line.time}:${index}`}
                ref={active ? activeRef : undefined}
                type="button"
                data-lyric-index={index}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "block w-full rounded-xl px-2 py-2 text-left text-xl font-bold leading-snug tracking-tight transition-[color,opacity] duration-300 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  active ? "text-foreground" : "text-foreground/30 hover:text-foreground/60",
                )}
                onClick={() => {
                  onSeek(line.time);
                  setFollowing(true);
                }}
                title={t("player.seekToLine")}
              >
                {line.text || " "}
              </button>
            );
          })}
        </div>
      </div>
      {!following && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button
            type="button"
            className="pointer-events-auto rounded-full bg-foreground/[0.08] px-3.5 py-1.5 text-xs font-semibold text-foreground shadow-sm backdrop-blur-2xl hover:bg-foreground/[0.12]"
            onClick={() => setFollowing(true)}
          >
            {t("player.followLyrics")}
          </button>
        </div>
      )}
    </div>
  );
}

function LyricsSourceSelector({
  title,
  choices,
  activeLocationId,
  automatic,
  onChoiceChange,
}: {
  title: string;
  choices: LyricsChoice[];
  activeLocationId: number;
  automatic: boolean;
  onChoiceChange: (locationId: number | null) => void;
}) {
  const { t } = useTranslation();
  if (choices.length <= 1 && automatic)
    return <div className="truncate text-xs font-medium text-muted-foreground">{title}</div>;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0 font-semibold">{t("player.lyrics")}</span>
      <FloatingSelect
        value={automatic ? "auto" : String(activeLocationId)}
        onValueChange={(value) => onChoiceChange(value === "auto" ? null : Number(value))}
        ariaLabel={t("player.lyrics")}
        className="h-8 w-auto min-w-0 flex-1 rounded-full px-3 text-xs"
        contentClassName="max-w-[calc(100vw-1.5rem)]"
        options={[
          { value: "auto", label: t("common.auto") },
          ...choices.map((choice) => ({
            value: String(choice.locationId),
            label: lyricsChoiceDisplayLabel(choice, choices),
          })),
        ]}
      />
    </div>
  );
}
