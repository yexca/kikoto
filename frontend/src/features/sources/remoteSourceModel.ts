import type { FileSource, FileSourceDetectResult } from "@/lib/api";

export const LEGACY_NUMBER178_SOURCE_TYPE = "kikoeru_compatible_number178";
export const REMOTE_SOURCE_TYPES = new Set(["kikoeru_compatible", LEGACY_NUMBER178_SOURCE_TYPE]);
export const DATA_PREFIX = "/data";
export const DEFAULT_SAVE_SUFFIX = "/<source_code>/<code_prefix>_<code_group>/<work_code>";
export const DEFAULT_CACHE_SUFFIX = "/media/<source_code>/<code_prefix>/<code_group>/<work_code>";

export type RemoteSourceHealth = "healthy" | "unavailable" | "unknown" | "disabled";

export const emptyRemoteSource = {
  id: 0,
  code: "",
  displayName: "",
  sourceType: "kikoeru_compatible",
  priority: 30,
  enabled: true,
  config: { requestLanguage: "ja-JP" },
  endpoint: {
    baseUrl: "",
    apiUrl: "",
    fallbackUrl: "",
    workUrlTemplate: "/work/{code}",
    restrictOutboundHosts: false,
    allowedHostPatterns: [],
  },
  healthStatus: "unknown",
  lastCheckedAt: null,
} satisfies FileSource;

export function remoteSourceHealth(source: FileSource): RemoteSourceHealth {
  if (!source.enabled) return "disabled";
  if (source.healthStatus === "healthy") return "healthy";
  if (["error", "unavailable"].includes(source.healthStatus)) return "unavailable";
  return "unknown";
}

/** Host shown in compact source rows; the full URL stays in the dialog. */
export function remoteSourceHost(source: FileSource) {
  for (const value of [source.endpoint.baseUrl, source.endpoint.apiUrl]) {
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.host;
    } catch {
      // Fall through to the next configured endpoint.
    }
  }
  return "";
}

export function sourcePayload(source: FileSource) {
  return {
    displayName: source.displayName,
    sourceType: source.sourceType,
    priority: source.priority,
    enabled: source.enabled,
    config: source.config,
    endpoint: source.endpoint,
  };
}

/** Merges a detection result into the draft without discarding typed values. */
export function applyDetectResult(source: FileSource, result: FileSourceDetectResult): FileSource {
  return {
    ...source,
    displayName: source.displayName.trim() || result.displayName,
    sourceType: result.sourceType || source.sourceType,
    endpoint: {
      ...source.endpoint,
      apiUrl: result.detected ? result.apiUrl : source.endpoint.apiUrl,
      baseUrl: source.endpoint.baseUrl.trim() || result.baseUrl,
    },
  };
}

export function storagePathPreview(template: string, sourceCode: string) {
  const workCode = "RJ00000000";
  const normalizedSource = sourceCode.trim() || "source";
  const replacements: Array<[string, string]> = [
    ["<source_name>", normalizedSource],
    ["<source_code>", normalizedSource],
    ["<work_code>", workCode],
    ["<code_prefix>", "RJ"],
    ["<code_group>", "000"],
  ];
  return replacements.reduce(
    (value, [token, replacement]) => value.split(token).join(replacement),
    template.trim() || `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`,
  );
}

export function configuredSourceOrigins(endpoint: FileSource["endpoint"]) {
  const origins = new Set<string>();
  [endpoint.apiUrl, endpoint.baseUrl, endpoint.fallbackUrl].forEach((value) => {
    try {
      const parsed = new URL(value.trim());
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password) {
        origins.add(parsed.origin);
      }
    } catch {
      // Incomplete endpoint input is validated by the server when saved.
    }
  });
  return [...origins];
}
