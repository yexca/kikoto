import { describe, expect, it } from "vitest";

import { clientStorageScope, normalizeClientServerIdentity } from "./clientStorageScope";

describe("client storage scope", () => {
  it("normalizes trailing slashes without changing a server path", () => {
    expect(normalizeClientServerIdentity(" https://example.test/kikoto/// ")).toBe("https://example.test/kikoto");
    expect(normalizeClientServerIdentity("  ")).toBe("same-origin");
  });

  it("isolates anonymous and authenticated principals on each server", () => {
    expect(clientStorageScope("https://one.invalid", null)).toBe("https%3A%2F%2Fone.invalid:anonymous");
    expect(clientStorageScope("https://one.invalid", 7)).toBe("https%3A%2F%2Fone.invalid:user-7");
    expect(clientStorageScope("https://two.invalid", 7)).not.toBe(clientStorageScope("https://one.invalid", 7));
  });
});
