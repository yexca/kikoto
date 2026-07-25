import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { paginationItems } from "./paginationModel";

export function WorkCollectionPagination({
  placement,
  page,
  pageSize,
  totalItems,
  totalPages,
  pageSizeOptions,
  leadingControls,
  onPageChange,
  onPageSizeChange,
}: {
  placement: "top" | "bottom";
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  pageSizeOptions?: readonly number[];
  leadingControls?: ReactNode;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}) {
  const lastPage = Math.max(1, totalPages);
  const currentPage = Math.min(lastPage, Math.max(1, page));

  if (placement === "bottom") {
    if (lastPage <= 1) return null;
    return (
      <nav className="flex justify-center" aria-label="Work pages">
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
          {paginationItems(currentPage, lastPage).map((item) => item === "ellipsis-left" || item === "ellipsis-right" ? (
            <span key={item} className="inline-flex h-8 w-6 shrink-0 items-center justify-center text-muted-foreground" aria-hidden>
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
          ))}
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

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-2 text-sm lg:flex-row lg:items-center lg:justify-between">
      <div className="shrink-0 text-xs text-muted-foreground">
        Page {currentPage} / {lastPage} · {totalItems} works
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
        {leadingControls}
        {pageSizeOptions && onPageSizeChange && (
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            aria-label="Works per page"
          >
            {pageSizeOptions.map((value) => (
              <option key={value} value={value}>
                {value} / page
              </option>
            ))}
          </select>
        )}
        <div className="inline-flex h-8 shrink-0 items-center rounded-md border bg-background">
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
