import { useEffect, useRef, useState } from "react";

import { appendTransferSample, transferRate, transferStallMs, type TransferSample } from "./runPresentation";

/** Re-renders on an interval while `active`, so elapsed times of running work stay current. */
export function useNow(active: boolean, intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/**
 * Observes a byte counter over time and reports a smoothed transfer rate. The rate drops to zero
 * once the counter has not moved for a while, instead of freezing at the last burst.
 */
export function useTransferRate(key: string | number, bytes: number, active: boolean) {
  const [rate, setRate] = useState<number | null>(null);
  const samples = useRef<TransferSample[]>([]);

  useEffect(() => {
    samples.current = [];
    setRate(null);
  }, [key, active]);

  useEffect(() => {
    if (!active) return;
    samples.current = appendTransferSample(samples.current, { at: Date.now(), bytes });
    setRate(transferRate(samples.current));
  }, [key, active, bytes]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      const last = samples.current[samples.current.length - 1];
      if (last && Date.now() - last.at > transferStallMs) setRate(0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [key, active]);

  return rate;
}
