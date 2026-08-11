export type RecommendationClientSession = {
  id: string;
  seed: number;
};

type RecommendationSessionStorage = Pick<Storage, "getItem" | "setItem">;

const storagePrefix = "kikoto:recommendation-session:v1:";
const sessionIDPattern = /^[A-Za-z0-9._:-]{1,64}$/;
const memorySessions = new Map<string, string>();
let fallbackSequence = 0;

export function readOrCreateRecommendationSession(
  storageScope: string,
  algorithmVersion: string,
  storage: RecommendationSessionStorage | null = browserSessionStorage(),
  createID: () => string = createRecommendationSessionID,
): RecommendationClientSession {
  const key = `${storagePrefix}${encodeURIComponent(algorithmVersion)}:${storageScope}`;
  let sessionID = readStoredSessionID(storage, key) ?? memorySessions.get(key) ?? "";
  if (!sessionIDPattern.test(sessionID)) {
    sessionID = createID();
    if (!sessionIDPattern.test(sessionID)) sessionID = createRecommendationSessionID();
    memorySessions.set(key, sessionID);
    try {
      storage?.setItem(key, sessionID);
    } catch {
      // The in-memory session still prevents page navigation from rebuilding.
    }
  }
  return { id: sessionID, seed: recommendationSeedForSessionID(sessionID) };
}

export function recommendationSeedForSessionID(sessionID: string) {
  let hash = 2166136261;
  for (let index = 0; index < sessionID.length; index += 1) {
    hash = Math.imul(hash ^ sessionID.charCodeAt(index), 16777619) >>> 0;
  }
  return (hash % 2147483646) + 1;
}

function readStoredSessionID(storage: RecommendationSessionStorage | null, key: string) {
  try {
    const value = storage?.getItem(key) ?? "";
    return sessionIDPattern.test(value) ? value : null;
  } catch {
    return null;
  }
}

function browserSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
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
