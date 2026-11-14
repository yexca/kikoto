import { describe, expect, it } from "vitest";

import type { LibrarySource } from "@/lib/api";

import {
  decodeMetadataRunOptions,
  defaultMetadataRunOptions,
  metadataRunPayload,
  usableMetadataRunOptions,
} from "./metadataRunOptions";

describe("Metadata run options", () => {
  it("runs with the fallback and bonus choices the card holds", () => {
    expect(
      metadataRunPayload(
        { remoteMetadataFallback: { enabled: true, sourceIds: [2, 1] }, purchaseBonusAutoLink: false },
        true,
      ),
    ).toEqual({
      scope: "all",
      mode: "full",
      remoteMetadataFallback: { enabled: true, sourceIds: [2, 1] },
      purchaseBonusAutoLink: false,
    });
    expect(metadataRunPayload(defaultMetadataRunOptions, false)).toMatchObject({
      mode: "missing",
      remoteMetadataFallback: { enabled: false, sourceIds: [] },
      purchaseBonusAutoLink: true,
    });
  });

  it("reads stored options defensively and keeps a fallback only with a source", () => {
    expect(decodeMetadataRunOptions("broken")).toEqual(defaultMetadataRunOptions);
    expect(decodeMetadataRunOptions({ remoteMetadataFallback: { enabled: true, sourceIds: [3, 3, -1, "2"] } })).toEqual(
      { remoteMetadataFallback: { enabled: true, sourceIds: [3] }, purchaseBonusAutoLink: true },
    );
    expect(decodeMetadataRunOptions({ remoteMetadataFallback: { enabled: true, sourceIds: [] } })).toMatchObject({
      remoteMetadataFallback: { enabled: false },
    });
  });

  it("leaves out fallback sources that no longer provide metadata", () => {
    const capable = [{ id: 2 }] as LibrarySource[];
    const options = { remoteMetadataFallback: { enabled: true, sourceIds: [1, 2] }, purchaseBonusAutoLink: true };
    expect(usableMetadataRunOptions(options, capable).remoteMetadataFallback).toEqual({
      enabled: true,
      sourceIds: [2],
    });
    expect(usableMetadataRunOptions(options, []).remoteMetadataFallback).toEqual({ enabled: false, sourceIds: [] });
  });
});
