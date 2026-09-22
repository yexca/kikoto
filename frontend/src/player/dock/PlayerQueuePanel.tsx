import { ArrowDown, ArrowUp, Menu, MoreHorizontal, Trash2 } from "lucide-react";
import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { OverflowMarquee } from "@/components/ui/overflow-marquee";
import { cn } from "@/lib/tailwindClassNames";
import type { PlayerTrack } from "@/player/playerTypes";

import { CoverImage, NowPlayingBars } from "./playerControls";
import { queueDragShift, resolveQueueDrag, type QueueRowLayout } from "./queueDrag";

type QueueDragSession = {
  queueItemId: string;
  pointerId: number;
  ids: string[];
  layout: QueueRowLayout[];
  fromIndex: number;
  targetIndex: number;
  startClientY: number;
  lastClientY: number;
  startScrollTop: number;
  moved: boolean;
};

const AUTO_SCROLL_EDGE_PX = 56;

export function PlayerQueuePanel({
  queue,
  currentIndex,
  isPlaying,
  onSelect,
  onMove,
  onMoveTo,
  onRemove,
  onClear,
}: {
  queue: PlayerTrack[];
  currentIndex: number;
  isPlaying: boolean;
  onSelect: (index: number) => void;
  onMove: (queueItemId: string, direction: -1 | 1) => void;
  onMoveTo: (queueItemId: string, targetIndex: number) => void;
  onRemove: (queueItemId: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());
  const dragRef = useRef<QueueDragSession | null>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const callbacksRef = useRef({ onSelect, onMove, onMoveTo, onRemove });
  callbacksRef.current = { onSelect, onMove, onMoveTo, onRemove };

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const currentId = queue[currentIndex]?.queueItemId;
    const row = currentId ? rowRefs.current.get(currentId) : null;
    if (!scroller || !row) return;
    scroller.scrollTop = Math.max(0, row.offsetTop - scroller.clientHeight / 2 + row.offsetHeight / 2);
    // Only center the current track when the queue opens.
  }, []);

  useLayoutEffect(() => {
    const id = pendingFocusRef.current;
    if (!id) return;
    pendingFocusRef.current = null;
    handleRefs.current.get(id)?.focus();
  }, [queue]);

  const clearDragStyles = useCallback((session: QueueDragSession) => {
    scrollerRef.current?.removeAttribute("data-reordering");
    for (const id of session.ids) {
      const row = rowRefs.current.get(id);
      if (row) row.style.transform = "";
    }
  }, []);

  const renderDragFrame = useCallback((clientY: number) => {
    const session = dragRef.current;
    const scroller = scrollerRef.current;
    if (!session || !scroller) return;
    session.lastClientY = clientY;
    if (Math.abs(clientY - session.startClientY) > 4) session.moved = true;
    const rawOffset = clientY - session.startClientY + scroller.scrollTop - session.startScrollTop;
    const { offset, target } = resolveQueueDrag(session.layout, session.fromIndex, rawOffset);
    const draggedRow = rowRefs.current.get(session.queueItemId);
    if (draggedRow) draggedRow.style.transform = `translate3d(0, ${offset}px, 0)`;
    if (target === session.targetIndex) return;
    const draggedHeight = session.layout[session.fromIndex].height;
    const start = Math.min(session.fromIndex, session.targetIndex, target);
    const end = Math.max(session.fromIndex, session.targetIndex, target);
    session.targetIndex = target;
    for (let index = start; index <= end; index += 1) {
      if (index === session.fromIndex) continue;
      const row = rowRefs.current.get(session.ids[index]);
      const shift = queueDragShift(index, session.fromIndex, target, draggedHeight);
      if (row) row.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : "";
    }
  }, []);

  const finishDrag = useCallback(
    (commit: boolean) => {
      const session = dragRef.current;
      if (!session) return;
      dragRef.current = null;
      clearDragStyles(session);
      setDraggingId(null);
      if (commit && session.targetIndex !== session.fromIndex) {
        pendingFocusRef.current = null;
        callbacksRef.current.onMoveTo(session.queueItemId, session.targetIndex);
      }
    },
    [clearDragStyles],
  );

  const beginDrag = useCallback((queueItemId: string, event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const ids: string[] = [];
    const layout: QueueRowLayout[] = [];
    for (const [id, row] of rowRefs.current) {
      ids.push(id);
      layout.push({ top: row.offsetTop, height: row.offsetHeight });
    }
    const order = layout.map((_, index) => index).sort((left, right) => layout[left].top - layout[right].top);
    const sortedIds = order.map((index) => ids[index]);
    const sortedLayout = order.map((index) => layout[index]);
    const fromIndex = sortedIds.indexOf(queueItemId);
    if (fromIndex < 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      queueItemId,
      pointerId: event.pointerId,
      ids: sortedIds,
      layout: sortedLayout,
      fromIndex,
      targetIndex: fromIndex,
      startClientY: event.clientY,
      lastClientY: event.clientY,
      startScrollTop: scroller.scrollTop,
      moved: false,
    };
    scroller.setAttribute("data-reordering", "true");
    setDraggingId(queueItemId);
  }, []);

  const moveDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      renderDragFrame(event.clientY);
    },
    [renderDragFrame],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, commit: boolean) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      finishDrag(commit);
    },
    [finishDrag],
  );

  const moveWithKeyboard = useCallback((queueItemId: string, index: number, direction: -1 | 1) => {
    pendingFocusRef.current = queueItemId;
    callbacksRef.current.onMoveTo(queueItemId, index + direction);
  }, []);

  useEffect(() => {
    if (!draggingId) return;
    let frame = 0;
    const autoScroll = () => {
      const session = dragRef.current;
      const scroller = scrollerRef.current;
      if (session?.moved && scroller) {
        const rect = scroller.getBoundingClientRect();
        const topDistance = session.lastClientY - rect.top;
        const bottomDistance = rect.bottom - session.lastClientY;
        const velocity =
          topDistance < AUTO_SCROLL_EDGE_PX
            ? -Math.ceil((AUTO_SCROLL_EDGE_PX - Math.max(0, topDistance)) / 5)
            : bottomDistance < AUTO_SCROLL_EDGE_PX
              ? Math.ceil((AUTO_SCROLL_EDGE_PX - Math.max(0, bottomDistance)) / 5)
              : 0;
        if (velocity !== 0) {
          const before = scroller.scrollTop;
          scroller.scrollTop = before + velocity;
          if (scroller.scrollTop !== before) renderDragFrame(session.lastClientY);
        }
      }
      frame = window.requestAnimationFrame(autoScroll);
    };
    frame = window.requestAnimationFrame(autoScroll);
    const cancelWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finishDrag(false);
    };
    window.addEventListener("keydown", cancelWithEscape, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", cancelWithEscape, true);
    };
  }, [draggingId, finishDrag, renderDragFrame]);

  useEffect(
    () => () => {
      const session = dragRef.current;
      if (session) clearDragStyles(session);
      dragRef.current = null;
    },
    [clearDragStyles],
  );

  const registerRow = useCallback((queueItemId: string, element: HTMLDivElement | null) => {
    if (element) rowRefs.current.set(queueItemId, element);
    else rowRefs.current.delete(queueItemId);
  }, []);
  const registerHandle = useCallback((queueItemId: string, element: HTMLButtonElement | null) => {
    if (element) handleRefs.current.set(queueItemId, element);
    else handleRefs.current.delete(queueItemId);
  }, []);
  const select = useCallback((index: number) => callbacksRef.current.onSelect(index), []);
  const move = useCallback(
    (queueItemId: string, direction: -1 | 1) => callbacksRef.current.onMove(queueItemId, direction),
    [],
  );
  const remove = useCallback((queueItemId: string) => callbacksRef.current.onRemove(queueItemId), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-end justify-between gap-3 px-4 pb-2 pt-3">
        <div className="min-w-0">
          <div className="text-base font-bold tracking-tight">{t("player.queue")}</div>
          <div className="text-xs tabular-nums text-muted-foreground">
            {t("player.queued", { count: queue.length })} · {Math.min(queue.length, currentIndex + 1)} / {queue.length}
          </div>
        </div>
        <button
          type="button"
          className="touch-target relative h-8 shrink-0 rounded-full px-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/10 active:bg-primary/15"
          onClick={onClear}
        >
          {t("player.clearQueue")}
        </button>
      </div>
      <div
        ref={scrollerRef}
        className="player-queue app-scroll relative min-h-0 flex-1 overflow-auto overscroll-contain px-2 pb-3"
        role="list"
        aria-label={t("player.queue")}
      >
        {queue.map((item, index) => (
          <PlayerQueueRow
            key={item.queueItemId ?? `${item.locationId}:${index}`}
            item={item}
            index={index}
            active={index === currentIndex}
            playing={index === currentIndex && isPlaying}
            first={index === 0}
            last={index === queue.length - 1}
            dragging={draggingId !== null && draggingId === item.queueItemId}
            registerRow={registerRow}
            registerHandle={registerHandle}
            onSelect={select}
            onMove={move}
            onRemove={remove}
            onDragStart={beginDrag}
            onDragMove={moveDrag}
            onDragEnd={endDrag}
            onKeyboardMove={moveWithKeyboard}
          />
        ))}
      </div>
    </div>
  );
}

const PlayerQueueRow = memo(function PlayerQueueRow({
  item,
  index,
  active,
  playing,
  first,
  last,
  dragging,
  registerRow,
  registerHandle,
  onSelect,
  onMove,
  onRemove,
  onDragStart,
  onDragMove,
  onDragEnd,
  onKeyboardMove,
}: {
  item: PlayerTrack;
  index: number;
  active: boolean;
  playing: boolean;
  first: boolean;
  last: boolean;
  dragging: boolean;
  registerRow: (queueItemId: string, element: HTMLDivElement | null) => void;
  registerHandle: (queueItemId: string, element: HTMLButtonElement | null) => void;
  onSelect: (index: number) => void;
  onMove: (queueItemId: string, direction: -1 | 1) => void;
  onRemove: (queueItemId: string) => void;
  onDragStart: (queueItemId: string, event: React.PointerEvent<HTMLButtonElement>) => void;
  onDragMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onDragEnd: (event: React.PointerEvent<HTMLButtonElement>, commit: boolean) => void;
  onKeyboardMove: (queueItemId: string, index: number, direction: -1 | 1) => void;
}) {
  const { t } = useTranslation();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLButtonElement | null>(null);
  const queueItemId = item.queueItemId;
  const subtitle = item.circle || item.workTitle;
  const runAction = (action: () => void) => {
    action();
    setOptionsOpen(false);
  };

  return (
    <div
      ref={(element) => {
        if (queueItemId) registerRow(queueItemId, element);
      }}
      role="listitem"
      data-queue-row
      data-dragging={dragging || undefined}
      className={cn(
        "player-queue-row group relative flex min-h-[3.75rem] items-center gap-1 rounded-2xl pl-2 pr-1 transition-[background-color,box-shadow,scale] duration-150",
        active && !dragging && "bg-foreground/[0.06]",
        dragging && "z-10 bg-popover shadow-xl ring-1 ring-border [scale:1.02] motion-reduce:[scale:1]",
      )}
    >
      <button
        type="button"
        className="flex min-h-[3.25rem] min-w-0 flex-1 items-center gap-3 rounded-xl py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onSelect(index)}
        aria-current={active ? "true" : undefined}
      >
        <span className="relative shrink-0">
          <CoverImage track={item} className="h-10 w-[3.25rem] rounded-lg" lazy />
          {active && (
            <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/40 text-white">
              <NowPlayingBars playing={playing} />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <OverflowMarquee
            text={item.title}
            interactionOnly={!active}
            className={cn("text-sm leading-snug", active ? "font-semibold text-primary" : "font-medium")}
          />
          {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
        </span>
      </button>
      <button
        ref={optionsRef}
        type="button"
        className="touch-target relative grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/10"
        onClick={() => setOptionsOpen((value) => !value)}
        aria-label={t("player.optionsFor", { title: item.title })}
        aria-haspopup="menu"
        aria-expanded={optionsOpen}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {queueItemId && (
        <button
          ref={(element) => registerHandle(queueItemId, element)}
          type="button"
          className="touch-target relative grid h-9 w-9 shrink-0 cursor-grab touch-none place-items-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          aria-label={t("player.reorderItem", { title: item.title })}
          title={t("player.reorderHint")}
          onPointerDown={(event) => onDragStart(queueItemId, event)}
          onPointerMove={onDragMove}
          onPointerUp={(event) => onDragEnd(event, true)}
          onPointerCancel={(event) => onDragEnd(event, false)}
          onLostPointerCapture={(event) => onDragEnd(event, false)}
          onKeyDown={(event) => {
            const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
            if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            if ((direction < 0 && first) || (direction > 0 && last)) return;
            onKeyboardMove(queueItemId, index, direction);
          }}
        >
          <Menu className="h-4 w-4" />
        </button>
      )}
      <AnchoredPopover
        open={optionsOpen}
        anchorRef={optionsRef}
        onOpenChange={setOptionsOpen}
        zIndex={70}
        className="w-48 rounded-2xl p-1.5 text-sm"
      >
        <div role="menu" aria-label={t("player.queueOptionsFor", { title: item.title })}>
          <button
            role="menuitem"
            className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 hover:bg-muted disabled:opacity-40"
            disabled={first || !queueItemId}
            onClick={() => queueItemId && runAction(() => onMove(queueItemId, -1))}
          >
            <ArrowUp className="h-4 w-4" /> {t("player.moveUp")}
          </button>
          <button
            role="menuitem"
            className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 hover:bg-muted disabled:opacity-40"
            disabled={last || !queueItemId}
            onClick={() => queueItemId && runAction(() => onMove(queueItemId, 1))}
          >
            <ArrowDown className="h-4 w-4" /> {t("player.moveDown")}
          </button>
          <button
            role="menuitem"
            className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-destructive hover:bg-muted disabled:opacity-40"
            disabled={!queueItemId}
            onClick={() => queueItemId && runAction(() => onRemove(queueItemId))}
          >
            <Trash2 className="h-4 w-4" /> {t("player.remove")}
          </button>
        </div>
      </AnchoredPopover>
    </div>
  );
});
