import { currentServerScopedStorageKey } from "@/lib/clientStorageScope";
import type { RankingOrder } from "@/lib/rankingApi";

import { decodeRankingOrder, encodeRankingOrder } from "./rankingModel";

/**
 * The order last chosen on each ranking chip, a per-device convenience for
 * the server's lists. It is never shared configuration; the default order
 * applies when storage is unavailable.
 */
const storageKey = () => currentServerScopedStorageKey("kikoto:ranking-orders");

export function readRankingOrderPreferences(): Record<string, RankingOrder> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(storageKey()) ?? "{}");
    if (!stored || typeof stored !== "object") return {};
    const preferences: Record<string, RankingOrder> = {};
    for (const [chipKey, value] of Object.entries(stored)) {
      const order = decodeRankingOrder(value);
      if (order) preferences[chipKey] = order;
    }
    return preferences;
  } catch {
    return {};
  }
}

export function writeRankingOrderPreference(chipKey: string, order: RankingOrder) {
  try {
    const stored = Object.fromEntries(
      Object.entries(readRankingOrderPreferences()).map(([key, value]) => [key, encodeRankingOrder(value)]),
    );
    stored[chipKey] = encodeRankingOrder(order);
    window.localStorage.setItem(storageKey(), JSON.stringify(stored));
  } catch {
    // The choice lasts for this visit when local storage is unavailable.
  }
}
