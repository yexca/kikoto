import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/icon-button";

/**
 * A phone search field that opens from its icon. The field stays open while
 * it holds a query, including one restored from history or set by a link such
 * as a tag, and closing it clears the query so a hidden field never narrows
 * the results.
 */
export function useCollapsibleSearch(query: string, onQueryChange: (value: string) => void) {
  const hasQuery = Boolean(query.trim());
  const [open, setOpen] = useState(hasQuery);
  const focusOnOpen = useRef(false);
  const fieldRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (hasQuery) setOpen(true);
  }, [hasQuery]);

  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    fieldRef.current?.querySelector("input")?.focus();
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      if (hasQuery) onQueryChange("");
      return;
    }
    focusOnOpen.current = true;
    setOpen(true);
  };

  return { open, toggle, fieldRef };
}

/** The icon that opens and closes a collapsible search field. */
export function SearchToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <IconButton title={t("collection.search")} aria-pressed={open} onClick={onToggle}>
      <Search className={open ? "h-4 w-4 text-primary" : "h-4 w-4"} />
    </IconButton>
  );
}
