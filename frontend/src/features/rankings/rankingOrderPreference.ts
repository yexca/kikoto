import { localStore, serverKey } from "@/lib/clientStorage";
import type { RankingOrder } from "@/lib/rankingApi";

import { decodeRankingOrder, encodeRankingOrder } from "./rankingModel";

/**
 * The order last chosen on each ranking chip, a per-device convenience for
 * the server's lists. It is never shared configuration; the default order
 * applies when storage is unavailable.
 */
const rankingOrdersStorageKey = () => serverKey("kikoto:ranking-orders");

export function readRankingOrderPreferences(): Record<string, RankingOrder> {
  const stored = localStore.readJSON(rankingOrdersStorageKey());
  if (!stored || typeof stored !== "object") return {};
  const preferences: Record<string, RankingOrder> = {};
  for (const [chipKey, value] of Object.entries(stored)) {
    const order = decodeRankingOrder(value);
    if (order) preferences[chipKey] = order;
  }
  return preferences;
}

// The choice lasts for this visit when local storage is unavailable.
export function writeRankingOrderPreference(chipKey: string, order: RankingOrder) {
  const stored = Object.fromEntries(
    Object.entries(readRankingOrderPreferences()).map(([key, value]) => [key, encodeRankingOrder(value)]),
  );
  stored[chipKey] = encodeRankingOrder(order);
  localStore.writeJSON(rankingOrdersStorageKey(), stored);
}
