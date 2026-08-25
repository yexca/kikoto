import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { cn } from "@/lib/tailwindClassNames";

export type FloatingSelectOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
};

export function FloatingSelect({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled = false,
  ariaBusy = false,
  ariaInvalid = false,
  className,
  contentClassName,
  optionClassName,
}: {
  value: string;
  options: readonly FloatingSelectOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  ariaBusy?: boolean;
  ariaInvalid?: boolean;
  className?: string;
  contentClassName?: string;
  optionClassName?: string;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selectedOption = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    optionRefs.current[selectedIndex]?.focus();
  }, [open, selectedIndex]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const moveFocus = (currentIndex: number, direction: 1 | -1) => {
    if (options.length === 0) return;
    let nextIndex = currentIndex;
    for (let offset = 0; offset < options.length; offset += 1) {
      nextIndex = (nextIndex + direction + options.length) % options.length;
      if (!options[nextIndex]?.disabled) {
        optionRefs.current[nextIndex]?.focus();
        return;
      }
    }
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(index, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(index, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(-1, 1);
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(0, -1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[index];
      if (!option?.disabled) {
        onValueChange(option.value);
        close();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  return (
    <div ref={anchorRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-busy={ariaBusy}
        aria-invalid={ariaInvalid}
        data-player-no-drag
        disabled={disabled}
        className={cn(
          "flex h-[var(--control-height)] w-full items-center justify-between gap-2 rounded-[var(--control-radius)] border border-input bg-background px-3 py-2 text-sm text-foreground transition-[color,background-color,border-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&>span]:truncate",
          className,
        )}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="min-w-0 flex-1 truncate text-left">{selectedOption?.label}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      <AnchoredPopover
        open={open && !disabled}
        anchorRef={anchorRef}
        align="start"
        gap={4}
        collisionPadding={8}
        floatingLayer
        matchAnchorWidth
        onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : close())}
        className={cn("w-max min-w-0 overflow-hidden p-1", contentClassName)}
      >
        <div role="listbox" aria-label={ariaLabel} data-player-no-drag className="max-h-[inherit] overflow-y-auto">
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="option"
              aria-selected={option.value === value}
              disabled={option.disabled}
              className={cn(
                "relative flex min-h-[var(--control-height)] w-full min-w-0 items-center gap-2 rounded-[calc(var(--control-radius)-2px)] px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50",
                option.value === value && "bg-primary/10 font-medium text-primary",
                optionClassName,
              )}
              onClick={() => {
                if (option.disabled) return;
                onValueChange(option.value);
                close();
              }}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.value === value && <Check className="h-4 w-4 shrink-0" />}
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}
