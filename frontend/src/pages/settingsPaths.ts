/** Personal tags and data transfer need library access; the other personal settings do not. */
export const PERSONAL_DATA_PERMISSION = "library:read";

/** Opens the Your data section of Account. */
export const YOUR_DATA_SETTINGS_PATH = "/settings?tab=data";

/** Opens the Time zone section of Account. */
export const TIME_ZONE_SETTINGS_PATH = "/settings?tab=time-zone";

export const SYSTEM_SETTINGS_PATH = "/system";

export const systemSettingsTabs = ["library", "cache", "proxy", "llm", "cleanup", "users"] as const;
export type SystemSettingsTab = (typeof systemSettingsTabs)[number];

/**
 * Tab ids that open a System tab under another name: the metadata id opens
 * Library, which holds catalog freshness, and ASR and translation services
 * share the LLM tab and its content safety policy.
 */
export const systemSettingsTabAliases: Readonly<Record<string, SystemSettingsTab>> = {
  metadata: "library",
  asr: "llm",
  services: "llm",
};

export function systemSettingsPath(tab: SystemSettingsTab) {
  return `${SYSTEM_SETTINGS_PATH}?tab=${tab}`;
}
