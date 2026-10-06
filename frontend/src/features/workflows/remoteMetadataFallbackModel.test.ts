import { describe, expect, it } from "vitest";

import type { FileSource } from "@/lib/api";
import {
  moveRemoteMetadataSource,
  normalizedRemoteMetadataFallback,
  remoteMetadataFallbackRows,
  sameRemoteMetadataFallback,
  toggleRemoteMetadataSource,
} from "./remoteMetadataFallbackModel";

function source(id: number, priority: number, overrides: Partial<FileSource> = {}): FileSource {
  return {
    id,
    code: `example_remote_${id}`,
    displayName: `Example Remote ${id}`,
    sourceType: "kikoeru_compatible",
    priority,
    enabled: true,
    config: {},
    endpoint: {
      baseUrl: "https://source.example.invalid",
      apiUrl: "https://source.example.invalid",
      fallbackUrl: "",
      workUrlTemplate: "/work/{code}",
      restrictOutboundHosts: false,
      allowedHostPatterns: [],
    },
    healthStatus: "unknown",
    lastCheckedAt: null,
    ...overrides,
  };
}

const sources = [
  source(1, 30),
  source(2, 10),
  source(3, 20, { config: { capabilities: [] } }),
  source(4, 5, { sourceType: "local_folder" }),
  source(5, 40),
];

describe("remoteMetadataFallbackRows", () => {
  it("lists selected capable sources in fallback order, then the rest by priority", () => {
    const rows = remoteMetadataFallbackRows(sources, { enabled: true, sourceIds: [5, 3, 1, 99] });
    expect(rows.map((row) => [row.source.id, row.selected])).toEqual([
      [5, true],
      [1, true],
      [2, false],
    ]);
  });

  it("treats only switch or order changes as a change", () => {
    expect(sameRemoteMetadataFallback({ enabled: true, sourceIds: [1, 2] }, { enabled: true, sourceIds: [1, 2] })).toBe(
      true,
    );
    expect(sameRemoteMetadataFallback({ enabled: true, sourceIds: [2, 1] }, { enabled: true, sourceIds: [1, 2] })).toBe(
      false,
    );
    expect(sameRemoteMetadataFallback({ enabled: false, sourceIds: [] }, { enabled: true, sourceIds: [] })).toBe(false);
  });

  it("drops sources that no longer provide metadata before saving", () => {
    expect(normalizedRemoteMetadataFallback(sources, { enabled: true, sourceIds: [3, 2, 2, 4] })).toEqual({
      enabled: true,
      sourceIds: [2],
    });
  });
});

describe("fallback order edits", () => {
  it("appends a newly selected source and removes a cleared one", () => {
    const selected = toggleRemoteMetadataSource({ enabled: true, sourceIds: [1] }, 2, true);
    expect(selected.sourceIds).toEqual([1, 2]);
    expect(toggleRemoteMetadataSource(selected, 1, false).sourceIds).toEqual([2]);
  });

  it("moves a source within the order without leaving its bounds", () => {
    const settings = { enabled: true, sourceIds: [1, 2, 5] };
    expect(moveRemoteMetadataSource(settings, 5, -1).sourceIds).toEqual([1, 5, 2]);
    expect(moveRemoteMetadataSource(settings, 1, -1)).toBe(settings);
    expect(moveRemoteMetadataSource(settings, 5, 1)).toBe(settings);
  });
});
