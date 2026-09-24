import type { MetadataSyncOptions } from "@/lib/api";

/**
 * Metadata sync maintains works that already exist. The scope selects every
 * work, one circle's works, or one voice actor's works; the mode refreshes only
 * missing or stale metadata, or every selected work.
 */
export const METADATA_SYNC_SCOPES = ["all", "circle", "voice"] as const;
export type MetadataSyncScope = (typeof METADATA_SYNC_SCOPES)[number];
export const METADATA_SYNC_MODES = ["missing", "full"] as const;
export type MetadataSyncMode = (typeof METADATA_SYNC_MODES)[number];

export type MetadataSyncFormValues = {
  scope: MetadataSyncScope;
  circleId: string;
  personId: string;
  /** Form-only: the picked voice actor's display name. */
  personName: string;
  mode: MetadataSyncMode;
};

export type MetadataSyncBlocker = "circle_required" | "voice_required";

const circleIdPattern = /^[RBV]G\d{5,8}$/i;

export function metadataSyncDefaultValues(): MetadataSyncFormValues {
  return { scope: "all", circleId: "", personId: "", personName: "", mode: "missing" };
}

/** Restores form values from a stored trigger config or run input. */
export function metadataSyncValuesFromConfig(config: unknown): MetadataSyncFormValues {
  const values = metadataSyncDefaultValues();
  if (!config || typeof config !== "object" || Array.isArray(config)) return values;
  const record = config as Record<string, unknown>;
  if (METADATA_SYNC_SCOPES.includes(record.scope as MetadataSyncScope))
    values.scope = record.scope as MetadataSyncScope;
  if (METADATA_SYNC_MODES.includes(record.mode as MetadataSyncMode)) values.mode = record.mode as MetadataSyncMode;
  if (typeof record.circleId === "string") values.circleId = record.circleId;
  if (typeof record.personId === "number" && record.personId > 0) values.personId = String(record.personId);
  return values;
}

export function metadataSyncPayload(values: MetadataSyncFormValues): MetadataSyncOptions {
  const payload: MetadataSyncOptions = { scope: values.scope, mode: values.mode };
  if (values.scope === "circle") payload.circleId = values.circleId.trim().toUpperCase();
  if (values.scope === "voice") payload.personId = Number(values.personId);
  return payload;
}

export function metadataSyncBlockers(values: MetadataSyncFormValues): MetadataSyncBlocker[] {
  if (values.scope === "circle" && !circleIdPattern.test(values.circleId.trim())) return ["circle_required"];
  if (values.scope === "voice" && !(Number(values.personId) > 0)) return ["voice_required"];
  return [];
}
