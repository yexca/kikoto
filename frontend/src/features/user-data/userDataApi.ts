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

export const userDataApi = {
  /** The versioned personal export, fetched with the session's own credentials. */
  exportData: (signal?: AbortSignal) => apiTransport.getJSON<unknown>("/api/user-data/export", signal),
  previewImport: (request: UserDataImportRequest, signal?: AbortSignal) =>
    apiTransport.sendJSONBody<UserDataImportPreview>("POST", "/api/user-data/import/preview", request, { signal }),
  importData: (request: UserDataImportRequest) =>
    apiTransport.sendJSONBody<UserDataImportResult>("POST", "/api/user-data/import", request),
};
