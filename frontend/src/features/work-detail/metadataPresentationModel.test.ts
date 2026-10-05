import { describe, expect, it } from "vitest";

import type { WorkMetadataPresentation } from "@/lib/api";
import {
  metadataSourceGroups,
  metadataVariantLabel,
  orderedMetadataVariants,
  resolveMetadataVariant,
} from "./metadataPresentationModel";

const presentation: WorkMetadataPresentation = {
  defaultVariantKey: "RJ00000051",
  variants: [
    { key: "RJ00000050", language: "ja-jp", title: "Origin", tags: ["Origin tag"], origin: true },
    { key: "RJ00000051", language: "en-us", title: "English", tags: ["English tag"], origin: false },
  ],
};

describe("resolveMetadataVariant", () => {
  it("uses the configured default without a temporary selection", () => {
    expect(resolveMetadataVariant(presentation, "")?.key).toBe("RJ00000051");
  });

  it("uses a temporary selection and falls back when it disappears", () => {
    expect(resolveMetadataVariant(presentation, "RJ00000050")?.title).toBe("Origin");
    expect(resolveMetadataVariant(presentation, "missing")?.key).toBe("RJ00000051");
  });

  it("orders Origin first without changing the configured default", () => {
    const unsorted: WorkMetadataPresentation = {
      defaultVariantKey: "RJ00000051",
      variants: [
        { key: "RJ00000051", language: "en-us", title: "English", tags: [], origin: false },
        { key: "RJ00000050", language: "ja-jp", title: "Origin", tags: [], origin: true },
      ],
    };
    expect(orderedMetadataVariants(unsorted.variants).map((variant) => variant.key)).toEqual([
      "RJ00000050",
      "RJ00000051",
    ]);
    expect(resolveMetadataVariant(unsorted, "")?.key).toBe("RJ00000051");
  });
});

describe("metadataVariantLabel", () => {
  const labels = {
    original: "Original",
    language: (value: string) => ({ "ja-jp": "Japanese", "en-us": "English" })[value] ?? (value || "Unknown language"),
  };

  it("shows only Original when the original edition declares no language", () => {
    const variants = [
      { key: "RJ00000050", language: "", title: "Origin", tags: [], origin: true },
      { key: "RJ00000051", language: "en-us", title: "English", tags: [], origin: false },
    ];
    expect(metadataVariantLabel(variants[0], variants, labels)).toBe("Original");
    expect(metadataVariantLabel(variants[1], variants, labels)).toBe("English");
  });

  it("keeps declared and unknown labels for the other editions", () => {
    const variants = [
      { key: "RJ00000050", language: "ja-jp", title: "Origin", tags: [], origin: true },
      { key: "RJ00000051", language: "", title: "Undeclared", tags: [], origin: false },
    ];
    expect(metadataVariantLabel(variants[0], variants, labels)).toBe("Original · Japanese");
    expect(metadataVariantLabel(variants[1], variants, labels)).toBe("Unknown language");
  });
});

describe("metadataSourceGroups", () => {
  it("groups each remote source's fields in the server order", () => {
    expect(
      metadataSourceGroups([
        { field: "title", source: "Example Remote A" },
        { field: "circle", source: "Example Remote B" },
        { field: "tags", source: "Example Remote A" },
      ]),
    ).toEqual([
      { source: "Example Remote A", fields: ["title", "tags"] },
      { source: "Example Remote B", fields: ["circle"] },
    ]);
    expect(metadataSourceGroups(null)).toEqual([]);
  });
});
