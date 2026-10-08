import { X } from "lucide-react";
import {
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { appendTokens, splitTokenDraft, TOKEN_SEPARATORS } from "@/lib/tokenDraft";
import { cn } from "@/lib/tailwindClassNames";

/**
 * Input handlers that turn a separator into finished tokens while the rest of
 * the text stays editable. Text typed through an IME is split only once the
 * composition ends, so a separator confirmed as part of a candidate is not
 * taken early. A pasted list is split even when the field is a single-line
 * input that would otherwise drop its line breaks.
 */
export function useTokenDraftHandlers({
  separators = TOKEN_SEPARATORS,
  onCommit,
  onDraftChange,
}: {
  separators?: RegExp;
  onCommit: (values: string[]) => void;
  onDraftChange: (draft: string) => void;
}) {
  const composing = useRef(false);
  const take = (text: string) => {
    const { tokens, rest } = splitTokenDraft(text, separators);
    if (tokens.length > 0) onCommit(tokens);
    onDraftChange(rest);
  };
  return {
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      if (composing.current || (event.nativeEvent as InputEvent).isComposing) onDraftChange(event.target.value);
      else take(event.target.value);
    },
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => {
      composing.current = false;
      take(event.currentTarget.value);
    },
    onPaste: (event: ClipboardEvent<HTMLInputElement>) => {
      const pasted = event.clipboardData.getData("text");
      if (!separators.test(pasted)) return;
      event.preventDefault();
      const input = event.currentTarget;
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      take(`${input.value.slice(0, start)}${pasted}\n${input.value.slice(end)}`);
    },
  };
}

type TokenInputProps = {
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  /** Returns the stored form of a token, or "" to drop it. */
  normalize?: (token: string) => string;
  /** Invalid values stay in the field, marked, so the user can remove them. */
  isValid?: (value: string) => boolean;
  /** Values with the same key count as duplicates. Defaults to case-insensitive. */
  keyOf?: (value: string) => string;
  separators?: RegExp;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  readOnly?: boolean;
  maxLength?: number;
  className?: string;
  itemClassName?: string;
};

/**
 * A multi-value field. A comma, semicolon, line break, Enter, or leaving the
 * field turns the typed text into a removable token; Backspace in an empty
 * draft removes the last token.
 */
export function TokenInput({
  id,
  values,
  onChange,
  normalize = (token) => token.trim(),
  isValid,
  keyOf = (value) => value.toLowerCase(),
  separators = TOKEN_SEPARATORS,
  placeholder,
  ariaLabel,
  disabled = false,
  readOnly = false,
  maxLength,
  className,
  itemClassName,
}: TokenInputProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const editable = !disabled && !readOnly;
  const add = (tokens: string[]) => {
    const next = appendTokens(values, tokens, normalize, keyOf);
    if (next.length !== values.length) onChange(next);
  };
  const handlers = useTokenDraftHandlers({ separators, onCommit: add, onDraftChange: setDraft });
  const commitDraft = () => {
    if (!draft.trim()) return false;
    add([draft]);
    setDraft("");
    return true;
  };
  const remove = (index: number) => onChange(values.filter((_, current) => current !== index));
  const invalid = isValid ? values.some((value) => !isValid(value)) : false;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      if (commitDraft()) event.preventDefault();
      return;
    }
    if (event.key === "Backspace" && draft === "" && values.length > 0) {
      event.preventDefault();
      remove(values.length - 1);
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-[var(--control-radius)] border border-input bg-card px-1.5 py-1 text-sm text-foreground shadow-[inset_0_1px_1px_hsl(var(--foreground)/0.03)] transition-[border-color,box-shadow]",
        editable &&
          "cursor-text hover:border-muted-foreground/40 focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/35",
        disabled && "cursor-not-allowed opacity-60",
        invalid && "border-error-border focus-within:ring-error/30",
        className,
      )}
      onMouseDown={(event) => {
        // A press on the empty area moves focus to the draft instead of blurring it.
        if (editable && event.target === event.currentTarget) {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      {values.length > 0 && (
        <ul className="contents">
          {values.map((value, index) => {
            const valid = isValid ? isValid(value) : true;
            return (
              <li
                key={keyOf(value)}
                className={cn(
                  "inline-flex h-6 min-w-0 max-w-full items-center gap-0.5 rounded-[var(--badge-radius)] border text-xs font-medium",
                  editable ? "pl-2 pr-0.5" : "px-2",
                  valid
                    ? "border-transparent bg-secondary text-secondary-foreground"
                    : "border-error-border bg-error-surface text-error-foreground",
                  itemClassName,
                )}
              >
                <span className="min-w-0 truncate" title={value}>
                  {value}
                </span>
                {editable && (
                  <button
                    type="button"
                    className="grid h-5 w-5 shrink-0 place-items-center rounded-[calc(var(--badge-radius)-2px)] text-current opacity-70 transition-opacity hover:bg-foreground/10 hover:opacity-100"
                    aria-label={t("common.removeItem", { value })}
                    title={t("common.removeItem", { value })}
                    onClick={() => {
                      remove(index);
                      inputRef.current?.focus();
                    }}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editable && (
        <input
          ref={inputRef}
          id={id}
          className="h-7 min-w-24 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground/80"
          value={draft}
          maxLength={maxLength}
          placeholder={values.length === 0 ? placeholder : undefined}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          {...handlers}
          onKeyDown={onKeyDown}
          onBlur={() => {
            commitDraft();
          }}
        />
      )}
    </div>
  );
}
