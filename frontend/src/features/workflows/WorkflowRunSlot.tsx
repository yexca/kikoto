import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const RunSlotContext = createContext<{
  target: HTMLElement | null;
  setTarget: (node: HTMLElement | null) => void;
} | null>(null);

/** Lets the selected workflow place its Run action in the page toolbar beside Activity. */
export function WorkflowRunSlotProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  return <RunSlotContext.Provider value={{ target, setTarget }}>{children}</RunSlotContext.Provider>;
}

export function WorkflowRunSlotTarget() {
  const slot = useContext(RunSlotContext);
  return <div ref={slot?.setTarget} className="flex shrink-0 items-center gap-2 empty:hidden" />;
}

/** Renders inline when no toolbar slot is provided, so panels stay usable on their own. */
export function WorkflowRunSlotContent({ children }: { children: ReactNode }) {
  const slot = useContext(RunSlotContext);
  if (!slot) return <>{children}</>;
  return slot.target ? createPortal(children, slot.target) : null;
}
