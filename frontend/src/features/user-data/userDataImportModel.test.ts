import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mobileDiagnostics", () => ({ recordApiError: vi.fn() }));

import { ApiError } from "@/lib/api";
import { syntheticWorkCode } from "@/test-support/workCode";

import type { UserDataImportPreview } from "./userDataApi";
import {
  canImport,
  classifyKikoeruDatabaseError,
  classifyKikoeruReadError,
  classifyUserDataRequestError,
  importRequest,
  initialUserDataImportState,
  parseUserDataFileText,
  shouldRequestPreview,
  USER_DATA_IMPORT_MAX_BYTES,
  userDataImportReducer,
  type UserDataImportAction,
  type UserDataImportState,
} from "./userDataImportModel";

const preview: UserDataImportPreview = {
  works: 2,
  playlists: 1,
  tags: 3,
  matchedWorks: 1,
  missingCodes: [syntheticWorkCode("RJ", 2)],
  conflicts: 1,
  unmatchedProgress: 0,
};

const exportData = { format: "kikoto-user-data", version: 1, works: [{ primaryCode: syntheticWorkCode("RJ", 1) }] };

function reduce(actions: UserDataImportAction[], state = initialUserDataImportState()) {
  return actions.reduce(userDataImportReducer, state);
}

function parsedState() {
  const selected = reduce([{ type: "fileSelected", file: { name: "export.json", size: 128 } }]);
  return reduce([{ type: "fileParsed", revision: selected.revision, value: exportData }], selected);
}

function previewedState(): UserDataImportState {
  const parsed = parsedState();
  return reduce(
    [
      { type: "previewStarted", revision: parsed.revision },
      { type: "previewSucceeded", revision: parsed.revision, result: preview },
    ],
    parsed,
  );
}

describe("personal data import state", () => {
  it("defaults to the Kikoto format and keeping existing data", () => {
    const state = initialUserDataImportState();
    expect(state.source).toBe("kikoto");
    expect(state.conflict).toBe("keep");
    expect(canImport(state)).toBe(false);
  });

  it("rejects a file over 10 MiB before reading it", () => {
    const state = reduce([
      { type: "fileSelected", file: { name: "large.json", size: USER_DATA_IMPORT_MAX_BYTES + 1 } },
    ]);
    expect(state.fileError).toBe("too_large");
    expect(state.reading).toBe(false);
    expect(shouldRequestPreview(state)).toBe(false);
  });

  it("ignores a slow read of a file that was already replaced", () => {
    const first = reduce([{ type: "fileSelected", file: { name: "first.json", size: 10 } }]);
    const second = reduce([{ type: "fileSelected", file: { name: "second.json", size: 10 } }], first);
    const stale = reduce([{ type: "fileParsed", revision: first.revision, value: exportData }], second);
    expect(stale.data).toBeNull();
    expect(stale.reading).toBe(true);
  });

  it("previews automatically once the file parses, then allows an explicit import", () => {
    const parsed = parsedState();
    expect(shouldRequestPreview(parsed)).toBe(true);
    expect(canImport(parsed)).toBe(false);

    const ready = previewedState();
    expect(shouldRequestPreview(ready)).toBe(false);
    expect(canImport(ready)).toBe(true);
    expect(importRequest(ready)).toEqual({ format: "kikoto", data: exportData, conflict: "keep" });
  });

  it.each([
    { type: "sourceChanged", source: "kikoeru" },
    { type: "conflictChanged", conflict: "overwrite" },
    { type: "fileSelected", file: { name: "other.json", size: 10 } },
  ] as UserDataImportAction[])("invalidates the preview when the input changes: $type", (change) => {
    const ready = previewedState();
    const changed = userDataImportReducer(ready, change);
    expect(changed.preview).toEqual({ status: "idle" });
    expect(canImport(changed)).toBe(false);
  });

  it("drops a preview response for inputs that changed while it was loading", () => {
    const parsed = parsedState();
    const loading = reduce([{ type: "previewStarted", revision: parsed.revision }], parsed);
    const overwrite = reduce([{ type: "conflictChanged", conflict: "overwrite" }], loading);
    const late = reduce([{ type: "previewSucceeded", revision: loading.revision, result: preview }], overwrite);
    expect(late.preview).toEqual({ status: "idle" });
    expect(shouldRequestPreview(late)).toBe(true);
    expect(importRequest(late)?.conflict).toBe("overwrite");
  });

  it("keeps a failed preview for an explicit retry instead of requesting again automatically", () => {
    const parsed = parsedState();
    const failed = reduce(
      [
        { type: "previewStarted", revision: parsed.revision },
        { type: "previewFailed", revision: parsed.revision, error: "unavailable" },
      ],
      parsed,
    );
    expect(failed.preview).toEqual({ status: "error", revision: parsed.revision, error: "unavailable" });
    expect(shouldRequestPreview(failed)).toBe(false);
    const retried = reduce([{ type: "previewStarted", revision: failed.revision }], failed);
    expect(retried.preview.status).toBe("loading");
  });

  it("locks inputs while importing and consumes the preview on success", () => {
    const ready = previewedState();
    const running = reduce([{ type: "importStarted", revision: ready.revision }], ready);
    expect(reduce([{ type: "conflictChanged", conflict: "overwrite" }], running).conflict).toBe("keep");
    expect(canImport(running)).toBe(false);

    const result = { importedWorks: 1, skippedWorks: 1, playlists: 1, tags: 3, skippedProgress: 0 };
    const done = reduce([{ type: "importSucceeded", revision: ready.revision, result }], running);
    expect(done.result).toEqual(result);
    expect(canImport(done)).toBe(false);
    expect(shouldRequestPreview(done)).toBe(false);
  });

  it("keeps the preview after a failed import so the same import can be retried", () => {
    const ready = previewedState();
    const failed = reduce(
      [
        { type: "importStarted", revision: ready.revision },
        { type: "importFailed", revision: ready.revision, error: "unavailable" },
      ],
      ready,
    );
    expect(failed.importing).toEqual({ status: "error", error: "unavailable" });
    expect(canImport(failed)).toBe(true);
  });

  it("keeps a selected file across file formats but not into an account read", () => {
    const kikoeru = reduce([{ type: "sourceChanged", source: "kikoeru" }], parsedState());
    expect(kikoeru.data).toEqual({ value: exportData });
    expect(shouldRequestPreview(kikoeru)).toBe(true);
    expect(importRequest(kikoeru)?.format).toBe("kikoeru");

    const account = reduce([{ type: "sourceChanged", source: "kikoeruAccount" }], kikoeru);
    expect(account.data).toBeNull();
    expect(account.file).toBeNull();
    expect(reduce([{ type: "fileSelected", file: { name: "export.json", size: 10 } }], account).file).toBeNull();
  });

  it("previews account data as a Kikoto backup and forgets it when the source changes", () => {
    const summary = { works: 1, skippedWorks: 0, playlists: 0, skippedPlaylistItems: 0 };
    const response = { data: exportData, summary, playlistsSupported: false };
    const database = reduce([{ type: "sourceChanged", source: "kikoeruDatabase" }]);
    const loaded = reduce([{ type: "remoteLoaded", response }], database);
    expect(loaded.remote).toEqual({ summary, playlistsSupported: false });
    expect(shouldRequestPreview(loaded)).toBe(true);
    expect(importRequest(loaded)).toEqual({ format: "kikoto", data: exportData, conflict: "keep" });

    const switched = reduce([{ type: "sourceChanged", source: "kikoeruAccount" }], loaded);
    expect(switched.data).toBeNull();
    expect(switched.remote).toBeNull();
    // A late account read cannot replace a file chosen in the meantime.
    expect(reduce([{ type: "remoteLoaded", response }], parsedState()).remote).toBeNull();
  });

  it("maps Kikoeru read failures to sanitized classes", () => {
    const detail = "upstream detail near synthetic-token";
    expect(classifyKikoeruReadError(new ApiError(detail, 422, "kikoeru_unauthorized"))).toBe("unauthorized");
    expect(classifyKikoeruReadError(new ApiError(detail, 403, "kikoeru_destination_not_allowed"))).toBe("destination");
    expect(classifyKikoeruReadError(new ApiError(detail, 404, "kikoeru_user_not_found"))).toBe("user_not_found");
    expect(classifyKikoeruReadError(new ApiError(detail, 403))).toBe("permission");
    expect(classifyKikoeruReadError(new ApiError(detail, 413, "personal_data_limit"))).toBe("too_large");
    expect(classifyKikoeruReadError(new ApiError(detail, 502, "kikoeru_unavailable"))).toBe("unavailable");
    expect(classifyKikoeruReadError(new TypeError(detail))).toBe("unavailable");
  });

  it("reports a failed database upload as an upload problem, not as an unreachable Kikoeru server", () => {
    const detail = "upload detail";
    expect(classifyKikoeruDatabaseError(new ApiError(detail, 408, "kikoeru_upload_interrupted", true))).toBe(
      "upload_interrupted",
    );
    expect(classifyKikoeruDatabaseError(new ApiError(detail, 400, "kikoeru_upload_invalid"))).toBe("upload_invalid");
    expect(classifyKikoeruDatabaseError(new ApiError(detail, 503, "kikoeru_database_timeout", true))).toBe(
      "database_timeout",
    );
    expect(classifyKikoeruDatabaseError(new TypeError("Failed to fetch"))).toBe("upload_failed");
    expect(classifyKikoeruDatabaseError(new ApiError(detail, 502))).toBe("upload_failed");
    // Answers about the file itself keep their own explanation.
    expect(classifyKikoeruDatabaseError(new ApiError(detail, 400, "kikoeru_database_invalid"))).toBe(
      "database_invalid",
    );
    expect(classifyKikoeruDatabaseError(new ApiError(detail, 404, "kikoeru_user_not_found"))).toBe("user_not_found");
    expect(classifyKikoeruDatabaseError(new ApiError(detail, 413, "personal_data_limit"))).toBe("too_large");
  });

  it("accepts only JSON objects or arrays from the file", () => {
    expect(parseUserDataFileText(JSON.stringify(exportData))).toEqual({ ok: true, value: exportData });
    expect(parseUserDataFileText("[]")).toEqual({ ok: true, value: [] });
    expect(parseUserDataFileText("42")).toEqual({ ok: false });
    expect(parseUserDataFileText("{broken")).toEqual({ ok: false });
  });

  it("maps request failures to sanitized classes without server text", () => {
    const detail = "unexpected value near synthetic-token";
    expect(classifyUserDataRequestError(new ApiError(detail, 400, "invalid_request"))).toBe("invalid");
    expect(classifyUserDataRequestError(new ApiError(detail, 413))).toBe("too_large");
    expect(classifyUserDataRequestError(new ApiError(detail, 403))).toBe("permission");
    expect(classifyUserDataRequestError(new ApiError(detail, 403, "demo_read_only"))).toBe("read_only");
    expect(classifyUserDataRequestError(new ApiError(detail, 503))).toBe("unavailable");
    expect(classifyUserDataRequestError(new TypeError(detail))).toBe("unavailable");
  });
});
