import { Check, Gauge, RefreshCw, X } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useId, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/tailwindClassNames";
import { isPlaybackCompatibilityScope } from "@/player/playerPersistence";
import { usePlayerTime, type usePlayer } from "@/player/PlayerProvider";
import type { PlayerTrack, PlayerTrackLocation } from "@/player/playerTypes";
import { parseSleepRewindDraft, SLEEP_REWIND_MINUTES_MAX, SLEEP_REWIND_MINUTES_MIN } from "@/player/sleepRewind";

import { formatSleepRemaining, validSleepMinutes } from "./playerFormat";

type PlayerState = ReturnType<typeof usePlayer>;

const menuSurface = "rounded-2xl border-border/70 p-1.5 shadow-2xl";
const menuRow =
  "flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-sm transition-colors hover:bg-muted active:bg-muted disabled:opacity-40";

/** The sleep timer countdown; re-renders with the playback clock instead of its menu or button. */
export function SleepRemaining() {
  const { sleepRemainingSeconds } = usePlayerTime();
  return formatSleepRemaining(sleepRemainingSeconds);
}

export function SleepTimerMenu({
  open,
  anchorRef,
  onOpenChange,
  player,
  customOpen,
  onCustomOpenChange,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  player: PlayerState;
  customOpen: boolean;
  onCustomOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const rewindInputId = useId();
  const [finishCurrentTrack, setFinishCurrentTrack] = useState(false);
  const [customMinutes, setCustomMinutes] = useState("90");
  const [rewindDraft, setRewindDraft] = useState(String(player.sleepRewindMinutes));
  const rewindDraftValid = parseSleepRewindDraft(rewindDraft) !== null;

  useEffect(() => {
    if (!open) return;
    setFinishCurrentTrack(Boolean(player.sleepTimer?.finishCurrentTrack));
    if (player.sleepTimer && !player.sleepTimer.waitingForTrackEnd) {
      setCustomMinutes(String(Math.max(1, Math.ceil((player.sleepTimer.deadline - Date.now()) / 60_000))));
    }
    setRewindDraft(String(player.sleepRewindMinutes));
    onCustomOpenChange(false);
  }, [open]);

  const start = (minutes: number) => {
    player.setSleepTimerMinutes(minutes, finishCurrentTrack);
    onOpenChange(false);
  };

  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onOpenChange={onOpenChange}
      className={cn("w-[min(14rem,calc(100vw-1.5rem))]", menuSurface)}
    >
      <div className="flex items-center justify-between px-2.5 pb-1.5 pt-1 text-xs font-semibold text-muted-foreground">
        <span>{t("player.sleepTimer")}</span>
        {player.sleepTimer && (
          <span className="tabular-nums text-primary">
            {player.sleepTimer.waitingForTrackEnd ? t("player.finishingTrack") : <SleepRemaining />}
          </span>
        )}
      </div>
      <label className={cn(menuRow, "cursor-pointer justify-between gap-3 py-1.5")}>
        <span className="min-w-0">
          <span className="block font-medium">{t("player.finishTrack")}</span>
          <span className="block text-xs text-muted-foreground">{t("player.afterTimerExpires")}</span>
        </span>
        <Switch
          checked={finishCurrentTrack}
          onCheckedChange={(enabled) => {
            setFinishCurrentTrack(enabled);
            if (player.sleepTimer) player.setSleepFinishCurrentTrack(enabled);
          }}
          aria-label={t("player.finishTrack")}
        />
      </label>
      <div className="flex min-h-10 w-full items-center justify-between gap-3 rounded-xl px-2.5 py-1.5 text-sm">
        <label htmlFor={rewindInputId} className="min-w-0">
          <span className="block font-medium">{t("player.sleepRewind")}</span>
          <span id={`${rewindInputId}-state`} className="block text-xs text-muted-foreground">
            {player.sleepRewindMinutes > 0
              ? t("player.sleepRewindActive", { count: player.sleepRewindMinutes })
              : t("player.sleepRewindOff")}
          </span>
        </label>
        <span
          className={cn(
            "flex h-9 w-[4.75rem] shrink-0 overflow-hidden rounded-xl border bg-background focus-within:ring-2 focus-within:ring-ring",
            !rewindDraftValid && "border-error-border",
          )}
        >
          <input
            id={rewindInputId}
            className="min-w-0 flex-1 bg-transparent px-2 text-right text-sm tabular-nums text-foreground outline-none"
            type="number"
            min={SLEEP_REWIND_MINUTES_MIN}
            max={SLEEP_REWIND_MINUTES_MAX}
            step={1}
            inputMode="numeric"
            value={rewindDraft}
            aria-label={t("player.sleepRewindMinutes")}
            aria-describedby={`${rewindInputId}-state`}
            aria-invalid={!rewindDraftValid}
            onChange={(event) => {
              const draft = event.currentTarget.value;
              setRewindDraft(draft);
              const minutes = parseSleepRewindDraft(draft);
              if (minutes !== null && minutes !== player.sleepRewindMinutes) player.setSleepRewindMinutes(minutes);
            }}
            onBlur={() => setRewindDraft(String(player.sleepRewindMinutes))}
          />
          <span className="flex items-center border-l bg-muted/60 px-2 text-xs text-muted-foreground">
            {t("player.minutesUnit")}
          </span>
        </span>
      </div>
      <div className="mx-2.5 my-1 h-px bg-border/70" />
      {[30, 60].map((minutes) => (
        <button key={minutes} type="button" className={menuRow} onClick={() => start(minutes)}>
          {t("player.minutesCount", { count: minutes })}
        </button>
      ))}
      <button
        type="button"
        className={menuRow}
        onClick={() => onCustomOpenChange(!customOpen)}
        aria-expanded={customOpen}
      >
        {t("player.custom")}
      </button>
      {customOpen && (
        <div className="flex items-end gap-2 px-2.5 py-2">
          <label className="min-w-0 flex-1 text-xs text-muted-foreground">
            {t("player.minutes")}
            <input
              className="mt-1 h-9 w-full rounded-xl border bg-background px-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              type="number"
              min={1}
              max={1440}
              step={1}
              inputMode="numeric"
              value={customMinutes}
              onChange={(event) => setCustomMinutes(event.currentTarget.value)}
              aria-label={t("player.customSleepMinutes")}
            />
          </label>
          <Button
            className="rounded-xl"
            size="sm"
            disabled={!validSleepMinutes(customMinutes)}
            onClick={() => start(Number(customMinutes))}
          >
            {t("player.setTimer")}
          </Button>
        </div>
      )}
      {player.sleepTimer && (
        <>
          <div className="mx-2.5 my-1 h-px bg-border/70" />
          <button
            type="button"
            className={cn(menuRow, "text-destructive")}
            onClick={() => {
              player.clearSleepTimer();
              onOpenChange(false);
            }}
          >
            <X className="h-4 w-4" /> {t("player.cancelTimer")}
          </button>
        </>
      )}
    </AnchoredPopover>
  );
}

export function MoreOptionsMenu({
  open,
  anchorRef,
  onOpenChange,
  player,
  track,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  player: PlayerState;
  track: PlayerTrack;
}) {
  const { t } = useTranslation();
  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onOpenChange={onOpenChange}
      floatingLayer
      ariaLabel={t("player.moreOptions")}
      className={cn("w-[min(19rem,calc(100vw-1.5rem))] p-3", menuSurface)}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1 text-xs font-semibold text-muted-foreground">
          <Gauge className="h-4 w-4" />
          <span>{t("player.playbackSpeed")}</span>
        </div>
        <FloatingSelect
          value={String(player.playbackRate)}
          options={[0.75, 1, 1.25, 1.5, 2].map((rate) => ({ value: String(rate), label: `${rate}×` }))}
          onValueChange={(value) => player.setPlaybackRate(Number(value))}
          ariaLabel={t("player.playbackSpeed")}
          className="h-10 rounded-xl"
        />
        <div className="flex items-center gap-2 px-1 text-xs font-semibold text-muted-foreground">
          <RefreshCw className="h-4 w-4" />
          <span>{t("player.compatibility")}</span>
        </div>
        <FloatingSelect
          value={player.playbackCompatibilityScope}
          options={[
            { value: "off", label: t("player.directPlayback") },
            { value: "track", label: t("player.onlyCurrentTrack") },
            { value: "queue", label: t("player.currentQueue") },
            { value: "always", label: t("player.alwaysEnabled") },
          ]}
          onValueChange={(value) => {
            if (isPlaybackCompatibilityScope(value)) player.setPlaybackCompatibility(value);
          }}
          ariaLabel={t("player.compatibilityScope")}
          disabled={track.locationType !== "local" && track.locationType !== "cache"}
          className="h-10 rounded-xl"
        />
      </div>
    </AnchoredPopover>
  );
}

export function locationLabel(
  location: Pick<PlayerTrackLocation, "sourceName" | "locationType"> | undefined,
  t: TFunction,
) {
  if (!location) return t("player.playbackSource");
  return (
    location.sourceName || t(`player.locationTypes.${location.locationType}`, { defaultValue: location.locationType })
  );
}

export function SourceMenu({
  open,
  anchorRef,
  onOpenChange,
  locations,
  currentLocationId,
  onSelect,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  locations: PlayerTrackLocation[];
  currentLocationId: number;
  onSelect: (locationId: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <AnchoredPopover
      open={open}
      anchorRef={anchorRef}
      onOpenChange={onOpenChange}
      ariaLabel={t("player.chooseSource")}
      className={cn("w-[min(16rem,calc(100vw-1.5rem))]", menuSurface)}
    >
      {locations.map((location) => {
        const selected = location.locationId === currentLocationId;
        return (
          <button
            key={`${location.locationId}:${location.locationType}`}
            type="button"
            className={cn(menuRow, "justify-between py-1.5")}
            aria-current={selected ? "true" : undefined}
            onClick={() => {
              onSelect(location.locationId);
              onOpenChange(false);
            }}
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{locationLabel(location, t)}</span>
              <span className="block text-xs text-muted-foreground">
                {t(`player.locationTypes.${location.locationType}`, { defaultValue: location.locationType })}
                {" · "}
                {t(`player.availability.${location.availability}`, { defaultValue: location.availability })}
              </span>
            </span>
            {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
          </button>
        );
      })}
    </AnchoredPopover>
  );
}
