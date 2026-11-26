import { currentClientServerIdentity, currentClientStorageScope, type ClientPrincipalID } from "./clientStorageScope";

// The only module that touches browser storage. A key names its scope when it
// is built, and every read tolerates storage that is missing, blocked, full,
// or holding something unreadable. See
// docs/architecture/frontend/interaction-principles.md#client-storage.

declare const scopeChosen: unique symbol;

/** A storage key whose scope was chosen with deviceKey, serverKey, accountKey, or accountScopeKey. */
export type StorageKey = string & { readonly [scopeChosen]: true };

/** Shared by every server and account on this device: display preferences, and what picks the server. */
export function deviceKey(name: string): StorageKey {
  return name as StorageKey;
}

/** Shared by the accounts of the configured server: server-wide workflow options. */
export function serverKey(name: string): StorageKey {
  return `${name}:${encodeURIComponent(currentClientServerIdentity())}` as StorageKey;
}

/** Kept for the configured server and `principalID`, the signed-in user or null for anonymous. */
export function accountKey(name: string, principalID: ClientPrincipalID): StorageKey {
  return accountScopeKey(name, currentClientStorageScope(principalID));
}

/**
 * Kept for `storageScope`, a `currentClientStorageScope` value handed down by
 * the caller, followed by any further `parts`.
 */
export function accountScopeKey(name: string, storageScope: string, ...parts: string[]): StorageKey {
  return [name, storageScope, ...parts].join(":") as StorageKey;
}

/** The part of the Web Storage interface a store uses; a test passes a fake one. */
export type StorageArea = Partial<Pick<Storage, "getItem" | "setItem" | "removeItem">>;

export type ClientStore = {
  /** The stored string, or null when absent or unreadable. */
  read(key: StorageKey): string | null;
  /** The parsed JSON value, or null when absent, unreadable, or not JSON. */
  readJSON(key: StorageKey): unknown;
  /** Whether the value was stored; a value that cannot be stored lasts only in the caller's memory. */
  write(key: StorageKey, value: string): boolean;
  writeJSON(key: StorageKey, value: unknown): boolean;
  remove(key: StorageKey): void;
  /** Moves a value saved under `from` to `to` unless `to` already holds one. */
  carryOver(from: StorageKey, to: StorageKey): void;
};

/** A store over `area`, which is looked up on every call and may be missing or throw. */
export function clientStore(area: () => StorageArea | null | undefined): ClientStore {
  function current() {
    try {
      return area() ?? null;
    } catch {
      return null;
    }
  }
  const store: ClientStore = {
    read(key) {
      try {
        return current()?.getItem?.(key) ?? null;
      } catch {
        return null;
      }
    },
    readJSON(key) {
      const raw = store.read(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
    write(key, value) {
      const target = current();
      if (!target?.setItem) return false;
      try {
        target.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    writeJSON(key, value) {
      return store.write(key, JSON.stringify(value));
    },
    remove(key) {
      try {
        current()?.removeItem?.(key);
      } catch {
        // Nothing else holds the value.
      }
    },
    carryOver(from, to) {
      if (from === to) return;
      const saved = store.read(from);
      if (saved === null) return;
      if (store.read(to) === null && !store.write(to, saved)) return;
      store.remove(from);
    },
  };
  return store;
}

type BrowserAreaName = "localStorage" | "sessionStorage";

function browserArea(name: BrowserAreaName): StorageArea | null {
  const scope = globalThis as { window?: Partial<Record<BrowserAreaName, Storage>> } & Partial<
    Record<BrowserAreaName, Storage>
  >;
  return scope.window?.[name] ?? scope[name] ?? null;
}

/** Local storage: kept across visits on this device. */
export const localStore = clientStore(() => browserArea("localStorage"));

/** Session storage: kept for one browser tab or native-app launch. */
export const sessionStore = clientStore(() => browserArea("sessionStorage"));
