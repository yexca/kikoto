import { Capacitor, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

type KikotoSessionCredentialPlugin = {
  read(): Promise<{ value: string }>;
  write(options: { value: string }): Promise<void>;
  clear(): Promise<void>;
};

const PREFERENCE_KEY = "kikoto:mobile-session-token";
const pluginName = "KikotoSessionCredential";
let plugin: KikotoSessionCredentialPlugin | null = null;

/** The iOS shell keeps the session in the Keychain; other native shells use their private app preferences. */
function keychain() {
  if (!Capacitor.isPluginAvailable(pluginName)) return null;
  plugin ??= registerPlugin<KikotoSessionCredentialPlugin>(pluginName);
  return plugin;
}

/**
 * Reads the durable session. On iOS a session found in app preferences, which
 * backups include, moves into the Keychain and leaves the preferences.
 */
export async function readNativeSessionCredential() {
  const store = keychain();
  const stored = await Preferences.get({ key: PREFERENCE_KEY });
  const preference = stored.value?.trim() ?? "";
  if (!store) return preference;
  let credential = (await store.read()).value.trim();
  if (stored.value !== null) {
    if (!credential && preference) {
      await store.write({ value: preference });
      credential = preference;
    }
    await Preferences.remove({ key: PREFERENCE_KEY });
  }
  return credential;
}

export async function writeNativeSessionCredential(value: string) {
  const store = keychain();
  if (store) await store.write({ value });
  else await Preferences.set({ key: PREFERENCE_KEY, value });
}

export async function clearNativeSessionCredential() {
  const store = keychain();
  if (store) await store.clear();
  else await Preferences.remove({ key: PREFERENCE_KEY });
}
