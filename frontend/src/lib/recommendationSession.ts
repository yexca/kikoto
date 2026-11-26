import { accountScopeKey, sessionStore, type ClientStore, type StorageKey } from "./clientStorage";

export const RECOMMENDATION_ALGORITHM_VERSION = "heuristic-v6";
export const USER_PREFERENCES_CHANGED = "kikoto:user-preferences-changed";
export type RecommendationClientSession = {
  id: string;
  seed: number;
};

const storagePrefix = "kikoto:recommendation-session:v1";
const sessionIDPattern = /^[A-Za-z0-9._:-]{1,64}$/;
const memorySessions = new Map<string, string>();
let fallbackSequence = 0;

function sessionStorageKey(storageScope: string, algorithmVersion: string) {
  return accountScopeKey(`${storagePrefix}:${encodeURIComponent(algorithmVersion)}`, storageScope);
}

export function readOrCreateRecommendationSession(
  storageScope: string,
  algorithmVersion: string,
  storage: ClientStore = sessionStore,
  createID: () => string = createRecommendationSessionID,
): RecommendationClientSession {
  const key = sessionStorageKey(storageScope, algorithmVersion);
  let sessionID = memorySessions.get(key) ?? readStoredSessionID(storage, key) ?? "";
  if (!sessionIDPattern.test(sessionID)) {
    sessionID = createID();
    if (!sessionIDPattern.test(sessionID)) sessionID = createRecommendationSessionID();
    memorySessions.set(key, sessionID);
    // The in-memory session still prevents page navigation from rebuilding.
    storage.write(key, sessionID);
  }
  return { id: sessionID, seed: recommendationSeedForSessionID(sessionID) };
}

export function renewRecommendationSession(storageScope: string) {
  const key = sessionStorageKey(storageScope, RECOMMENDATION_ALGORITHM_VERSION);
  const id = createRecommendationSessionID();
  memorySessions.set(key, id);
  // Memory keeps the new session when storage refuses it.
  sessionStore.write(key, id);
}

export function recommendationSeedForSessionID(sessionID: string) {
  let hash = 2166136261;
  for (let index = 0; index < sessionID.length; index += 1) {
    hash = Math.imul(hash ^ sessionID.charCodeAt(index), 16777619) >>> 0;
  }
  return (hash % 2147483646) + 1;
}

function readStoredSessionID(storage: ClientStore, key: StorageKey) {
  const value = storage.read(key) ?? "";
  return sessionIDPattern.test(value) ? value : null;
}

function createRecommendationSessionID() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }
  fallbackSequence += 1;
  return `fallback-${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
}
