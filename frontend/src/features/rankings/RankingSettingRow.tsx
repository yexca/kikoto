import { AlertTriangle, CalendarPlus, ChevronDown, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/i18n/LocaleProvider";
import type { RankingListPatch } from "@/lib/api";
import { parseServerTimestamp } from "@/lib/serverTimestamp";
import { cn } from "@/lib/tailwindClassNames";

import {
  formatRankingRelative,
  formatRankingStamp,
  RANKING_DEPTHS,
  rankingIntervalOptions,
  type RankingSettingRow,
} from "./rankingModel";

type Translate = (key: string, options?: Record<string, unknown>) => string;

const DAY = 24 * 60;

function intervalLabel(minutes: number, t: Translate) {
  if (minutes % DAY === 0) return t("subscriptions.schedule.days", { count: minutes / DAY });
  if (minutes % 60 === 0) return t("subscriptions.schedule.hours", { count: minutes / 60 });
  return t("subscriptions.rankings.settings.minutes", { count: minutes });
}

function intervalSummary(minutes: number, t: Translate) {
  if (minutes % DAY === 0) return t("subscriptions.rankings.settings.everyDays", { count: minutes / DAY });
  if (minutes % 60 === 0) return t("subscriptions.rankings.settings.everyHours", { count: minutes / 60 });
  return t("subscriptions.rankings.settings.everyMinutes", { count: minutes });
}

function depthOptions(current: number, t: Translate) {
  const values: number[] = [...RANKING_DEPTHS];
  if (!values.includes(current)) values.push(current);
  return values
    .sort((left, right) => left - right)
    .map((value) => ({
      value: String(value),
      label: t("subscriptions.rankings.settings.depthValue", { count: value }),
    }));
}

export type RankingRowHandlers = {
  onShow: (row: RankingSettingRow, enabled: boolean) => void;
  onChange: (row: RankingSettingRow, patch: RankingListPatch) => void;
  onPullNow: (row: RankingSettingRow) => void;
  onDelete: (row: RankingSettingRow) => void;
};

/**
 * One ranking on one line: whether it is shown, when it was and will next be
 * pulled, and a summary of its schedule and depth that expands the row to
 * edit them, pull it now, or delete it with its history. A ranking that is not
 * shown keeps only its switch.
 */
export function RankingSettingRowView({
  row,
  editable,
  busy,
  expanded,
  timeZone,
  now,
  followYear = false,
  onExpandedChange,
  onShow,
  onChange,
  onPullNow,
  onDelete,
}: RankingRowHandlers & {
  row: RankingSettingRow;
  editable: boolean;
  busy: boolean;
  expanded: boolean;
  /** The account's zone for pull times. */
  timeZone: string;
  now: number;
  /** The annual ranking of the year in progress offers to continue with the next year. */
  followYear?: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const editorId = useId();
  const list = row.list;
  const name = row.label;
  const shown = list?.enabled ?? false;
  const finished = Boolean(list?.finalAt);
  const pastYear = row.request.period === "year" && !followYear;
  const scheduled = !finished && !pastYear;
  const interval = list?.refreshIntervalMinutes ?? 0;
  const relative = (value: string | null | undefined) => formatRankingRelative(value, resolvedLocale, timeZone, now);

  const details: string[] = [];
  let warning = "";
  if (!list || !shown) {
    details.push(t("subscriptions.rankings.settings.notShown"));
  } else {
    if (list.finalAt) {
      details.push(
        t("subscriptions.rankings.settings.final", {
          time: formatRankingStamp(list.finalAt, resolvedLocale, timeZone, now),
        }),
      );
    } else {
      details.push(
        list.lastPulledAt
          ? t("subscriptions.rankings.settings.pulled", { time: relative(list.lastPulledAt) })
          : t("subscriptions.rankings.settings.neverPulled"),
      );
      if (list.pullRequested) details.push(t("subscriptions.rankings.settings.pullQueued"));
      else if (scheduled && list.autoRefresh && list.nextPullAt) {
        const next = parseServerTimestamp(list.nextPullAt)?.getTime() ?? 0;
        details.push(
          next <= now
            ? t("subscriptions.rankings.settings.nextDue")
            : t("subscriptions.rankings.settings.next", { time: relative(list.nextPullAt) }),
        );
      }
    }
    if (!list.sourceAvailable) warning = t("subscriptions.rankings.settings.status.source_unavailable");
    else if (list.lastStatus === "failed" || list.lastStatus === "partial")
      warning = t(`subscriptions.rankings.settings.status.${list.lastStatus}`);
  }
  const summary = [
    scheduled
      ? list?.autoRefresh
        ? intervalSummary(interval, t)
        : t("subscriptions.rankings.settings.manual")
      : t("subscriptions.rankings.settings.pulledOnce"),
    t("subscriptions.rankings.settings.depthValue", { count: list?.depth ?? 0 }),
  ].join(" · ");
  const open = shown && expanded && list !== null;
  const canPull = editable && scheduled && list !== null && list.sourceAvailable && !list.pullRequested;

  return (
    <li aria-label={name} className="px-3 py-2">
      <div className="flex min-h-10 items-center gap-3">
        <Switch
          checked={shown}
          disabled={!editable || busy}
          aria-label={t("subscriptions.rankings.settings.show", { name })}
          onCheckedChange={(enabled) => onShow(row, enabled)}
        />
        <div className={cn("min-w-0 flex-1", !shown && "opacity-60")}>
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">{details.join(" · ")}</p>
          {warning && (
            <p className="flex items-center gap-1 text-xs text-warning-foreground">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{warning}</span>
            </p>
          )}
        </div>
        {busy && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />}
        {shown && list && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? editorId : undefined}
            aria-label={t("subscriptions.rankings.settings.summary", { name, summary })}
            className="flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground"
            onClick={() => onExpandedChange(!open)}
          >
            <span className="max-w-[10rem] truncate">{summary}</span>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && (
        <div id={editorId} className="mb-1 mt-2 grid gap-2.5 rounded-md border bg-muted/30 p-3 text-sm">
          {scheduled && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2">
                <Switch
                  checked={list.autoRefresh}
                  disabled={!editable || busy}
                  aria-label={t("subscriptions.rankings.settings.autoRefresh", { name })}
                  onCheckedChange={(autoRefresh) => onChange(row, { autoRefresh })}
                />
                {t("subscriptions.rankings.settings.autoRefreshLabel")}
              </label>
              <FloatingSelect
                value={String(interval)}
                options={rankingIntervalOptions(row.kind, interval).map((value) => ({
                  value: String(value),
                  label: intervalLabel(value, t),
                }))}
                ariaLabel={t("subscriptions.rankings.settings.interval", { name })}
                disabled={!editable || !list.autoRefresh || busy}
                onValueChange={(value) => onChange(row, { refreshIntervalMinutes: Number(value) })}
                className="w-32"
              />
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("subscriptions.rankings.settings.depth")}</span>
            <FloatingSelect
              value={String(list.depth)}
              options={depthOptions(list.depth, t)}
              ariaLabel={`${t("subscriptions.rankings.settings.depth")} · ${name}`}
              disabled={!editable || busy}
              onValueChange={(value) => onChange(row, { depth: Number(value) })}
              className="w-32"
            />
          </div>
          {followYear && !finished && (
            <label className="flex items-start gap-2">
              <Switch
                checked={list.followCurrentYear}
                disabled={!editable || busy}
                aria-label={t("subscriptions.rankings.settings.followYear")}
                onCheckedChange={(followCurrentYear) => onChange(row, { followCurrentYear })}
              />
              <span className="min-w-0 space-y-0.5">
                <span className="block">{t("subscriptions.rankings.settings.followYear")}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("subscriptions.rankings.settings.annualFinal")}{" "}
                  {t("subscriptions.rankings.settings.followYearHint")}
                </span>
              </span>
            </label>
          )}
          {editable && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2.5">
              {scheduled && (
                <Button size="sm" variant="outline" disabled={!canPull || busy} onClick={() => onPullNow(row)}>
                  <RefreshCw className="h-4 w-4" />
                  {t("subscriptions.rankings.settings.pullNow")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-muted-foreground hover:text-destructive"
                disabled={busy}
                onClick={() => onDelete(row)}
              >
                <Trash2 className="h-4 w-4" />
                {t("subscriptions.rankings.settings.delete")}
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The annual rankings of earlier years on one line, listing the years added,
 * which expands to their rows; Add years adds more.
 */
export function EarlierYearsRow({
  rows,
  addableYears,
  addDisabled,
  onAddYears,
  renderRow,
}: {
  rows: RankingSettingRow[];
  addableYears: number[];
  addDisabled: boolean;
  onAddYears: (years: number[]) => void;
  renderRow: (row: RankingSettingRow) => ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const label = t("subscriptions.rankings.settings.earlierYears");
  const years =
    rows.length > 0 ? rows.map((row) => row.label).join(", ") : t("subscriptions.rankings.settings.earlierYearsNone");
  return (
    <li aria-label={label}>
      <div className="flex min-h-10 items-center gap-2 px-3 py-2">
        {rows.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setOpen((current) => !current)}
          >
            <ChevronDown
              className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")}
              aria-hidden="true"
            />
            <span className="shrink-0 text-sm font-medium">{label}</span>
            <span className="min-w-0 text-xs text-muted-foreground">{years}</span>
          </button>
        ) : (
          <p className="min-w-0 flex-1">
            <span className="text-sm font-medium">{label}</span>
            <span className="ml-2 text-xs text-muted-foreground">{years}</span>
          </p>
        )}
        <AddYearsPicker years={addableYears} disabled={addDisabled} onAdd={onAddYears} />
      </div>
      {open && rows.length > 0 && (
        <ul id={listId} className="divide-y border-t pl-4">
          {rows.map(renderRow)}
        </ul>
      )}
    </li>
  );
}

function AddYearsPicker({
  years,
  disabled,
  onAdd,
}: {
  years: number[];
  disabled: boolean;
  onAdd: (years: number[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const toggle = (year: number, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(year);
      else next.delete(year);
      return next;
    });
  return (
    <>
      <Button
        ref={anchorRef}
        size="sm"
        variant="ghost"
        className="shrink-0"
        aria-expanded={open}
        title={years.length === 0 ? t("subscriptions.rankings.settings.addYearsEmpty") : undefined}
        disabled={disabled || years.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        <CalendarPlus className="h-4 w-4" />
        {t("subscriptions.rankings.settings.addYears")}
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        align="end"
        onOpenChange={setOpen}
        ariaLabel={t("subscriptions.rankings.settings.addYears")}
        className="w-[min(14rem,calc(100vw-1.5rem))] p-2 text-sm"
      >
        <div className="app-scroll max-h-64 overflow-y-auto">
          {years.map((year) => (
            <label key={year} className="flex min-h-9 items-center gap-2 rounded-md px-2 hover:bg-muted">
              <Checkbox checked={selected.has(year)} onCheckedChange={(checked) => toggle(year, checked === true)} />
              {year}
            </label>
          ))}
        </div>
        <div className="flex justify-end pt-2">
          <Button
            size="sm"
            disabled={selected.size === 0}
            onClick={() => {
              onAdd([...selected].sort((left, right) => right - left));
              setSelected(new Set());
              setOpen(false);
            }}
          >
            {t("subscriptions.rankings.settings.addSelectedYears", { count: selected.size })}
          </Button>
        </div>
      </AnchoredPopover>
    </>
  );
}

/**
 * Asks before a ranking and its recorded history are deleted. It is portaled
 * above the settings, which may sit in a sheet that would contain it.
 */
export function RankingDeleteDialog({
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return createPortal(
    <Dialog onClose={onCancel} layer="overlay-top" size="sm" role="alertdialog" dismissible={!busy}>
      <DialogHeader
        title={t("subscriptions.rankings.settings.deleteTitle", { name })}
        description={t("subscriptions.rankings.settings.deleteDescription")}
        onClose={busy ? undefined : onCancel}
        closeLabel={t("content.close")}
      />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {t("content.cancel")}
        </Button>
        <Button variant="destructive" onClick={onConfirm} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          {t("subscriptions.rankings.settings.deleteConfirm")}
        </Button>
      </DialogFooter>
    </Dialog>,
    document.body,
  );
}
