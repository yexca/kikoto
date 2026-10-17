import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  pageJumpTarget,
  paginationItems,
  paginationSiblingsForWidth,
} from "@/components/work-collection/paginationModel";
import i18n from "@/i18n";
import { cn } from "@/lib/tailwindClassNames";

export type CollectionPaginationProps = {
  placement: "top" | "bottom";
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  itemLabel: string;
  ariaLabel?: string;
  summary?: ReactNode;
  pageSizeOptions?: readonly number[];
  pageSizeControlClassName?: string;
  leadingControls?: ReactNode;
  compactMobile?: boolean;
  compactTop?: boolean;
  refreshing?: boolean;
  refreshingLabel?: string;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
};

export function CollectionPagination({
  placement,
  page,
  pageSize,
  totalItems,
  totalPages,
  itemLabel,
  ariaLabel = "Pages",
  summary,
  pageSizeOptions,
  pageSizeControlClassName,
  leadingControls,
  compactMobile = false,
  compactTop = false,
  refreshing,
  refreshingLabel,
  onPageChange,
  onPageSizeChange,
}: CollectionPaginationProps) {
  const { t } = useTranslation("translation", { i18n });
  const lastPage = Math.max(1, totalPages);
  const currentPage = Math.min(lastPage, Math.max(1, page));
  const barRef = useRef<HTMLElement>(null);
  const siblings = usePageBarSiblings(barRef, placement === "bottom" && lastPage > 1);

  if (placement === "bottom") {
    if (lastPage <= 1) return null;
    return (
      <nav ref={barRef} className="flex justify-center" aria-label={ariaLabel}>
        <div className="inline-flex min-h-10 max-w-full items-center gap-1 overflow-x-auto overflow-y-hidden rounded-lg border bg-card px-2 py-1.5 text-sm">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            disabled={currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
            aria-label={t("collection.previousPage")}
            title={t("collection.previousPage")}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {paginationItems(currentPage, lastPage, siblings).map((item) =>
            item === "ellipsis-left" || item === "ellipsis-right" ? (
              <PageJump key={item} currentPage={currentPage} lastPage={lastPage} onPageChange={onPageChange} />
            ) : (
              <Button
                key={item}
                variant={item === currentPage ? "default" : "ghost"}
                size="icon"
                className="h-8 w-8 shrink-0 text-xs tabular-nums"
                onClick={() => onPageChange(item)}
                aria-label={t("collection.page", { page: item })}
                aria-current={item === currentPage ? "page" : undefined}
              >
                {item}
              </Button>
            ),
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            disabled={currentPage >= lastPage}
            onClick={() => onPageChange(currentPage + 1)}
            aria-label={t("collection.nextPage")}
            title={t("collection.nextPage")}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </nav>
    );
  }

  const firstItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const lastItem = Math.min(totalItems, currentPage * pageSize);
  const summaryContent =
    summary ?? t("collection.rangeOf", { first: firstItem, last: lastItem, totalItems, itemLabel });
  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-sm lg:rounded-none lg:border-x-0 lg:border-t-0 lg:bg-transparent",
        compactMobile
          ? compactTop
            ? "flex min-h-10 flex-nowrap items-center justify-between gap-2 px-2 py-1 lg:px-0.5 lg:pb-2"
            : "flex min-h-[3.75rem] flex-nowrap items-center justify-between gap-2 px-2 py-2 lg:min-h-0 lg:px-0.5 lg:pb-2"
          : "flex flex-col gap-2 px-3 py-2 lg:flex-row lg:items-center lg:justify-between lg:px-0.5 lg:pb-2",
      )}
    >
      <div
        className={cn(
          "text-xs text-muted-foreground",
          compactMobile ? "min-w-0 flex-1 lg:flex-none lg:shrink-0" : "shrink-0",
        )}
      >
        {compactMobile ? (
          <>
            <div className="flex min-w-0 items-center gap-1.5 lg:hidden">
              <CollectionRefreshStatus
                refreshing={refreshing}
                label={refreshingLabel ?? t("collection.refreshing", { itemLabel })}
              />
              <span className="min-w-0 truncate">
                <span className="sr-only">
                  {t("collection.pageOf", { page: currentPage, totalPages: lastPage, totalItems, itemLabel })}
                </span>
                <span aria-hidden="true">
                  <span className="hidden min-[360px]:inline">{t("collection.page", { page: currentPage })} · </span>
                  {totalItems} {itemLabel}
                </span>
              </span>
            </div>
            <div className="hidden items-center gap-1.5 lg:flex">
              <CollectionRefreshStatus
                refreshing={refreshing}
                label={refreshingLabel ?? t("collection.refreshing", { itemLabel })}
              />
              <span>{summaryContent}</span>
            </div>
          </>
        ) : (
          summaryContent
        )}
      </div>
      <div
        className={cn(
          "flex items-center gap-2",
          compactMobile
            ? "shrink-0 flex-nowrap lg:min-w-0 lg:shrink lg:flex-wrap lg:justify-end"
            : "min-w-0 flex-wrap lg:justify-end",
        )}
      >
        {leadingControls}
        {pageSizeOptions && onPageSizeChange && (
          <select
            className={cn(
              "h-8 rounded-md border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring",
              pageSizeControlClassName,
            )}
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            aria-label={t("collection.perPageLabel", { itemLabel })}
          >
            {pageSizeOptions.map((value) => (
              <option key={value} value={value}>
                {t("collection.pageOption", { value })}
              </option>
            ))}
          </select>
        )}
        {compactMobile && (
          <div
            className={cn(
              "inline-flex shrink-0 items-center rounded-md border bg-background lg:hidden",
              compactTop ? "h-8" : "h-11",
            )}
            role="group"
            aria-label={t("collection.controls", { label: ariaLabel })}
          >
            <Button
              variant="ghost"
              size="icon"
              className={cn("rounded-r-none", compactTop ? "h-8 w-8" : "h-11 w-11")}
              disabled={currentPage <= 1}
              onClick={() => onPageChange(currentPage - 1)}
              aria-label={t("collection.previousPage")}
              title={t("collection.previousPage")}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn("rounded-l-none border-l", compactTop ? "h-8 w-8" : "h-11 w-11")}
              disabled={currentPage >= lastPage}
              onClick={() => onPageChange(currentPage + 1)}
              aria-label={t("collection.nextPage")}
              title={t("collection.nextPage")}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
        <div
          className={cn(
            "h-8 shrink-0 items-center rounded-md border bg-background",
            compactMobile ? "hidden lg:inline-flex" : "inline-flex",
          )}
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-8 rounded-r-none"
            disabled={currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
            aria-label={t("collection.previousPage")}
            title={t("collection.previousPage")}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="inline-flex h-7 min-w-14 items-center justify-center border-x px-2 text-xs tabular-nums text-muted-foreground">
            {currentPage} / {lastPage}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-8 rounded-l-none"
            disabled={currentPage >= lastPage}
            onClick={() => onPageChange(currentPage + 1)}
            aria-label={t("collection.nextPage")}
            title={t("collection.nextPage")}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Pages shown on each side of the current one, from the width the page bar may take. */
function usePageBarSiblings(barRef: RefObject<HTMLElement | null>, enabled: boolean) {
  const [siblings, setSiblings] = useState(1);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!enabled || !bar) return;
    const measure = () => setSiblings(paginationSiblingsForWidth(bar.clientWidth));
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [barRef, enabled]);
  return siblings;
}

/** An ellipsis between page numbers that turns into a page number field where it was pressed. */
function PageJump({
  currentPage,
  lastPage,
  onPageChange,
}: {
  currentPage: number;
  lastPage: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation("translation", { i18n });
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  // Leaving the field by keyboard returns focus to the ellipsis; a blur leaves focus where the user put it.
  const closeToTrigger = () => {
    restoreFocus.current = true;
    setOpen(false);
  };

  if (!open) {
    return (
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        className="h-8 w-6 shrink-0 text-muted-foreground"
        onClick={() => {
          setValue(String(currentPage));
          setOpen(true);
        }}
        aria-label={t("collection.jumpToPage")}
        title={t("collection.jumpToPage")}
      >
        ...
      </Button>
    );
  }

  return (
    <form
      className="inline-flex shrink-0"
      onSubmit={(event) => {
        event.preventDefault();
        const target = pageJumpTarget(value, lastPage);
        closeToTrigger();
        if (target !== null && target !== currentPage) onPageChange(target);
      }}
    >
      <Input
        ref={inputRef}
        className="h-8 w-12 px-1 text-center text-xs tabular-nums"
        value={value}
        onChange={(event) => setValue(event.target.value.replace(/\D/g, ""))}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          closeToTrigger();
        }}
        inputMode="numeric"
        enterKeyHint="go"
        autoComplete="off"
        aria-label={t("collection.jumpToPage")}
      />
    </form>
  );
}

function CollectionRefreshStatus({ refreshing, label }: { refreshing?: boolean; label: string }) {
  if (refreshing === undefined) return null;
  return (
    <span className="grid h-4 w-4 shrink-0 place-items-center" aria-live="polite">
      {refreshing && (
        <span role="status" aria-label={label}>
          <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        </span>
      )}
    </span>
  );
}
