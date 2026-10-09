import { useCallback, useEffect, useState } from "react";

/** How long a first remove click waits for its confirmation. */
const armedTimeoutMs = 4000;

/**
 * Two-step confirmation for one item at a time: the first click arms the
 * item's remove action, a second click on it confirms. Arming expires, and
 * Escape or arming another item disarms it.
 */
export function useArmedConfirm<Key>() {
  const [armed, setArmed] = useState<Key | null>(null);
  const disarm = useCallback(() => setArmed(null), []);

  useEffect(() => {
    if (armed === null) return;
    const timer = window.setTimeout(disarm, armedTimeoutMs);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") disarm();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [armed, disarm]);

  return { armed, arm: setArmed, disarm };
}
