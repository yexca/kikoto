import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mobileDiagnostics", () => ({ recordApiError: vi.fn() }));

import { ApiError } from "@/lib/api";
import { syntheticWorkCode } from "@/test-support/workCode";

import type { UserDataImportPreview } from "./userDataApi";
import {
  canImport,
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
    expect(state.format).toBe("kikoto");
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
    { type: "formatChanged", format: "kikoeru" },
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
