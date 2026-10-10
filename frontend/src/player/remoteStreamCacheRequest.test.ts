import { describe, expect, it } from "vitest";

import { remoteStreamCacheRequest } from "./remoteStreamCacheRequest";

const listener = { cacheLocation: false, cacheRemoteWork: false };
const contributor = { cacheLocation: true, cacheRemoteWork: true };
const remoteOnly = {
  locationType: "remote_stream",
  locationId: 0,
  remoteSourceId: 7,
  remoteWorkCode: "RJ00000000",
  remotePath: "track.mp3",
};

describe("remoteStreamCacheRequest", () => {
  it("never asks to cache for an account without the remote permissions", () => {
    expect(remoteStreamCacheRequest({ ...remoteOnly, locationId: 12 }, listener)).toBeNull();
    expect(remoteStreamCacheRequest(remoteOnly, listener)).toBeNull();
  });

  it("caches a Library location with remote:fetch alone", () => {
    expect(
      remoteStreamCacheRequest({ ...remoteOnly, locationId: 12 }, { cacheLocation: true, cacheRemoteWork: false }),
    ).toMatchObject({ kind: "location", locationId: 12 });
  });

  it("caches a work not in the Library only when the account may also track it", () => {
    expect(remoteStreamCacheRequest(remoteOnly, { cacheLocation: true, cacheRemoteWork: false })).toBeNull();
    expect(remoteStreamCacheRequest(remoteOnly, contributor)).toMatchObject({
      kind: "remote_work",
      sourceId: 7,
      workCode: "RJ00000000",
      path: "track.mp3",
    });
  });

  it("ignores tracks that do not stream from a remote source", () => {
    expect(remoteStreamCacheRequest({ ...remoteOnly, locationType: "local", locationId: 12 }, contributor)).toBeNull();
  });
});
