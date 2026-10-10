import { ApiError } from "@/lib/api";

import type {
  KikoeruImportResponse,
  UserDataConflictPolicy,
  UserDataImportFormat,
  UserDataImportPreview,
  UserDataImportRequest,
  UserDataImportResult,
} from "./userDataApi";

export const USER_DATA_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Where imported data comes from: a JSON file in either format, a Kikoeru
 * account read by the server, or an uploaded Kikoeru database. The last two
 * arrive as a Kikoto backup and use the same preview and import.
 */
export type UserDataImportSource = UserDataImportFormat | "kikoeruAccount" | "kikoeruDatabase";

export const userDataImportSources: readonly UserDataImportSource[] = [
  "kikoto",
  "kikoeru",
  "kikoeruAccount",
  "kikoeruDatabase",
];

export function isFileImportSource(source: UserDataImportSource): source is UserDataImportFormat {
  return source === "kikoto" || source === "kikoeru";
}
export const userDataConflictPolicies: readonly UserDataConflictPolicy[] = ["keep", "overwrite"];

/**
 * How a Kikoeru import maps each progress status to a Kikoto listening status,
 * mirroring the server's import mapping; shown to the user before an import.
 */
export const kikoeruStatusMapping = [
  ["marked", "want_to_listen"],
  ["listening", "listening"],
  ["listened", "finished"],
  ["replay", "relisten"],
  ["postponed", "paused"],
  ["null", "none"],
] as const;

export type UserDataFileError = "too_large" | "invalid_json" | "unreadable";

/** Sanitized failure classes; the page never shows server or file text. */
export type UserDataRequestError = "invalid" | "too_large" | "permission" | "read_only" | "unavailable";

export type UserDataFile = { name: string; size: number };

/** Sanitized failure classes for reading a Kikoeru account or database. */
export type KikoeruReadError =
  | "invalid"
  | "risk"
  | "unauthorized"
  | "destination"
  | "source_missing"
  | "unsupported"
  | "user_not_found"
  | "database_invalid"
  | "too_large"
  | "busy"
  | "timeout"
  | "permission"
  | "read_only"
  | "unavailable"
  | "upload_invalid"
  | "upload_interrupted"
  | "upload_failed"
  | "database_timeout";

export type UserDataImportState = {
  source: UserDataImportSource;
  conflict: UserDataConflictPolicy;
  file: UserDataFile | null;
  /** Parsed JSON, present only once the whole file was read and parsed. */
  data: { value: unknown } | null;
  /** What a Kikoeru account or database read returned, when data came from one. */
  remote: Omit<KikoeruImportResponse, "data"> | null;
  reading: boolean;
  fileError: UserDataFileError | null;
  /** Bumped by every file, format, or policy change; older responses are ignored. */
  revision: number;
  preview:
    | { status: "idle" }
    | { status: "loading"; revision: number }
    | { status: "ready"; revision: number; result: UserDataImportPreview }
    | { status: "error"; revision: number; error: UserDataRequestError };
  importing:
    { status: "idle" } | { status: "running"; revision: number } | { status: "error"; error: UserDataRequestError };
  result: UserDataImportResult | null;
};

export type UserDataImportAction =
  | { type: "fileSelected"; file: UserDataFile }
  | { type: "fileRejected"; revision: number; error: UserDataFileError }
  | { type: "fileParsed"; revision: number; value: unknown }
  | { type: "sourceChanged"; source: UserDataImportSource }
  | { type: "remoteLoaded"; response: KikoeruImportResponse }
  | { type: "conflictChanged"; conflict: UserDataConflictPolicy }
  | { type: "previewStarted"; revision: number }
  | { type: "previewSucceeded"; revision: number; result: UserDataImportPreview }
  | { type: "previewFailed"; revision: number; error: UserDataRequestError }
  | { type: "importStarted"; revision: number }
  | { type: "importSucceeded"; revision: number; result: UserDataImportResult }
  | { type: "importFailed"; revision: number; error: UserDataRequestError }
  | { type: "cleared" };

export function initialUserDataImportState(): UserDataImportState {
  return {
    source: "kikoto",
    conflict: "keep",
    file: null,
    data: null,
    remote: null,
    reading: false,
    fileError: null,
    revision: 0,
    preview: { status: "idle" },
    importing: { status: "idle" },
    result: null,
  };
}

function invalidated(state: UserDataImportState, changes: Partial<UserDataImportState>): UserDataImportState {
  return {
    ...state,
    ...changes,
    revision: state.revision + 1,
    preview: { status: "idle" },
    importing: { status: "idle" },
    result: null,
  };
}

export function userDataImportReducer(state: UserDataImportState, action: UserDataImportAction): UserDataImportState {
  switch (action.type) {
    case "fileSelected":
      if (state.importing.status === "running" || !isFileImportSource(state.source)) return state;
      if (action.file.size > USER_DATA_IMPORT_MAX_BYTES) {
        return invalidated(state, { file: action.file, data: null, reading: false, fileError: "too_large" });
      }
      return invalidated(state, { file: action.file, data: null, reading: true, fileError: null });
    case "fileRejected":
      if (action.revision !== state.revision) return state;
      return { ...state, data: null, reading: false, fileError: action.error };
    case "fileParsed":
      if (action.revision !== state.revision) return state;
      return { ...state, data: { value: action.value }, reading: false, fileError: null };
    case "sourceChanged": {
      if (state.importing.status === "running" || action.source === state.source) return state;
      // A file can be read in either file format; account data belongs to its reader.
      const keepFile = isFileImportSource(state.source) && isFileImportSource(action.source);
      return invalidated(state, {
        source: action.source,
        ...(keepFile ? {} : { file: null, data: null, reading: false, fileError: null }),
        remote: null,
      });
    }
    case "remoteLoaded": {
      if (state.importing.status === "running" || isFileImportSource(state.source)) return state;
      const { data, ...remote } = action.response;
      return invalidated(state, { file: null, data: { value: data }, reading: false, fileError: null, remote });
    }
    case "conflictChanged":
      if (state.importing.status === "running" || action.conflict === state.conflict) return state;
      return invalidated(state, { conflict: action.conflict });
    case "previewStarted":
      if (action.revision !== state.revision || !state.data) return state;
      return { ...state, preview: { status: "loading", revision: action.revision } };
    case "previewSucceeded":
      if (!matchesPreview(state, action.revision, "loading")) return state;
      return { ...state, preview: { status: "ready", revision: action.revision, result: action.result } };
    case "previewFailed":
      if (!matchesPreview(state, action.revision, "loading")) return state;
      return { ...state, preview: { status: "error", revision: action.revision, error: action.error } };
    case "importStarted":
      if (!canImport(state) || action.revision !== state.revision) return state;
      return { ...state, importing: { status: "running", revision: action.revision }, result: null };
    case "importSucceeded":
      if (state.importing.status !== "running" || state.importing.revision !== action.revision) return state;
      // An applied import consumes its preview; importing again needs a new preview.
      return { ...state, importing: { status: "idle" }, preview: { status: "idle" }, result: action.result };
    case "importFailed":
      if (state.importing.status !== "running" || state.importing.revision !== action.revision) return state;
      return { ...state, importing: { status: "error", error: action.error } };
    case "cleared":
      if (state.importing.status === "running") return state;
      return invalidated(state, { file: null, data: null, reading: false, fileError: null, remote: null });
  }
}

function matchesPreview(state: UserDataImportState, revision: number, status: "loading") {
  return state.revision === revision && state.preview.status === status && state.preview.revision === revision;
}

/** The preview is automatic once a file parses; it waits for a retry after a failure. */
export function shouldRequestPreview(state: UserDataImportState) {
  return (
    Boolean(state.data) && state.preview.status === "idle" && state.importing.status !== "running" && !state.result
  );
}

export function canImport(state: UserDataImportState) {
  return (
    Boolean(state.data) &&
    state.preview.status === "ready" &&
    state.preview.revision === state.revision &&
    state.importing.status !== "running"
  );
}

export function importRequest(state: UserDataImportState): UserDataImportRequest | null {
  if (!state.data) return null;
  const format = isFileImportSource(state.source) ? state.source : "kikoto";
  return { format, data: state.data.value, conflict: state.conflict };
}

export function parseUserDataFileText(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? { ok: true, value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function classifyUserDataRequestError(error: unknown): UserDataRequestError {
  if (!(error instanceof ApiError)) return "unavailable";
  if (error.code === "demo_read_only") return "read_only";
  if (error.status === 401 || error.status === 403) return "permission";
  if (error.status === 413) return "too_large";
  if (error.status === 400 || error.status === 409 || error.status === 422) return "invalid";
  return "unavailable";
}

const kikoeruErrorCodes: Record<string, KikoeruReadError> = {
  kikoeru_invalid_request: "invalid",
  kikoeru_risk_not_acknowledged: "risk",
  kikoeru_unauthorized: "unauthorized",
  kikoeru_destination_not_allowed: "destination",
  kikoeru_source_not_found: "source_missing",
  kikoeru_unsupported: "unsupported",
  kikoeru_user_not_found: "user_not_found",
  kikoeru_database_invalid: "database_invalid",
  kikoeru_import_busy: "busy",
  kikoeru_timeout: "timeout",
  kikoeru_upload_invalid: "upload_invalid",
  kikoeru_upload_interrupted: "upload_interrupted",
  kikoeru_database_timeout: "database_timeout",
  demo_read_only: "read_only",
};

export function classifyKikoeruReadError(error: unknown): KikoeruReadError {
  if (!(error instanceof ApiError)) return "unavailable";
  const known = kikoeruErrorCodes[error.code];
  if (known) return known;
  if (error.status === 401 || error.status === 403) return "permission";
  if (error.status === 413) return "too_large";
  if (error.status === 400) return "invalid";
  return "unavailable";
}

/**
 * Classifies a failed database upload. No Kikoeru server is involved, so a
 * failure without a specific answer is about the upload itself: a dropped
 * connection or an unexpected server error.
 */
export function classifyKikoeruDatabaseError(error: unknown): KikoeruReadError {
  const known = classifyKikoeruReadError(error);
  return known === "unavailable" || known === "invalid" ? "upload_failed" : known;
}

/** A file name for the downloaded export; the date is local and carries no server detail. */
export function userDataExportFileName(now = new Date()) {
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
  return `kikoto-user-data-${date}.json`;
}
