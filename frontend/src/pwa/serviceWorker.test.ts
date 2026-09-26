import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { serviceWorkerBuildId, stampServiceWorker } from "@/pwa/serviceWorkerBuild";

const worker = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const origin = "https://app.example.test";

type WorkerFetchEvent = { request: Request; respondWith: ReturnType<typeof vi.fn> };

function workerFetch(request: Request) {
  const listeners = new Map<string, (event: WorkerFetchEvent) => void>();
  const response = new Response("Example app asset");
  const network = vi.fn().mockResolvedValue(response);
  const cache = { match: vi.fn().mockResolvedValue(undefined), open: vi.fn() };
  runInNewContext(worker, {
    self: {
      location: { origin },
      addEventListener: (name: string, handler: (event: WorkerFetchEvent) => void) => listeners.set(name, handler),
    },
    URL,
    fetch: network,
    caches: cache,
  });
  const respondWith = vi.fn();
  listeners.get("fetch")!({ request, respondWith });
  return { respondWith, network, cache, response };
}

describe("service worker request boundary", () => {
  it.each([
    { path: "/api/works", method: "GET" },
    { path: "/track.wav", method: "GET", range: "bytes=0-43" },
    { path: "/track.wav", method: "GET", destination: "audio" },
    { path: "/clip.mp4", method: "GET", destination: "video" },
    { path: "/submit", method: "POST" },
    { path: "https://other.example.test/app.js", method: "GET" },
  ])("leaves $method $path $destination $range to the browser", ({ path, method, range, destination }) => {
    const request = new Request(new URL(path, origin), { method, headers: range ? { Range: range } : undefined });
    if (destination) Object.defineProperty(request, "destination", { value: destination });
    const { respondWith, network, cache } = workerFetch(request);
    expect(respondWith).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.open).not.toHaveBeenCalled();
  });

  it("still handles a same-origin static GET and returns the network response on a cache miss", async () => {
    const request = new Request(`${origin}/app.js`);
    const { respondWith, network, cache, response } = workerFetch(request);
    expect(respondWith).toHaveBeenCalledTimes(1);
    await expect(respondWith.mock.calls[0][0]).resolves.toBe(response);
    expect(cache.match).toHaveBeenCalledWith(request);
    expect(network).toHaveBeenCalledWith(request);
  });
});

describe("service worker build cache", () => {
  it("drops the previous build's cache when a new build activates", async () => {
    const buildId = serviceWorkerBuildId("v0.0.0", ["assets/index-example.js"]);
    const listeners = new Map<string, (event: { waitUntil: (work: Promise<unknown>) => void }) => void>();
    const cacheStore = {
      keys: vi.fn().mockResolvedValue(["kikoto-app-v3", `kikoto-app-${buildId}`]),
      delete: vi.fn().mockResolvedValue(true),
    };
    runInNewContext(stampServiceWorker(worker, buildId), {
      self: {
        location: { origin },
        addEventListener: (name: string, handler: (event: { waitUntil: (work: Promise<unknown>) => void }) => void) =>
          listeners.set(name, handler),
        clients: { claim: vi.fn().mockResolvedValue(undefined) },
      },
      caches: cacheStore,
    });
    let activation: Promise<unknown> = Promise.resolve();
    listeners.get("activate")!({ waitUntil: (work) => (activation = work) });
    await activation;
    expect(cacheStore.delete).toHaveBeenCalledTimes(1);
    expect(cacheStore.delete).toHaveBeenCalledWith("kikoto-app-v3");
  });

  it("names a new cache when the emitted assets change", () => {
    const previous = serviceWorkerBuildId("v0.0.0", ["index.html", "assets/index-a.js"]);
    expect(serviceWorkerBuildId("v0.0.0", ["assets/index-a.js", "index.html"])).toBe(previous);
    expect(serviceWorkerBuildId("v0.0.0", ["index.html", "assets/index-b.js"])).not.toBe(previous);
  });

  it("rejects a worker source without exactly one build placeholder", () => {
    expect(() => stampServiceWorker('const CACHE_NAME = "kikoto-app-v3";', "v0.0.0-example")).toThrow();
  });
});
