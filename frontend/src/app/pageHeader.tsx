import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Detail pages hand their return action to the app header instead of rendering
 * their own back button, and a browse page can place its phone title there.
 * Cached browse pages stay mounted while hidden, so only a page whose
 * surrounding PageActiveProvider is active may claim the header.
 */
export type PageHeaderBack = {
  /** Accessible name and tooltip of the header back button, e.g. "Back to circles". */
  label: string;
  /** Entity shown beside the section name on wide layouts. */
  title?: string;
  onBack: () => void;
};

type PageHeaderEntry = PageHeaderBack & { id: string };

type PageHeaderRegistry = {
  set: (entry: PageHeaderEntry) => void;
  remove: (id: string) => void;
};

const PageHeaderRegistryContext = createContext<PageHeaderRegistry | null>(null);
const PageHeaderBackContext = createContext<PageHeaderBack | null>(null);
const PageActiveContext = createContext(true);
const PageHeaderTitleSlotContext = createContext<{
  slot: HTMLElement | null;
  setSlot: (slot: HTMLElement | null) => void;
} | null>(null);

export const PageActiveProvider = PageActiveContext.Provider;

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<readonly PageHeaderEntry[]>([]);
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const titleSlotValue = useMemo(() => ({ slot: titleSlot, setSlot: setTitleSlot }), [titleSlot]);
  const registry = useMemo<PageHeaderRegistry>(
    () => ({
      set: (entry) =>
        setEntries((current) => {
          const index = current.findIndex((item) => item.id === entry.id);
          if (index < 0) return [...current, entry];
          const next = [...current];
          next[index] = entry;
          return next;
        }),
      remove: (id) => setEntries((current) => current.filter((item) => item.id !== id)),
    }),
    [],
  );
  const back = entries[entries.length - 1] ?? null;
  return (
    <PageHeaderRegistryContext.Provider value={registry}>
      <PageHeaderBackContext.Provider value={back}>
        <PageHeaderTitleSlotContext.Provider value={titleSlotValue}>{children}</PageHeaderTitleSlotContext.Provider>
      </PageHeaderBackContext.Provider>
    </PageHeaderRegistryContext.Provider>
  );
}

/**
 * Where a browse page's own phone title, such as the Library source menu,
 * renders in the app header beside the app icon. It collapses while empty.
 */
export function PageHeaderTitleSlot({ className }: { className?: string }) {
  const context = useContext(PageHeaderTitleSlotContext);
  return <div ref={context?.setSlot} className={className} />;
}

/**
 * Renders its children in the header title slot while the calling page is the
 * visible one. The children keep the page's own state and context; nothing
 * renders while a detail page holds the header's back button.
 */
export function PageHeaderTitle({ children }: { children: ReactNode }) {
  const context = useContext(PageHeaderTitleSlotContext);
  const active = useContext(PageActiveContext);
  if (!active || !context?.slot) return null;
  return createPortal(children, context.slot);
}

export function usePageHeaderBackState() {
  return useContext(PageHeaderBackContext);
}

/** Claims the app header back button while the calling page is the visible one. */
export function usePageHeaderBack({ label, title, onBack, enabled = true }: PageHeaderBack & { enabled?: boolean }) {
  const registry = useContext(PageHeaderRegistryContext);
  const active = useContext(PageActiveContext);
  const id = useId();
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });
  useEffect(() => {
    if (!registry || !active || !enabled) return;
    registry.set({ id, label, title, onBack: () => onBackRef.current() });
    return () => registry.remove(id);
  }, [active, enabled, id, label, registry, title]);
}

/** Render-nothing form of usePageHeaderBack for early-return branches. */
export function PageHeaderBackAction(props: PageHeaderBack & { enabled?: boolean }) {
  usePageHeaderBack(props);
  return null;
}
