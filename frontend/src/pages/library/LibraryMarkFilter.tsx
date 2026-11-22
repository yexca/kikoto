import { ListFilter } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { quickMarkMeta } from "@/components/work-card/WorkCardShell";
import { listeningStatusOptions } from "@/features/work-detail/workDetailShared";
import type { ListeningStatus } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

/**
 * The Library's Quick mark filter: one toolbar button and a popover listing
 * every mark. The button is the only place the filter shows: while one is
 * set, it turns primary and carries that mark's icon, and a wide layout also
 * names the mark. Choosing **All** clears it.
 */
export function LibraryMarkFilter({
  value,
  onChange,
  size = "sm",
  phone = false,
}: {
  value: ListeningStatus | "all";
  onChange: (value: ListeningStatus | "all") => void;
  /** Matches the button to an 8 or 10 unit toolbar row; the 10 unit row has room for the mark's name. */
  size?: "sm" | "md";
  /** Keeps the popover clear of the bottom navigation and player. */
  phone?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const active = value !== "all";
  const meta = active ? quickMarkMeta(value) : null;
  const Icon = meta?.icon ?? ListFilter;
  const statusLabel = (status: ListeningStatus) =>
    t(`library.status.${status}`, {
      defaultValue: listeningStatusOptions.find((option) => option.value === status)?.label ?? status,
    });
  const title = t("library.markFilterToggle");
  const label = active ? t("library.markFilterValue", { status: statusLabel(value) }) : title;
  const named = active && size === "md";
  const choose = (next: ListeningStatus | "all") => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  return (
    <div className="relative shrink-0" ref={anchorRef}>
      <Button
        type="button"
        variant="toolbar"
        size={named ? "sm" : "icon-sm"}
        className={cn(
          size === "md" && (named ? "h-10 gap-1.5 px-3 text-sm" : "h-10 w-10"),
          active &&
            "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary aria-expanded:bg-primary/15 aria-expanded:text-primary",
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon className={cn("h-4 w-4 shrink-0", meta?.className)} aria-hidden="true" />
        {named && <span className="max-w-32 truncate">{statusLabel(value)}</span>}
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        ariaLabel={title}
        bottomCollisionPadding={phone ? 168 : undefined}
        className="w-max min-w-40 max-w-[min(15rem,calc(100vw-1.5rem))] p-1.5 text-sm"
      >
        <ul>
          <MarkFilterOption
            selected={value === "all"}
            icon={<ListFilter className="h-4 w-4" />}
            onSelect={() => choose("all")}
          >
            {t("library.allStatuses")}
          </MarkFilterOption>
          {listeningStatusOptions.map((option) => {
            const optionMeta = quickMarkMeta(option.value);
            return (
              <MarkFilterOption
                key={option.value}
                selected={value === option.value}
                icon={<optionMeta.icon className={cn("h-4 w-4", optionMeta.className)} />}
                onSelect={() => choose(option.value)}
              >
                {statusLabel(option.value)}
              </MarkFilterOption>
            );
          })}
        </ul>
      </AnchoredPopover>
    </div>
  );
}

function MarkFilterOption({
  selected,
  icon,
  children,
  onSelect,
}: {
  selected: boolean;
  icon: ReactNode;
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected ? "bg-primary/10 font-medium text-primary" : "text-foreground",
        )}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{children}</span>
      </button>
    </li>
  );
}
