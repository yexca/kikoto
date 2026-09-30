import { describe, expect, it } from "vitest";

import type { ProxySettings } from "@/lib/api";

import {
  allRoutesEnabled,
  moveProxy,
  proxyAddress,
  proxyConfigDraft,
  proxySettingsPayload,
  removeProxy,
  setAllRoutesEnabled,
  setDirectFallback,
  setRouteSelection,
  setSourceSelection,
  sourceSelection,
  upsertProxy,
} from "./proxyModel";

const settings: ProxySettings = {
  hostAddress: "host.docker.internal",
  proxies: [
    {
      id: "local",
      name: "",
      kind: "host",
      scheme: "socks5",
      host: "",
      port: 1080,
      username: "synthetic-user",
      hasPassword: true,
    },
    {
      id: "lan",
      name: "LAN",
      kind: "custom",
      scheme: "http",
      host: "192.0.2.10",
      port: 8080,
      username: "",
      hasPassword: false,
    },
  ],
  routes: {
    dlsite: { enabled: true, proxyIds: ["lan"] },
    remote: { enabled: true, proxyIds: [] },
    other: { enabled: false, proxyIds: [] },
    sources: { "7": { mode: "proxy", proxyIds: ["lan"] }, "8": { mode: "direct", proxyIds: [] } },
  },
  directFallback: false,
};

describe("proxy configuration draft", () => {
  it("sends a password only when one was typed", () => {
    const draft = proxyConfigDraft(settings);
    expect(proxySettingsPayload(draft).proxies[0]).not.toHaveProperty("password");
    expect(proxySettingsPayload(draft).proxies[0]).not.toHaveProperty("hasPassword");

    const edited = upsertProxy(draft, { ...draft.proxies[0], password: "synthetic-password" });
    expect(proxySettingsPayload(edited).proxies[0].password).toBe("synthetic-password");

    const anonymous = upsertProxy(draft, { ...draft.proxies[0], username: "  " });
    expect(proxySettingsPayload(anonymous).proxies[0]).toMatchObject({ username: "", password: "" });
  });

  it("treats missing selections from the server as every proxy", () => {
    const draft = proxyConfigDraft({
      hostAddress: "host.docker.internal",
      proxies: [],
      routes: {
        dlsite: { enabled: false, proxyIds: null },
        remote: { enabled: false, proxyIds: null },
        other: { enabled: false, proxyIds: null },
        sources: {},
      },
    } as unknown as ProxySettings);
    expect(draft.routes.dlsite).toEqual({ enabled: false, proxyIds: [] });
    expect(sourceSelection(draft.routes, 1)).toBe("inherit");
  });

  it("drops the address of a local-machine proxy and keeps list order on edit", () => {
    const draft = proxyConfigDraft(settings);
    const next = upsertProxy(draft, { ...draft.proxies[0], host: "192.0.2.99", name: " Home " });
    expect(next.proxies.map((proxy) => proxy.id)).toEqual(["local", "lan"]);
    expect(next.proxies[0]).toMatchObject({ host: "", name: "Home" });
    expect(proxyAddress(next.proxies[0], settings.hostAddress)).toBe("host.docker.internal:1080");
    expect(proxyAddress({ kind: "custom", host: "2001:db8::10", port: 3128 }, settings.hostAddress)).toBe(
      "[2001:db8::10]:3128",
    );
  });

  it("sends the direct fallback choice with the proxies", () => {
    const draft = setDirectFallback(proxyConfigDraft(settings), true);
    expect(proxySettingsPayload(draft).directFallback).toBe(true);
    expect(removeProxy(draft, "lan").directFallback).toBe(true);
  });

  it("reorders proxies by priority", () => {
    const draft = proxyConfigDraft(settings);
    expect(moveProxy(draft, "lan", -1).proxies.map((proxy) => proxy.id)).toEqual(["lan", "local"]);
    expect(moveProxy(draft, "lan", 1)).toBe(draft);
  });

  it("removes every reference to a deleted proxy", () => {
    const withoutLan = removeProxy(proxyConfigDraft(settings), "lan");
    expect(withoutLan.routes.dlsite).toEqual({ enabled: true, proxyIds: [] });
    expect(withoutLan.routes.sources["7"]).toEqual({ mode: "proxy", proxyIds: [] });

    const empty = removeProxy(withoutLan, "local");
    expect(allRoutesEnabled(empty.routes)).toBe(false);
    expect(empty.routes.dlsite.enabled || empty.routes.remote.enabled).toBe(false);
    expect(empty.routes.sources).toEqual({ "8": { mode: "direct", proxyIds: [] } });
  });

  it("switches every scope together", () => {
    const draft = proxyConfigDraft(settings);
    expect(allRoutesEnabled(draft.routes)).toBe(false);
    const enabled = setAllRoutesEnabled(draft, true);
    expect(allRoutesEnabled(enabled.routes)).toBe(true);
    expect(enabled.routes.dlsite.proxyIds).toEqual(["lan"]);
    expect(allRoutesEnabled(setAllRoutesEnabled(enabled, false).routes)).toBe(false);
  });

  it("maps route and source overrides to single select values", () => {
    let draft = proxyConfigDraft(settings);
    expect(sourceSelection(draft.routes, 7)).toBe("proxy:lan");
    expect(sourceSelection(draft.routes, 8)).toBe("direct");
    expect(sourceSelection(draft.routes, 9)).toBe("inherit");

    draft = setSourceSelection(draft, 7, "inherit");
    draft = setSourceSelection(draft, 9, "all");
    expect(draft.routes.sources).toEqual({
      "8": { mode: "direct", proxyIds: [] },
      "9": { mode: "proxy", proxyIds: [] },
    });

    draft = setRouteSelection(draft, "dlsite", "all");
    expect(draft.routes.dlsite.proxyIds).toEqual([]);
  });
});
