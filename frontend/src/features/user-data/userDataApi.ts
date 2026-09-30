import { apiTransport } from "@/lib/api";

export type UserDataImportFormat = "kikoto" | "kikoeru";
export type UserDataConflictPolicy = "keep" | "overwrite";

export type UserDataImportRequest = {
  format: UserDataImportFormat;
  data: unknown;
  conflict: UserDataConflictPolicy;
};

export type UserDataImportPreview = {
  works: number;
  playlists: number;
  tags: number;
  matchedWorks: number;
  missingCodes: string[];
  conflicts: number;
  unmatchedProgress: number;
};

export type UserDataImportResult = {
  importedWorks: number;
  skippedWorks: number;
  playlists: number;
  tags: number;
  skippedProgress: number;
};

export type KikoeruImportOptions = {
  sources: { id: number; displayName: string }[];
  /** Whether this account may enter a private or LAN address manually. */
  privateAddressesAllowed: boolean;
};

export type KikoeruAuth =
  { mode: "none" } | { mode: "token"; token: string } | { mode: "password"; name: string; password: string };

export type KikoeruAccountRequest = {
  sourceId?: number;
  url?: string;
  auth: KikoeruAuth;
  acknowledgedRisk: boolean;
  playlistNames: { liked: string; marked: string };
};

export type KikoeruImportSummary = {
  works: number;
  skippedWorks: number;
  playlists: number;
  skippedPlaylistItems: number;
};

/** Account data converted to a Kikoto backup, ready for the normal preview and import. */
export type KikoeruImportResponse = {
  data: unknown;
  summary: KikoeruImportSummary;
  playlistsSupported: boolean;
};

export const userDataApi = {
  /** The versioned personal export, fetched with the session's own credentials. */
  exportData: (signal?: AbortSignal) => apiTransport.getJSON<unknown>("/api/user-data/export", signal),
  previewImport: (request: UserDataImportRequest, signal?: AbortSignal) =>
    apiTransport.sendJSONBody<UserDataImportPreview>("POST", "/api/user-data/import/preview", request, { signal }),
  importData: (request: UserDataImportRequest) =>
    apiTransport.sendJSONBody<UserDataImportResult>("POST", "/api/user-data/import", request),
  kikoeruOptions: (signal?: AbortSignal) =>
    apiTransport.getJSON<KikoeruImportOptions>("/api/user-data/kikoeru/options", signal),
  /** Credentials travel to this server for one request and are never stored. */
  readKikoeruAccount: (request: KikoeruAccountRequest, signal?: AbortSignal) =>
    apiTransport.sendJSONBody<KikoeruImportResponse>("POST", "/api/user-data/kikoeru/account", request, { signal }),
  readKikoeruDatabase: (file: File, userName: string, signal?: AbortSignal) => {
    const body = new FormData();
    body.append("userName", userName);
    body.append("acknowledgedRisk", "true");
    body.append("file", file);
    return apiTransport.sendFormData<KikoeruImportResponse>("/api/user-data/kikoeru/database", body, { signal });
  },
};
