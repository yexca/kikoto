import { useEffect, useRef, useState } from "react";

type DeferredBusyOptions = {
  delayMs?: number;
  minVisibleMs?: number;
};

export function useDeferredBusy(busy: boolean, { delayMs = 140, minVisibleMs = 180 }: DeferredBusyOptions = {}) {
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);
  const visibleSinceRef = useRef(0);

  useEffect(() => {
    let timer: number | undefined;

    if (busy) {
      if (!visibleRef.current) {
        timer = window.setTimeout(
          () => {
            visibleRef.current = true;
            visibleSinceRef.current = Date.now();
            setVisible(true);
          },
          Math.max(0, delayMs),
        );
      }
    } else if (visibleRef.current) {
      const remaining = Math.max(0, minVisibleMs - (Date.now() - visibleSinceRef.current));
      timer = window.setTimeout(() => {
        visibleRef.current = false;
        visibleSinceRef.current = 0;
        setVisible(false);
      }, remaining);
    }

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [busy, delayMs, minVisibleMs]);

  useEffect(
    () => () => {
      visibleRef.current = false;
    },
    [],
  );

  return visible;
}
