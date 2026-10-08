import { useId, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTokenDraftHandlers } from "@/components/ui/token-input";
import { cn } from "@/lib/tailwindClassNames";
import type { MetadataFieldStatus } from "./metadataEditorModel";

export function MetadataFieldStatusBadge({ status }: { status: MetadataFieldStatus }) {
  const { t } = useTranslation();
  if (status === "source") return null;
  const variant = status === "edited" ? "info" : status === "reverting" ? "warning" : "secondary";
  return (
    <Badge variant={variant} className="shrink-0 px-1.5 py-0 text-[11px] font-medium">
      {t(`metadataEditor.status.${status}`)}
    </Badge>
  );
}

/**
 * One editable field: a label row with its override status and a revert
 * action, the control, and an optional hint. When the field offers an undo,
 * a staged revert replaces the control with a note and that undo action.
 */
export function MetadataEditorField({
  label,
  labelFor,
  labelBadges,
  status,
  revertLabel,
  onRevert,
  onUndoRevert,
  hint,
  children,
}: {
  label: string;
  labelFor?: string;
  labelBadges?: ReactNode;
  status: MetadataFieldStatus;
  revertLabel?: string;
  onRevert?: () => void;
  onUndoRevert?: () => void;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const LabelTag = labelFor ? "label" : "span";
  return (
    <div role="group" aria-labelledby={labelId} className="min-w-0 space-y-1.5">
      <div className="flex min-h-7 items-center gap-2">
        <LabelTag id={labelId} htmlFor={labelFor} className="min-w-0 truncate text-sm font-medium">
          {label}
        </LabelTag>
        {labelBadges}
        <MetadataFieldStatusBadge status={status} />
        <span className="flex-1" />
        {status === "manual" && onRevert && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
            aria-label={revertLabel}
            title={revertLabel}
            onClick={onRevert}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("metadataEditor.revert")}
          </Button>
        )}
      </div>
      {status === "reverting" && onUndoRevert ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <span className="min-w-0">{t("metadataEditor.revertPending")}</span>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={onUndoRevert}>
            <Undo2 className="h-3.5 w-3.5" />
            {t("metadataEditor.undo")}
          </Button>
        </div>
      ) : (
        children
      )}
      {hint && !(status === "reverting" && onUndoRevert) && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export type SuggestionOption = {
  key: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  onSelect: () => void;
};

/**
 * A text field with an inline suggestion list. Arrow keys move through the
 * options, Enter picks the highlighted one or submits the typed text, and
 * Escape closes the list. The list renders in flow so the dialog body scrolls
 * to it rather than clipping a floating layer.
 */
export function SuggestionCombobox({
  id,
  value,
  onChange,
  options,
  truncated = false,
  footer,
  placeholder,
  ariaLabel,
  onSubmitText,
  onSubmitTokens,
  onFocus,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SuggestionOption[];
  truncated?: boolean;
  /** Extra content under the options, such as a conflict notice. */
  footer?: ReactNode;
  placeholder?: string;
  ariaLabel?: string;
  /** Called on Enter when no option is highlighted. */
  onSubmitText?: (value: string) => void;
  /** When set, a comma or line break submits each finished name and keeps the rest typed. */
  onSubmitTokens?: (values: string[]) => void;
  onFocus?: () => void;
}) {
  const { t } = useTranslation();
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listId = `${inputId}-options`;
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  const hasContent = options.length > 0 || truncated || Boolean(footer);
  const open = focused && !dismissed && hasContent && value.trim() !== "";
  const activeOption = open && active >= 0 ? options[active] : undefined;

  const changeText = (text: string) => {
    setDismissed(false);
    setActive(-1);
    onChange(text);
  };
  const tokenHandlers = useTokenDraftHandlers({
    onCommit: (names) => onSubmitTokens?.(names),
    onDraftChange: changeText,
  });

  const select = (option: SuggestionOption) => {
    if (option.disabled) return;
    option.onSelect();
    setActive(-1);
    // A pick can refill the field and refresh the suggestions; keep the list closed until the next edit.
    setDismissed(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!options.length) return;
      event.preventDefault();
      setDismissed(false);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => {
        const next = current + step;
        if (next < -1) return options.length - 1;
        return next >= options.length ? -1 : next;
      });
      return;
    }
    if (event.key === "Enter") {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      if (activeOption) select(activeOption);
      else if (value.trim()) onSubmitText?.(value);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
      setActive(-1);
    }
  };

  return (
    <div className="min-w-0">
      <Input
        id={inputId}
        fieldSize="sm"
        className="w-full"
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={activeOption ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onFocus={() => {
          setFocused(true);
          onFocus?.();
        }}
        onBlur={() => {
          setFocused(false);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        {...(onSubmitTokens
          ? tokenHandlers
          : { onChange: (event: ChangeEvent<HTMLInputElement>) => changeText(event.target.value) })}
      />
      <div
        id={listId}
        role="listbox"
        aria-label={ariaLabel}
        hidden={!open}
        className="mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover p-1 shadow-sm"
        // Keep focus in the field so a pointer pick does not close the list first.
        onMouseDown={(event) => event.preventDefault()}
      >
        {options.map((option, index) => (
          <div
            key={option.key}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === active}
            aria-disabled={option.disabled || undefined}
            className={cn(
              "flex min-h-9 cursor-pointer items-center justify-between gap-3 rounded px-2 text-sm",
              index === active ? "bg-accent text-accent-foreground" : "hover:bg-muted",
              option.disabled && "cursor-not-allowed opacity-60",
            )}
            onMouseEnter={() => setActive(index)}
            onClick={() => select(option)}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.detail && (
              <span className="min-w-0 max-w-[45%] truncate text-xs text-muted-foreground">{option.detail}</span>
            )}
          </div>
        ))}
        {truncated && (
          <div className="px-2 py-1 text-xs text-muted-foreground">{t("libraryDetail.tooManyMatches")}</div>
        )}
        {footer}
      </div>
    </div>
  );
}
