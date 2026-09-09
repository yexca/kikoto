import { Check, Columns3, ListMusic, Search, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { WorkCollectionColumnSetting } from "@/components/work-collection/WorkCollectionLayout";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { useTranslation } from "react-i18next";

export type VoiceWorkFilter = "all" | "available" | "local" | "remote" | "missing";

export function VoiceWorkOptionsSheet({
  open,
  onClose,
  filter,
  onFilterChange,
  query,
  onQueryChange,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  mobileColumns,
  onMobileColumnsChange,
  selectionMode,
  onSelectWorks,
}: {
  open: boolean;
  onClose: () => void;
  filter: VoiceWorkFilter;
  onFilterChange: (value: VoiceWorkFilter) => void;
  query: string;
  onQueryChange: (value: string) => void;
  pageSize: number;
  pageSizeOptions: readonly number[];
  onPageSizeChange: (value: number) => void;
  mobileColumns: WorkCollectionColumnSetting;
  onMobileColumnsChange: (value: WorkCollectionColumnSetting) => void;
  selectionMode: boolean;
  onSelectWorks: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeWithEscape);
    return () => document.removeEventListener("keydown", closeWithEscape);
  }, [onClose, open]);

  if (!open) return null;

  const filterOptions: { value: VoiceWorkFilter; label: string }[] = [
    { value: "all", label: t("detailActions.allWorks") },
    { value: "available", label: t("content.available") },
    { value: "local", label: t("detailActions.local") },
    { value: "remote", label: t("detailActions.remote") },
    { value: "missing", label: t("detailActions.missing") },
  ];
  const columnOptions: { value: WorkCollectionColumnSetting; label: string; ariaLabel: string }[] = [
    { value: "auto", label: t("collection.auto"), ariaLabel: t("collection.automaticColumns") },
    { value: 1, label: "1", ariaLabel: t("collection.column", { count: 1 }) },
    { value: 2, label: "2", ariaLabel: t("collection.column", { count: 2 }) },
  ];

  return (
    <div
      className="visual-viewport-layer z-50 flex items-end bg-background/55 p-2 backdrop-blur-sm lg:hidden sm:p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-work-options-title"
        data-android-back-close
        className="app-scroll min-h-0 max-h-full w-full overflow-y-auto rounded-t-lg border bg-card p-4 shadow-xl"
        style={{ paddingBottom: "max(1rem, calc(1rem + var(--safe-area-bottom)))" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="voice-work-options-title" className="text-base font-semibold">
              {t("sheets.voiceWorkOptions")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("sheets.catalogOptionsDescription")}</p>
          </div>
          <Button variant="ghost" size="icon" aria-label={t("sheets.closeCatalogOptions")} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <fieldset className="mt-4 space-y-2">
          <legend className="text-sm font-medium">{t("sheets.search")}</legend>
          <div className="flex min-h-11 items-center gap-2 rounded-md border bg-background px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              value={query}
              onKeyDown={dismissKeyboardOnEnter}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t("sheets.searchVoiceWorks", { defaultValue: "Search voice works" })}
              aria-label={t("sheets.searchVoiceWorks", { defaultValue: "Search voice works" })}
            />
            {query.trim() && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label={t("sheets.clearVoiceWorkSearch", { defaultValue: "Clear voice work search" })}
                title={t("sheets.clearVoiceWorkSearch", { defaultValue: "Clear voice work search" })}
                onClick={() => onQueryChange("")}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </fieldset>

        <fieldset className="mt-4 space-y-2">
          <legend className="text-sm font-medium">{t("sheets.availability")}</legend>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label={t("sheets.voiceWorkAvailability")}>
            {filterOptions.map((option) => (
              <OptionButton
                key={option.value}
                active={filter === option.value}
                label={option.label}
                onClick={() => onFilterChange(option.value)}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-4 space-y-2">
          <legend className="text-sm font-medium">{t("sheets.columns")}</legend>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label={t("sheets.mobileVoiceWorkColumns")}>
            {columnOptions.map((option) => (
              <OptionButton
                key={String(option.value)}
                active={mobileColumns === option.value}
                label={option.label}
                ariaLabel={option.ariaLabel}
                icon={<Columns3 className="h-4 w-4" />}
                onClick={() => onMobileColumnsChange(option.value)}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-4 space-y-2">
          <legend className="flex items-center gap-2 text-sm font-medium">
            <ListMusic className="h-4 w-4" aria-hidden="true" />
            {t("sheets.perPage")}
          </legend>
          <div
            className="grid grid-cols-2 gap-2"
            role="group"
            aria-label={t("sheets.voiceWorkPageSize", { defaultValue: "Voice work page size" })}
          >
            {pageSizeOptions.map((option) => (
              <OptionButton
                key={option}
                active={pageSize === option}
                label={t("sheets.perPageOption", { value: option })}
                onClick={() => onPageSizeChange(option)}
              />
            ))}
          </div>
        </fieldset>

        <Button className="mt-4 w-full" variant={selectionMode ? "default" : "outline"} onClick={onSelectWorks}>
          <Check className="h-4 w-4" />
          {selectionMode ? t("sheets.exitSelectionMode") : t("sheets.selectWorks")}
        </Button>
      </div>
    </div>
  );
}

function OptionButton({
  active,
  label,
  ariaLabel,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  ariaLabel?: string;
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 text-sm transition-colors hover:bg-muted ${
        active ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground"
      }`}
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {active && <Check className="h-4 w-4 shrink-0" />}
    </button>
  );
}
