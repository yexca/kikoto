import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Detail pages hand their return action to the app header instead of rendering
 * their own back button. Cached browse pages stay mounted while hidden, so only
 * a page whose surrounding PageActiveProvider is active may claim the header.
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

export const PageActiveProvider = PageActiveContext.Provider;

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<readonly PageHeaderEntry[]>([]);
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
      <PageHeaderBackContext.Provider value={back}>{children}</PageHeaderBackContext.Provider>
    </PageHeaderRegistryContext.Provider>
  );
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
