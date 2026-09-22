import { ChevronLeft, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";

/**
 * Submit-on-enter search used by the Metadata record tables: a leading search
 * button, an optional clear action, and a quiet refresh control.
 */
export function MaintenanceSearchForm({
  value,
  label,
  placeholder,
  loading,
  onChange,
  onSubmit,
  onClear,
  onRefresh,
}: {
  value: string;
  label: string;
  placeholder: string;
  loading: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form className="flex min-w-0 items-center gap-1 sm:w-80" onSubmit={submit}>
      <div className="relative min-w-0 flex-1">
        <button
          type="submit"
          className="absolute left-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground max-sm:h-11 max-sm:w-11"
          aria-label={t("unlinked.search")}
          title={t("unlinked.search")}
        >
          <Search className="h-4 w-4" />
        </button>
        <Input
          type="search"
          maxLength={256}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={label}
          fieldSize="sm"
          className="w-full pl-9 pr-9 max-sm:h-11 max-sm:pl-12 [&::-webkit-search-cancel-button]:hidden"
        />
        {value && (
          <button
            type="button"
            className="absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground max-sm:h-9 max-sm:w-9"
            onClick={onClear}
            aria-label={t("unlinked.clearSearch")}
            title={t("unlinked.clearSearch")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="shrink-0 text-muted-foreground max-sm:h-11 max-sm:w-11"
        onClick={onRefresh}
        disabled={loading}
        aria-label={t("unlinked.refresh")}
        title={t("unlinked.refresh")}
      >
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
      </Button>
    </form>
  );
}

/** Footer pager shared by the Metadata record tables: rows per page plus previous/next. */
export function MaintenancePager({
  page,
  totalPages,
  pageSize,
  pageSizeOptions,
  loading,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  pageSize: number;
  pageSizeOptions: readonly number[];
  loading: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
      <label className="flex items-center gap-2">
        {t("workMaintenance.rows")}
        <NativeSelect
          fieldSize="sm"
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
          className="h-8 px-2 text-xs"
        >
          {pageSizeOptions.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </NativeSelect>
      </label>
      <div className="flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          className="max-sm:h-11 max-sm:w-11"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1 || loading}
          aria-label={t("collection.previousPage")}
          title={t("collection.previousPage")}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-12 text-center tabular-nums">
          {t("workMaintenance.pageStatus", { page: Math.min(page, totalPages), total: totalPages })}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          className="max-sm:h-11 max-sm:w-11"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages || loading}
          aria-label={t("collection.nextPage")}
          title={t("collection.nextPage")}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
