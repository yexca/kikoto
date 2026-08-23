import { describe, expect, it } from "vitest";

import type { WorkMetadataPresentation } from "@/lib/api";
import { orderedMetadataVariants, resolveMetadataVariant } from "./metadataPresentationModel";

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
