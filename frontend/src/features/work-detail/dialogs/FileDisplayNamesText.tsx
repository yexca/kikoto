import { useId, useState } from "react";
import { ClipboardCopy, FileText, Folder, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  type DisplayNameDrafts,
  type DisplayNameRow,
  displayNameChanged,
  displayNameInvalid,
  displayNameValue,
  textLines,
} from "@/features/work-detail/dialogs/fileDisplayNamesModel";
import { cn } from "@/lib/tailwindClassNames";

/**
 * The whole list as text: each line of the field is the name of the entry
 * beside it, so a list translated elsewhere can be pasted in at once. The real
 * names run down the left, line by line, and the caret's line is marked on both
 * sides.
 */
export function DisplayNamesTextView({
  rows,
  drafts,
  language,
  languageLabel,
  text,
  onTextChange,
  onLineSelect,
  onCopyRealNames,
}: {
  rows: DisplayNameRow[];
  drafts: DisplayNameDrafts;
  language: string;
  languageLabel: string;
  text: string;
  onTextChange: (text: string) => void;
  /** The row on the caret's line, or null past the last row. */
  onLineSelect: (row: DisplayNameRow | null) => void;
  onCopyRealNames: () => void;
}) {
  const { t } = useTranslation();
  const statusId = useId();
  const [caretLine, setCaretLine] = useState<number | null>(null);
  const lineCount = textLines(text).length;
  const shownLines = Math.max(rows.length, lineCount, 1);
  const status =
    lineCount === rows.length
      ? ""
      : lineCount < rows.length
        ? t("fileDisplayNames.textFewer", { count: lineCount, total: rows.length })
        : t("fileDisplayNames.textMore", { count: lineCount, total: rows.length });

  const trackCaret = (field: HTMLTextAreaElement) => {
    const line = field.value.slice(0, field.selectionStart).split("\n").length - 1;
    if (line === caretLine) return;
    setCaretLine(line);
    onLineSelect(rows[line] ?? null);
  };

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border bg-card focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/35">
        <div className="flex items-center border-b bg-muted/40 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          <span className="flex w-[44%] shrink-0 items-center justify-between gap-2 border-r py-1 pl-3 pr-1 sm:w-[42%]">
            <span className="truncate">{t("fileDisplayNames.realName")}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-2 text-xs normal-case tracking-normal text-muted-foreground"
              aria-label={t("fileDisplayNames.copyRealNames")}
              title={t("fileDisplayNames.copyRealNames")}
              onClick={onCopyRealNames}
            >
              <ClipboardCopy className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("fileDisplayNames.copy")}</span>
            </Button>
          </span>
          <span className="min-w-0 truncate px-3 py-2.5">
            {t("fileDisplayNames.languageName", { language: languageLabel })}
          </span>
        </div>
        <div className="relative flex">
          {caretLine !== null && caretLine < shownLines && (
            <span
              className="pointer-events-none absolute inset-x-0 h-7 bg-primary/[0.06]"
              style={{ top: `calc(0.5rem + ${caretLine} * 1.75rem)` }}
              aria-hidden="true"
            />
          )}
          <ol
            aria-label={t("fileDisplayNames.realName")}
            className="relative w-[44%] shrink-0 border-r bg-muted/25 py-2 sm:w-[42%]"
          >
            {Array.from({ length: shownLines }, (_, index) => {
              const row = rows[index];
              const active = index === caretLine;
              if (!row) {
                return (
                  <li key={`extra:${index}`} className="flex h-7 items-center gap-2 pl-2 pr-3 text-xs">
                    <LineNumber index={index} active={active} />
                    <span className="truncate italic text-warning-foreground">{t("fileDisplayNames.textIgnored")}</span>
                  </li>
                );
              }
              const Icon = row.kind === "folder" ? Folder : FileText;
              const value = displayNameValue(row, drafts, language);
              const changed = displayNameChanged(row, drafts, language);
              const invalid = displayNameInvalid(value);
              return (
                <li key={row.key} className="relative flex h-7 items-center gap-2 pl-2 pr-3 text-sm" title={row.path}>
                  {(changed || invalid) && (
                    <span
                      className={cn("absolute inset-y-1 left-0 w-0.5 rounded-full", invalid ? "bg-error" : "bg-info")}
                      aria-hidden="true"
                    />
                  )}
                  <LineNumber index={index} active={active} />
                  <Icon
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      row.kind === "folder" ? "text-primary" : "text-muted-foreground",
                    )}
                    aria-hidden="true"
                  />
                  <span className={cn("min-w-0 truncate", row.kind === "folder" && "font-medium")}>
                    {row.kind === "folder" ? `${row.path}/` : row.baseName}
                    {row.extension && <span className="text-muted-foreground">{row.extension}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
          <textarea
            className="relative block min-w-0 flex-1 resize-none overflow-x-auto overflow-y-hidden whitespace-pre bg-transparent px-3 pb-5 pt-2 text-sm leading-7 text-foreground outline-none placeholder:text-muted-foreground/80"
            style={{ height: `calc(${shownLines} * 1.75rem + 1.75rem)` }}
            wrap="off"
            spellCheck={false}
            value={text}
            aria-label={t("fileDisplayNames.textLabel", { language: languageLabel })}
            aria-describedby={status ? statusId : undefined}
            onChange={(event) => {
              onTextChange(event.target.value);
              trackCaret(event.currentTarget);
            }}
            onSelect={(event) => trackCaret(event.currentTarget)}
            onBlur={() => setCaretLine(null)}
          />
        </div>
      </div>
      {status && (
        <p id={statusId} role="status" className="flex items-center gap-1.5 text-xs text-warning-foreground">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {status}
        </p>
      )}
    </div>
  );
}

function LineNumber({ index, active }: { index: number; active: boolean }) {
  return (
    <span
      className={cn(
        "w-6 shrink-0 text-right text-2xs tabular-nums",
        active ? "font-medium text-primary" : "text-muted-foreground/70",
      )}
      aria-hidden="true"
    >
      {index + 1}
    </span>
  );
}
