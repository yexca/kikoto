import { Play } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { assetURL } from "@/lib/api";

import { formatPlaybackTime } from "./recordsModel";

export type RecordPrimaryAction =
  { kind: "play"; videoId: number } | { kind: "continue"; videoId: number; position: number };

function PrimaryAction({
  action,
  onPlay,
}: {
  action: RecordPrimaryAction | null;
  onPlay: (action: RecordPrimaryAction) => void;
}) {
  const { t } = useTranslation();
  if (!action) return null;
  return (
    <Button onClick={() => onPlay(action)}>
      <Play className="h-4 w-4 fill-current" />
      {action.kind === "continue"
        ? t("records.continueFrom", { time: formatPlaybackTime(action.position) })
        : t("records.play")}
    </Button>
  );
}

/**
 * The open folder's heading. A folder with backdrop artwork gets a calm banner:
 * the backdrop dimmed toward the card surface, its poster, name, counts, and
 * one primary action; other folders get a plain heading with the same facts.
 */
export function RecordFolderHeader({
  name,
  posterUrl,
  backdropUrl,
  videoCount,
  photoCount,
  action,
  onPlay,
}: {
  name: string;
  posterUrl?: string;
  backdropUrl?: string;
  videoCount: number;
  photoCount: number;
  action: RecordPrimaryAction | null;
  onPlay: (action: RecordPrimaryAction) => void;
}) {
  const { t } = useTranslation();
  const counts = `${t("records.videoCount", { count: videoCount })} · ${t("records.photoCount", { count: photoCount })}`;

  if (!backdropUrl) {
    return (
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold">{name}</h2>
          <p className="text-sm text-muted-foreground">{counts}</p>
        </div>
        <PrimaryAction action={action} onPlay={onPlay} />
      </div>
    );
  }

  return (
    <section className="relative isolate overflow-clip rounded-xl border bg-card" aria-label={name}>
      <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
        <img src={assetURL(backdropUrl)} alt="" decoding="async" className="h-full w-full object-cover opacity-60" />
        {/* The scrim is densest behind the title and counts, so they stay readable over a busy backdrop. */}
        <div className="absolute inset-0 bg-gradient-to-t from-card from-40% via-card/90 to-card/40 sm:bg-gradient-to-r sm:from-card sm:from-45% sm:via-card/90 sm:via-60% sm:to-card/20" />
      </div>
      <div className="flex min-h-[13rem] items-end gap-4 p-4 sm:min-h-[16rem] sm:gap-6 sm:p-6">
        {posterUrl && (
          <div className="w-24 shrink-0 overflow-hidden rounded-lg bg-muted shadow-xl ring-1 ring-border sm:w-36">
            <img
              src={assetURL(posterUrl)}
              alt=""
              decoding="async"
              className="aspect-[2/3] h-full w-full object-cover"
            />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="min-w-0">
            <h2 className="line-clamp-2 text-2xl font-semibold tracking-tight sm:text-3xl">{name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{counts}</p>
          </div>
          <div>
            <PrimaryAction action={action} onPlay={onPlay} />
          </div>
        </div>
      </div>
    </section>
  );
}
