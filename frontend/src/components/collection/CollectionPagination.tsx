import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { paginationItems } from "@/components/work-collection/paginationModel";
import { cn } from "@/lib/utils";

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
  const lastPage = Math.max(1, totalPages);
  const currentPage = Math.min(lastPage, Math.max(1, page));

  if (placement === "bottom") {
    if (lastPage <= 1) return null;
    return (
      <nav className="flex justify-center" aria-label={ariaLabel}>
        <div className="inline-flex min-h-10 max-w-full items-center gap-1 overflow-x-auto rounded-lg border bg-card px-2 py-1.5 text-sm">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            disabled={currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
            aria-label="Previous page"
            title="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {paginationItems(currentPage, lastPage).map((item) =>
            item === "ellipsis-left" || item === "ellipsis-right" ? (
              <span
                key={item}
                className="inline-flex h-8 w-6 shrink-0 items-center justify-center text-muted-foreground"
                aria-hidden
              >
                ...
              </span>
            ) : (
              <Button
                key={item}
                variant={item === currentPage ? "default" : "ghost"}
                size="icon"
                className="h-8 w-8 shrink-0 text-xs tabular-nums"
                onClick={() => onPageChange(item)}
                aria-label={`Page ${item}`}
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
            aria-label="Next page"
            title="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </nav>
    );
  }

  const firstItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const lastItem = Math.min(totalItems, currentPage * pageSize);
  const summaryContent = summary ?? (
    <>
      {firstItem}-{lastItem} of {totalItems} {itemLabel}
    </>
  );
  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-sm",
        compactMobile
          ? compactTop
            ? "flex min-h-10 flex-nowrap items-center justify-between gap-2 px-2 py-1 lg:px-3"
            : "flex min-h-[3.75rem] flex-nowrap items-center justify-between gap-2 px-2 py-2 lg:min-h-0 lg:px-3"
          : "flex flex-col gap-2 px-3 py-2 lg:flex-row lg:items-center lg:justify-between",
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
              <CollectionRefreshStatus refreshing={refreshing} label={refreshingLabel ?? `Refreshing ${itemLabel}`} />
              <span className="min-w-0 truncate">
                <span className="sr-only">
                  Page {currentPage} of {lastPage}, {totalItems} {itemLabel}
                </span>
                <span aria-hidden="true">
                  <span className="hidden min-[360px]:inline">Page {currentPage} · </span>
                  {totalItems} {itemLabel}
                </span>
              </span>
            </div>
            <div className="hidden items-center gap-1.5 lg:flex">
              <CollectionRefreshStatus refreshing={refreshing} label={refreshingLabel ?? `Refreshing ${itemLabel}`} />
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
            aria-label={`${itemLabel} per page`}
          >
            {pageSizeOptions.map((value) => (
              <option key={value} value={value}>
                {value} / page
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
            aria-label={`${ariaLabel} controls`}
          >
            <Button
              variant="ghost"
              size="icon"
              className={cn("rounded-r-none", compactTop ? "h-8 w-8" : "h-11 w-11")}
              disabled={currentPage <= 1}
              onClick={() => onPageChange(currentPage - 1)}
              aria-label="Previous page"
              title="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn("rounded-l-none border-l", compactTop ? "h-8 w-8" : "h-11 w-11")}
              disabled={currentPage >= lastPage}
              onClick={() => onPageChange(currentPage + 1)}
              aria-label="Next page"
              title="Next page"
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
            aria-label="Previous page"
            title="Previous page"
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
            aria-label="Next page"
            title="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
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
