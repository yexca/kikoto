import { type CSSProperties, type KeyboardEvent, type MouseEvent, useEffect, useRef } from "react";
import { FileText, Folder, FolderOpen, Languages, PenLine, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import {
  type DisplayNameDrafts,
  type DisplayNameGroup,
  type DisplayNameRow,
  displayNameChanged,
  displayNameInvalid,
  displayNameValue,
  parentFolderPath,
} from "@/features/work-detail/dialogs/fileDisplayNamesModel";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { cn } from "@/lib/tailwindClassNames";

/** Marks the name fields of the list, which Enter steps through. */
export const displayNameFieldAttribute = "data-display-name-field";

/** The language strip: each metadata language with how many rows it names, and a mark while it has unsaved names. */
export function DisplayNameLanguageTabs({
  selected,
  counts,
  total,
  pending,
  onSelect,
}: {
  selected: string;
  counts: ReadonlyMap<string, number>;
  total: number;
  /** Languages with unsaved changes. */
  pending: ReadonlySet<string>;
  onSelect: (language: string) => void;
}) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);
  // A narrow strip scrolls the selected language into view, keeping the page where it is.
  useEffect(() => {
    const strip = stripRef.current;
    const button = strip?.querySelector<HTMLElement>("[aria-pressed=true]");
    if (!strip || !button) return;
    const start = button.offsetLeft - strip.offsetLeft;
    if (start < strip.scrollLeft || start + button.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = start - (strip.clientWidth - button.offsetWidth) / 2;
    }
  }, [selected]);
  return (
    <div className="flex min-w-0 max-w-full items-center gap-2">
      <Languages className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
      <div
        ref={stripRef}
        role="group"
        aria-label={t("fileDisplayNames.language")}
        className={segmentedListClassName("![scrollbar-width:none] [&::-webkit-scrollbar]:hidden")}
      >
        {metadataTagNameLanguages.map(([language, labelKey]) => {
          const active = language === selected;
          const count = counts.get(language) ?? 0;
          const changed = pending.has(language);
          return (
            <button
              key={language}
              type="button"
              aria-pressed={active}
              title={t("fileDisplayNames.coverage", { count, total })}
              className={segmentedItemClassName(active, "relative h-9 gap-1.5 sm:h-8")}
              onClick={() => onSelect(language)}
            >
              {t(labelKey)}
              {count > 0 && (
                <span
                  className={cn(
                    "min-w-[1.125rem] rounded-full px-1 text-center text-2xs tabular-nums",
                    active ? "bg-primary/10 text-primary" : "bg-background/70 text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              )}
              {changed && (
                <>
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-info" aria-hidden="true" />
                  <span className="sr-only">{t("fileDisplayNames.changed")}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A display name field that shows the file's own extension inside its end, since every name keeps it. */
function DisplayNameField({
  row,
  value,
  label,
  list = false,
  onChange,
  onFocus,
  onKeyDown,
}: {
  row: DisplayNameRow;
  value: string;
  label: string;
  /** A field of the list, which Enter steps through. */
  list?: boolean;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <span className="relative block min-w-0">
      <Input
        fieldSize="sm"
        className="w-full"
        style={row.extension ? { paddingRight: `calc(${[...row.extension].length}ch + 1rem)` } : undefined}
        value={value}
        placeholder={row.baseName}
        maxLength={255}
        enterKeyHint={list ? "next" : undefined}
        aria-label={label}
        aria-invalid={displayNameInvalid(value)}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        {...(list ? { [displayNameFieldAttribute]: "" } : {})}
      />
      {row.extension && (
        <span
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground"
          aria-hidden="true"
        >
          {row.extension}
        </span>
      )}
    </span>
  );
}

/** The mark of a stored name an LLM wrote, kept until someone edits or clears it. */
function LlmNameBadge() {
  const { t } = useTranslation();
  return (
    <Badge variant="info" className="shrink-0 px-1.5 py-0 text-2xs" title={t("fileDisplayNames.llmName")}>
      {t("workTitles.llmBadge")}
    </Badge>
  );
}

type RowProps = {
  row: DisplayNameRow;
  drafts: DisplayNameDrafts;
  language: string;
  /** The row the panel beside the list shows; null without a panel. */
  selected: boolean | null;
  onSelect: () => void;
  onChange: (value: string) => void;
  onRevert: () => void;
  onFieldKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
};

/** A row's real name, its field in the selected language, and its mark or undo. */
function DisplayNameRowContent({ row, drafts, language, onSelect, onChange, onRevert, onFieldKeyDown }: RowProps) {
  const { t } = useTranslation();
  const value = displayNameValue(row, drafts, language);
  const changed = displayNameChanged(row, drafts, language);
  const llm = !changed && value !== "" && row.llmLanguages.includes(language);
  const realName = row.baseName + row.extension;
  const parent = row.kind === "folder" ? parentFolderPath(row.path) : "";
  const Icon = row.kind === "folder" ? Folder : FileText;
  return (
    <div className="grid grid-cols-[1rem_minmax(0,1fr)_2.5rem] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[1rem_minmax(0,1fr)_minmax(0,1.2fr)_2.5rem]">
      <Icon
        className={cn("h-4 w-4", row.kind === "folder" ? "text-primary" : "text-muted-foreground")}
        aria-hidden="true"
      />
      <span className="min-w-0" title={row.path}>
        <span className={cn("block truncate text-sm", row.kind === "folder" && "font-medium")}>
          {row.baseName}
          {row.extension && <span className="text-muted-foreground">{row.extension}</span>}
        </span>
        {parent && <span className="block truncate text-2xs text-muted-foreground">{parent}</span>}
      </span>
      <span className="col-span-2 col-start-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-auto sm:row-start-auto">
        <DisplayNameField
          row={row}
          value={value}
          label={t("fileDisplayNames.nameFor", { name: realName })}
          list
          onChange={onChange}
          onFocus={onSelect}
          onKeyDown={onFieldKeyDown}
        />
      </span>
      <span className="col-start-3 row-start-1 flex justify-end sm:col-start-auto sm:row-start-auto">
        {changed ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t("fileDisplayNames.revert", { name: realName })}
            title={t("fileDisplayNames.revert", { name: realName })}
            onClick={(event) => {
              event.preventDefault();
              onRevert();
            }}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        ) : (
          llm && <LlmNameBadge />
        )}
      </span>
    </div>
  );
}

function rowStateClassName(changed: boolean, selected: boolean | null) {
  return selected
    ? "bg-primary/[0.06]"
    : changed
      ? "bg-info-surface/40"
      : selected === false
        ? "hover:bg-muted/40"
        : undefined;
}

function RowBand({ changed, selected }: { changed: boolean; selected: boolean | null }) {
  if (!changed && !selected) return null;
  return (
    <span className={cn("absolute inset-y-0 left-0 w-0.5", changed ? "bg-info" : "bg-primary")} aria-hidden="true" />
  );
}

/** Beside the panel, clicking a row shows it there; its own field and buttons still work. */
function selectOnClick(props: RowProps) {
  return props.selected === false
    ? (event: MouseEvent) => (event.defaultPrevented ? undefined : props.onSelect())
    : undefined;
}

/**
 * A folder with the files directly in it. The folder's own name sits in the
 * sticky head; the work folder, and a folder without a name of its own, only
 * label the group.
 */
export function DisplayNameGroupSection({
  group,
  files,
  rowProps,
}: {
  group: DisplayNameGroup;
  /** The group's files the filter leaves. */
  files: DisplayNameRow[];
  rowProps: (row: DisplayNameRow) => RowProps;
}) {
  const { t } = useTranslation();
  const depth = group.path ? group.path.split("/").length - 1 : 0;
  const name = group.path ? group.path.slice(group.path.lastIndexOf("/") + 1) : t("fileDisplayNames.rootFolder");
  const head = group.folder ? rowProps(group.folder) : null;
  const headChanged = head ? displayNameChanged(head.row, head.drafts, head.language) : false;
  return (
    <section
      aria-label={group.path || name}
      className="rounded-lg border bg-card sm:ms-[var(--display-name-indent)]"
      style={{ "--display-name-indent": `${Math.min(depth, 4) * 1.25}rem` } as CSSProperties}
    >
      {head ? (
        // The head stays opaque while it sticks; its state tint sits inside it. A phone's
        // two-line head scrolls with the list.
        <div
          className={cn(
            "relative z-10 rounded-t-lg border-b bg-card sm:sticky sm:-top-4",
            files.length === 0 && "rounded-b-lg border-b-0",
          )}
          onClick={selectOnClick(head)}
        >
          <div
            className={cn(
              "relative rounded-[inherit] px-3 py-2 transition-colors sm:px-4",
              rowStateClassName(headChanged, head.selected),
            )}
          >
            <RowBand changed={headChanged} selected={head.selected} />
            <DisplayNameRowContent {...head} />
          </div>
        </div>
      ) : (
        <h4
          className={cn(
            "sticky -top-4 z-10 flex items-center gap-3 rounded-t-lg border-b bg-card px-3 py-2.5 text-xs font-medium text-muted-foreground sm:px-4",
            files.length === 0 && "rounded-b-lg border-b-0",
          )}
          title={group.path || undefined}
        >
          {group.path ? (
            <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <FolderOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 truncate text-foreground">{name}</span>
        </h4>
      )}
      {files.length > 0 && (
        <ul className="divide-y">
          {files.map((file) => {
            const props = rowProps(file);
            const changed = displayNameChanged(file, props.drafts, props.language);
            return (
              <li
                key={file.key}
                className={cn(
                  "relative px-3 py-2 transition-colors last:rounded-b-lg sm:px-4",
                  rowStateClassName(changed, props.selected),
                )}
                onClick={selectOnClick(props)}
              >
                <RowBand changed={changed} selected={props.selected} />
                <DisplayNameRowContent {...props} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The selected row beside the list on wide screens, with its name in every
 * metadata language. A language's label switches the list to it.
 */
export function DisplayNamePanel({
  row,
  drafts,
  language,
  onLanguage,
  onChange,
}: {
  row: DisplayNameRow | null;
  drafts: Record<string, DisplayNameDrafts>;
  language: string;
  onLanguage: (language: string) => void;
  onChange: (language: string, value: string) => void;
}) {
  const { t } = useTranslation();
  const Icon = row?.kind === "folder" ? Folder : FileText;
  const parent = row ? parentFolderPath(row.path) : "";
  return (
    <aside
      aria-label={t("fileDisplayNames.panel")}
      className="app-scrollbar flex w-[22rem] shrink-0 flex-col overflow-y-auto overscroll-contain border-l bg-muted/25 xl:w-[26rem]"
    >
      {row ? (
        <>
          <div className="shrink-0 border-b px-5 py-4">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {row.kind === "folder" ? t("fileDisplayNames.folder") : t("fileDisplayNames.file")}
            </p>
            <h3 className="mt-1 flex min-w-0 items-start gap-2 text-sm font-semibold">
              <Icon
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  row.kind === "folder" ? "text-primary" : "text-muted-foreground",
                )}
                aria-hidden="true"
              />
              <span className="min-w-0 break-words">
                {row.baseName}
                {row.extension && <span className="font-normal text-muted-foreground">{row.extension}</span>}
              </span>
            </h3>
            <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate" title={parent || undefined}>
                {parent || t("fileDisplayNames.rootFolder")}
              </span>
            </p>
          </div>
          <div className="space-y-1 px-3 py-3">
            <p className="px-2 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("fileDisplayNames.everyLanguage")}
            </p>
            <ul className="space-y-1">
              {metadataTagNameLanguages.map(([candidate, labelKey]) => {
                const languageDrafts = drafts[candidate] ?? {};
                const value = displayNameValue(row, languageDrafts, candidate);
                const changed = displayNameChanged(row, languageDrafts, candidate);
                const llm = !changed && value !== "" && row.llmLanguages.includes(candidate);
                const active = candidate === language;
                const languageLabel = t(labelKey);
                return (
                  <li
                    key={candidate}
                    className={cn(
                      "relative space-y-1.5 rounded-md px-2 py-2 transition-colors",
                      active ? "bg-card shadow-sm ring-1 ring-foreground/5" : "hover:bg-card/60",
                    )}
                  >
                    {changed && (
                      <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-info" aria-hidden="true" />
                    )}
                    <div className="flex min-h-5 items-center justify-between gap-2">
                      <button
                        type="button"
                        aria-pressed={active}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-sm text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active ? "text-primary" : "text-muted-foreground hover:text-foreground",
                        )}
                        aria-label={t("fileDisplayNames.showLanguage", { language: languageLabel })}
                        title={t("fileDisplayNames.showLanguage", { language: languageLabel })}
                        onClick={() => onLanguage(candidate)}
                      >
                        {active && <PenLine className="h-3 w-3" aria-hidden="true" />}
                        {languageLabel}
                      </button>
                      {changed ? (
                        <Badge variant="info" className="px-1.5 py-0 text-2xs">
                          {t("fileDisplayNames.changed")}
                        </Badge>
                      ) : (
                        llm && <LlmNameBadge />
                      )}
                    </div>
                    <DisplayNameField
                      row={row}
                      value={value}
                      label={t("fileDisplayNames.nameIn", {
                        name: row.baseName + row.extension,
                        language: languageLabel,
                      })}
                      onChange={(next) => onChange(candidate, next)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      ) : (
        <p className="m-5 rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
          {t("fileDisplayNames.panelEmpty")}
        </p>
      )}
    </aside>
  );
}

export type { RowProps as DisplayNameRowProps };
