import { BookmarkPlus, Check, CheckCircle2, ChevronRight, Circle, ExternalLink, Headphones, ListMusic, PauseCircle, Repeat2, Star, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, assetURL, type FavoriteList, type ListeningStatus, type WorkProgressSummary } from "@/lib/api";

export type WorkCardBadge = {
  key?: string;
  label: string;
  variant?: "default" | "secondary" | "outline" | "warning";
  title?: string;
  onClick?: () => void;
};

export type WorkCardDate = {
  label: "Release" | "Updated";
  value: string;
};

export type WorkCardViewModel = {
  code: string;
  title: string;
  circle: string;
  circleExternalId?: string;
  coverUrl?: string;
  rating?: number | null;
  series?: string | null;
  dlsiteTags: WorkCardBadge[];
  date?: WorkCardDate | null;
  progress?: WorkProgressSummary | null;
  userTags?: WorkCardBadge[];
  sourceBadges: WorkCardBadge[];
};

export function WorkCardShell({
  work,
  selection,
  footer,
  canOpen = true,
  onOpen,
  onCircleOpen,
  onSeriesOpen,
  onTagOpen,
}: {
  work: WorkCardViewModel;
  selection?: ReactNode;
  footer?: ReactNode;
  canOpen?: boolean;
  onOpen?: () => void;
  onCircleOpen?: (externalId: string) => void;
  onSeriesOpen?: () => void;
  onTagOpen?: (tag: string) => void;
}) {
  const content = (
    <>
      <WorkCardMedia coverUrl={work.coverUrl} code={work.code} rating={work.rating ?? null} selection={selection} />
      <WorkCardBody work={work} onCircleOpen={onCircleOpen} onSeriesOpen={onSeriesOpen} onTagOpen={onTagOpen} />
    </>
  );

  return (
    <Card className="group h-full transition-colors hover:border-primary/50">
      <CardContent className="flex h-full flex-col p-0">
        {onOpen ? (
          <button
            className={`flex flex-1 flex-col text-left ${canOpen ? "cursor-pointer" : "cursor-default"}`}
            disabled={!canOpen}
            onClick={onOpen}
          >
            {content}
          </button>
        ) : (
          <div className="flex flex-1 flex-col text-left">{content}</div>
        )}
        {footer}
      </CardContent>
    </Card>
  );
}

export function WorkCardMedia({
  coverUrl,
  code,
  rating,
  selection,
}: {
  coverUrl?: string;
  code: string;
  rating: number | null;
  selection?: ReactNode;
}) {
  const codeText = code || "Source";
  return (
    <div className="relative aspect-[4/3] overflow-hidden bg-muted">
      {selection}
      {coverUrl ? (
        <img src={assetURL(coverUrl)} alt="" className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]" loading="lazy" />
      ) : (
        <div className="grid h-full place-items-center bg-secondary text-2xl font-bold text-secondary-foreground">{codeText.slice(0, 2)}</div>
      )}
      <div className="absolute left-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">{codeText}</div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">
        <Star className="h-3.5 w-3.5 fill-current" />
        {rating === null ? "No rating" : rating.toFixed(2)}
      </div>
    </div>
  );
}

function WorkCardBody({
  work,
  onCircleOpen,
  onSeriesOpen,
  onTagOpen,
}: {
  work: WorkCardViewModel;
  onCircleOpen?: (externalId: string) => void;
  onSeriesOpen?: () => void;
  onTagOpen?: (tag: string) => void;
}) {
  return (
    <div className="flex min-h-52 flex-1 flex-col gap-3 p-4">
      <div className="space-y-1">
        <h3 className="line-clamp-2 min-h-10 text-base font-semibold leading-snug">{work.title}</h3>
        <button
          className="block max-w-full truncate text-left text-sm text-muted-foreground hover:text-primary"
          onClick={(event) => {
            event.stopPropagation();
            if (work.circleExternalId) onCircleOpen?.(work.circleExternalId);
          }}
        >
          {work.circle || "Unknown circle"}
        </button>
      </div>
      {work.series && (
        onSeriesOpen ? (
          <button
            className="group/series inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-primary"
            onClick={(event) => {
              event.stopPropagation();
              onSeriesOpen();
            }}
          >
            <span className="shrink-0">Series</span>
            <span className="truncate font-medium text-foreground group-hover/series:text-primary">{work.series}</span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60 transition-transform group-hover/series:translate-x-0.5 group-hover/series:opacity-100" />
          </button>
        ) : (
          <div className="truncate text-xs text-muted-foreground">
            Series <span className="font-medium text-foreground">{work.series}</span>
          </div>
        )
      )}
      <BadgeList badges={work.dlsiteTags} emptyLabel="No DLsite tags" onBadgeClick={onTagOpen} />
      {work.date && <div className="truncate text-xs text-muted-foreground">{work.date.label} {work.date.value}</div>}
      {work.progress?.mediaItemId && <WorkProgressLine progress={work.progress} />}
      {work.userTags && work.userTags.length > 0 && (
        <div className="flex min-h-6 flex-wrap gap-1.5">
          {work.userTags.map((tag) => (
            <Badge key={tag.key ?? tag.label} variant={tag.variant ?? "secondary"} title={tag.title} className="border-primary/30 bg-primary/10 text-primary">
              {tag.label}
            </Badge>
          ))}
        </div>
      )}
      <div className="mt-auto">
        <BadgeList badges={work.sourceBadges} emptyLabel="Source unavailable" emptyVariant="warning" />
      </div>
    </div>
  );
}

function BadgeList({
  badges,
  emptyLabel,
  emptyVariant = "outline",
  onBadgeClick,
}: {
  badges: WorkCardBadge[];
  emptyLabel: string;
  emptyVariant?: WorkCardBadge["variant"];
  onBadgeClick?: (label: string) => void;
}) {
  return (
    <div className="flex min-h-6 flex-wrap gap-1.5">
      {badges.length > 0 ? badges.map((badge) => (
        badge.onClick || onBadgeClick ? (
          <button
            key={badge.key ?? `${badge.label}:${badge.variant ?? "secondary"}`}
            onClick={(event) => {
              event.stopPropagation();
              (badge.onClick ?? (() => onBadgeClick?.(badge.label)))();
            }}
            className="rounded-full"
          >
            <Badge variant={badge.variant ?? "secondary"} title={badge.title} className="cursor-pointer hover:border-primary hover:text-primary">
              {badge.label}
            </Badge>
          </button>
        ) : (
          <Badge key={badge.key ?? `${badge.label}:${badge.variant ?? "secondary"}`} variant={badge.variant ?? "secondary"} title={badge.title}>
            {badge.label}
          </Badge>
        )
      )) : <Badge variant={emptyVariant}>{emptyLabel}</Badge>}
    </div>
  );
}

export function WorkProgressLine({ progress }: { progress: WorkProgressSummary }) {
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${workProgressPercent(progress)}%` }} />
      </div>
      <div className="truncate text-xs text-muted-foreground">
        {progress.completed ? `Finished ${progress.title || "track"}` : `Resume ${progress.title || "track"} ${formatTime(progress.positionSeconds)}`}
      </div>
    </div>
  );
}

export function WorkCardFooter({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mt-auto flex h-11 shrink-0 items-center justify-between gap-1 border-t px-3">
      <div className="flex min-w-0 items-center gap-1">{left}</div>
      <div className="flex min-w-0 items-center gap-1">{right}</div>
    </div>
  );
}

export function WorkCardActionButton({
  title,
  disabled,
  children,
  onClick,
}: {
  title: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Button variant="ghost" size="icon" className="h-8 w-8" title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

export function WorkCardQuickMarkButton({
  value,
  disabled,
  onChange,
}: {
  value: ListeningStatus;
  disabled?: boolean;
  onChange: (status: ListeningStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const current = quickMarkMeta(value);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <WorkCardActionButton
        title={`Mark: ${current.label}`}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <current.icon className={`h-4 w-4 ${current.active ? current.className : "text-muted-foreground"}`} />
      </WorkCardActionButton>
      {open && (
        <div className="absolute bottom-10 right-0 z-30 w-40 overflow-hidden rounded-md border border-border bg-card p-1 text-card-foreground shadow-2xl">
          {quickMarkOptions.map((option) => {
            const meta = quickMarkMeta(option.value);
            return (
              <button
                key={option.value}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  onChange(option.value);
                }}
              >
                <meta.icon className={`h-3.5 w-3.5 ${option.value === value && meta.active ? meta.className : ""}`} />
                <span className="min-w-0 flex-1">{option.label}</span>
                {option.value === value && <CheckCircle2 className="h-3.5 w-3.5 text-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function WorkCardListButton({
  workId,
  active,
  disabled,
  onSaved,
}: {
  workId: number | null;
  active: boolean;
  disabled?: boolean;
  onSaved?: (favorite: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<FavoriteList[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !workId) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([api.listFavoriteLists(), api.getWorkFavoriteLists(workId)])
      .then(([allLists, workLists]) => {
        if (cancelled) return;
        setLists(allLists);
        setSelected(new Set(workLists.filter((list) => list.selected).map((list) => list.id)));
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Favorite lists could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workId]);

  const toggle = (listID: number, checked: boolean) => {
    setSelected((items) => {
      const next = new Set(items);
      if (checked) next.add(listID);
      else next.delete(listID);
      return next;
    });
  };

  const save = async () => {
    if (!workId) return;
    setSaving(true);
    setError("");
    try {
      const result = await api.setWorkFavoriteLists(workId, Array.from(selected));
      onSaved?.(result.favorite);
      setOpen(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Favorite lists could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <WorkCardActionButton
        title={active ? "Favorite lists" : "Add to list"}
        disabled={disabled || !workId}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <ListMusic className={`h-4 w-4 ${active ? "fill-current text-primary" : "text-muted-foreground"}`} />
      </WorkCardActionButton>
      {open && (
        <div className="absolute bottom-10 right-0 z-30 w-56 rounded-md border border-border bg-card p-2 text-left text-card-foreground shadow-2xl" onClick={(event) => event.stopPropagation()}>
          <div className="text-sm font-semibold">Favorite lists</div>
          <div className="mt-2 max-h-56 space-y-1.5 overflow-auto">
            {loading ? (
              <div className="rounded-md border bg-background px-2.5 py-2 text-sm text-muted-foreground">Loading lists...</div>
            ) : lists.length > 0 ? lists.map((list) => (
              <label key={list.id} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md border bg-background px-2.5 text-sm hover:bg-muted">
                <input type="checkbox" checked={selected.has(list.id)} onChange={(event) => toggle(list.id, event.target.checked)} />
                <span className="min-w-0 flex-1 truncate">{list.name}</span>
              </label>
            )) : (
              <div className="rounded-md border bg-background px-2.5 py-2 text-sm text-muted-foreground">No favorite lists yet.</div>
            )}
            {error && <div className="rounded-md border bg-background px-2.5 py-2 text-xs text-muted-foreground">{error}</div>}
          </div>
          <div className="mt-2 flex justify-end gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Cancel" aria-label="Cancel" onClick={() => setOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
            <Button size="icon" className="h-8 w-8" title={saving ? "Saving" : "Save"} aria-label={saving ? "Saving" : "Save"} disabled={loading || saving} onClick={() => void save()}>
              <Check className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkCardDLsiteAction({ href }: { href: string }) {
  return (
    <Button variant="ghost" size="icon" className="h-8 w-8" asChild title="Open DLsite">
      <a href={href} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} aria-label="Open DLsite">
        <ExternalLink className="h-4 w-4" />
      </a>
    </Button>
  );
}

export function WorkCardSelection({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="absolute right-3 top-3 z-10 rounded-md bg-background/90 px-2 py-1 text-xs" onClick={(event) => event.stopPropagation()}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

export function dlsiteTagBadges(tags: string[]): WorkCardBadge[] {
  return tags.map((tag) => ({ key: `dlsite:${tag}`, label: tag, variant: "outline" }));
}

const quickMarkOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Paused" },
];

function quickMarkMeta(value: ListeningStatus) {
  switch (value) {
    case "want_to_listen":
      return { label: "Want", icon: BookmarkPlus, active: true, className: "text-primary" };
    case "listening":
      return { label: "Listening", icon: Headphones, active: true, className: "text-primary" };
    case "finished":
      return { label: "Finished", icon: CheckCircle2, active: true, className: "text-emerald-600" };
    case "relisten":
      return { label: "Relisten", icon: Repeat2, active: true, className: "text-primary" };
    case "paused":
      return { label: "Paused", icon: PauseCircle, active: true, className: "text-amber-600" };
    default:
      return { label: "Unmarked", icon: Circle, active: false, className: "" };
  }
}

export function cardDate(releaseDate?: string | null, updatedAt?: string | null): WorkCardDate | null {
  const updated = dateOnly(updatedAt);
  if (updated) return { label: "Updated", value: updated };
  const released = dateOnly(releaseDate);
  return released ? { label: "Release", value: released } : null;
}

export function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function workProgressPercent(progress: WorkProgressSummary) {
  if (!progress.durationSeconds || progress.durationSeconds <= 0) return 0;
  return Math.min(100, Math.max(0, (progress.positionSeconds / progress.durationSeconds) * 100));
}

function dateOnly(value?: string | null) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : trimmed;
}
