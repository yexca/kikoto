import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clearStoredSessionToken = vi.hoisted(() => vi.fn());
const getStoredServerURL = vi.hoisted(() => vi.fn(() => ""));
const getStoredSessionToken = vi.hoisted(() => vi.fn(() => ""));
const isNativeApp = vi.hoisted(() => vi.fn(() => false));
const recordApiError = vi.hoisted(() => vi.fn());
const setStoredSessionToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/serverConfig", () => ({
  clearStoredSessionToken,
  getStoredServerURL,
  getStoredSessionToken,
  isNativeApp,
  setStoredSessionToken,
}));
vi.mock("@/lib/mobileDiagnostics", () => ({ recordApiError }));

import { api, ApiError, assetURL, mediaDownloadURL } from "./api";
import { apiSessionVersion, changeApiSession, observeApiPrincipal } from "./apiSession";
import { setDemoMetadataLanguageUser, writeDemoMetadataLanguages } from "./demoMetadataLanguages";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("API client transport", () => {
  beforeEach(() => {
    changeApiSession();
    clearStoredSessionToken.mockReset();
    getStoredServerURL.mockReset();
    getStoredServerURL.mockReturnValue("");
    getStoredSessionToken.mockReset();
    getStoredSessionToken.mockReturnValue("");
    isNativeApp.mockReset();
    isNativeApp.mockReturnValue(false);
    recordApiError.mockReset();
    setStoredSessionToken.mockReset();
    setStoredSessionToken.mockResolvedValue(undefined);
    clearStoredSessionToken.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("checks the selected server without credentials or redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ok", version: "0.4.1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.health("https://server.example.invalid/kikoto")).resolves.toMatchObject({ status: "ok" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://server.example.invalid/kikoto/health");
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
    expect(assetURL("/assets/example-cover.jpg")).toBe("/assets/example-cover.jpg");
    expect(mediaDownloadURL(7)).toBe("/api/media/7/download");
  });

  it("sends a Demo visitor's browser-local metadata language with authenticated requests", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", { location: { origin: "https://demo.example.invalid" } });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    const fetchMock = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(url.endsWith("/health") ? { status: "ok" } : [])),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      setDemoMetadataLanguageUser(7);
      writeDemoMetadataLanguages(["zh-cn", "origin"]);
      await api.listUsers();
      await api.health("https://server.example.invalid");
      // A reload restores the choice from this browser.
      setDemoMetadataLanguageUser(null);
      setDemoMetadataLanguageUser(7);
      await api.listUsers();
      writeDemoMetadataLanguages(null);
      await api.listUsers();
      writeDemoMetadataLanguages(["en-us", "origin"]);
      setDemoMetadataLanguageUser(null);
      await api.listUsers();
    } finally {
      setDemoMetadataLanguageUser(null);
    }

    const headers = fetchMock.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get("X-Kikoto-Metadata-Languages"),
    );
    expect(headers).toEqual(["zh-cn,origin", null, "zh-cn,origin", null, null]);
  });

  it("does not send the old native session to a candidate server", async () => {
    isNativeApp.mockReturnValue(true);
    getStoredServerURL.mockReturnValue("https://old.example.invalid");
    getStoredSessionToken.mockReturnValue("synthetic-token");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await api.health("https://new.example.invalid");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://new.example.invalid/health");
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
    expect(init.credentials).toBe("omit");
  });

  it("uses native bearer authentication and preserves it while updating the session", async () => {
    isNativeApp.mockReturnValue(true);
    getStoredServerURL.mockReturnValue("https://mobile.example.invalid/kikoto");
    getStoredSessionToken.mockReturnValue("synthetic-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse({ authenticated: true, user: { id: 1 }, sessionToken: "synthetic-new-token" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await api.listUsers();
    await api.login("synthetic-user", "synthetic-password");

    const [listURL, listInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(listURL).toBe("https://mobile.example.invalid/kikoto/api/users");
    expect(listInit.credentials).toBe("omit");
    const headers = new Headers(listInit.headers);
    expect(headers.get("X-Kikoto-Mobile")).toBe("1");
    expect(headers.get("Authorization")).toBe("Bearer synthetic-token");

    const [loginURL, loginInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(loginURL).toBe("https://mobile.example.invalid/kikoto/api/auth/login");
    expect(loginInit.method).toBe("POST");
    expect(loginInit.body).toBe(JSON.stringify({ username: "synthetic-user", password: "synthetic-password" }));
    expect(setStoredSessionToken).toHaveBeenCalledWith("synthetic-new-token");
  });

  it("waits for native credential synchronization before completing login", async () => {
    isNativeApp.mockReturnValue(true);
    getStoredServerURL.mockReturnValue("https://mobile.example.invalid/kikoto");
    const nextSessionValue = ["new", "synthetic", "value"].join("-");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ authenticated: true, user: { id: 1 }, [["session", "Token"].join("")]: nextSessionValue }),
      );
    vi.stubGlobal("fetch", fetchMock);
    let releaseCredentialWrite = () => {};
    setStoredSessionToken.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseCredentialWrite = resolve;
      }),
    );

    let settled = false;
    const login = api.login("synthetic-user", "synthetic-password").then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(setStoredSessionToken).toHaveBeenCalledOnce());

    expect(settled).toBe(false);
    releaseCredentialWrite();
    await expect(login).resolves.toMatchObject({ authenticated: true });
  });

  it("retains structured API failures and clears a native session after logout failure", async () => {
    isNativeApp.mockReturnValue(true);
    getStoredServerURL.mockReturnValue("https://mobile.example.invalid");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "Remote service is unavailable.", code: "unavailable", retryable: true }, 503),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.logout()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      code: "unavailable",
      retryable: true,
    } satisfies Partial<ApiError>);

    expect(clearStoredSessionToken).toHaveBeenCalledOnce();
    expect(recordApiError).toHaveBeenCalledWith({
      method: "HTTP",
      path: "POST /api/auth/logout failed with 503",
      status: 503,
      message: "Remote service is unavailable.",
    });
  });

  it("builds the remote detail from independently fetched metadata and tracks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ remoteCode: "RJ00000001", title: "Example Work" }))
      .mockResolvedValueOnce(jsonResponse({ tracks: [{ title: "Example track" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getRemoteSourceWork(7, "RJ 00000000")).resolves.toMatchObject({
      remoteCode: "RJ00000001",
      title: "Example Work",
      tracks: [{ title: "Example track" }],
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/remote-sources/7/works/RJ%2000000000",
      "/api/remote-sources/7/works/RJ00000001/tracks",
    ]);
  });

  it("shares one in-flight runtime settings request without sharing an abort", async () => {
    let respond: (response: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (respond = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const aborted = new AbortController();

    const first = api.getRuntimeSettings();
    const detached = api.getRuntimeSettings(aborted.signal);
    const second = api.getRuntimeSettings(new AbortController().signal);
    aborted.abort();
    respond(jsonResponse({ mode: "production", cacheEnabled: true }));

    await expect(detached).rejects.toMatchObject({ name: "AbortError" });
    await expect(first).resolves.toMatchObject({ cacheEnabled: true });
    await expect(second).resolves.toMatchObject({ cacheEnabled: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementationOnce(() => Promise.resolve(jsonResponse({ mode: "production", cacheEnabled: false })));
    await expect(api.getRuntimeSettings()).resolves.toMatchObject({ cacheEnabled: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an edition and unrelated settings read alive during a progress save", async () => {
    const directory = deferred<Response>();
    const runtime = deferred<Response>();
    const write = deferred<Response>();
    const fetchMock = vi.fn((url: string, _init: RequestInit) => {
      if (url === "/api/works/2") return directory.promise;
      if (url === "/api/runtime-settings") return runtime.promise;
      return write.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const edition = api.getWork(2);
    const settings = api.getRuntimeSettings();
    const saving = api.updateMediaProgress(1, {
      locationId: 1,
      positionSeconds: 10,
      durationSeconds: 60,
      completed: false,
    });
    const joinedSettings = api.getRuntimeSettings();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    write.resolve(jsonResponse({}));
    await saving;
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(false);
    directory.resolve(jsonResponse({ id: 2, primaryCode: "RJ00000001" }));
    runtime.resolve(jsonResponse({ mode: "production" }));

    await expect(edition).resolves.toMatchObject({ id: 2 });
    await expect(Promise.all([settings, joinedSettings])).resolves.toEqual([
      { mode: "production" },
      { mode: "production" },
    ]);
    expect(recordApiError).not.toHaveBeenCalled();
  });

  it("fences affected reads from before and during a write, including a failed write", async () => {
    const before = deferred<Response>();
    const during = deferred<Response>();
    const write = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(before.promise)
      .mockReturnValueOnce(write.promise)
      .mockReturnValueOnce(during.promise)
      .mockResolvedValueOnce(jsonResponse({ id: 1, title: "Current work" }));
    vi.stubGlobal("fetch", fetchMock);
    const oldRead = api.getWork(1);
    const saving = api.updateMediaProgress(1, {
      locationId: 1,
      positionSeconds: 10,
      durationSeconds: 60,
      completed: false,
    });
    const concurrentRead = api.getWork(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    write.resolve(jsonResponse({ error: "Database busy", code: "database_busy", retryable: true }, 503));
    await expect(saving).rejects.toMatchObject({ code: "database_busy" });
    await expect(api.getWork(1)).resolves.toMatchObject({ title: "Current work" });
    before.resolve(jsonResponse({ id: 1, title: "Before write" }));
    during.resolve(jsonResponse({ id: 1, title: "During write" }));
    await expect(oldRead).resolves.toMatchObject({ title: "Before write" });
    await expect(concurrentRead).resolves.toMatchObject({ title: "During write" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("refreshes shared settings and tag suggestions after a write settles", async () => {
    const oldSettings = deferred<Response>();
    const duringTags = deferred<Response>();
    const write = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(oldSettings.promise)
      .mockReturnValueOnce(write.promise)
      .mockReturnValueOnce(duringTags.promise)
      .mockResolvedValueOnce(jsonResponse({ mode: "production", cacheEnabled: true }))
      .mockResolvedValueOnce(jsonResponse({ scope: "work", tags: [{ id: 1, name: "Example tag" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const settings = api.getRuntimeSettings();
    const saving = api.updateSettings({ cacheEnabled: true });
    const tags = api.listUserTags("work");
    write.resolve(jsonResponse({}));
    await saving;
    await expect(api.getRuntimeSettings()).resolves.toMatchObject({ cacheEnabled: true });
    await expect(api.listUserTags("work")).resolves.toMatchObject({ tags: [{ name: "Example tag" }] });
    oldSettings.resolve(jsonResponse({ mode: "production", cacheEnabled: false }));
    duringTags.resolve(jsonResponse({ scope: "work", tags: [] }));
    await Promise.all([settings, tags]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("fences reads until the mutation body finishes, including a decode failure", async () => {
    const body = deferred<unknown>();
    const during = deferred<Response>();
    const response = jsonResponse({});
    const readingBody = vi.spyOn(response, "json").mockReturnValue(body.promise);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockReturnValueOnce(during.promise)
      .mockResolvedValueOnce(jsonResponse({ mode: "production", cacheEnabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    const saving = api.updateSettings({ cacheEnabled: true });
    await vi.waitFor(() => expect(readingBody).toHaveBeenCalledOnce());
    const interim = api.getRuntimeSettings();
    body.reject(new SyntaxError("Mutation body failed to decode"));
    await expect(saving).rejects.toBeInstanceOf(SyntaxError);
    await expect(api.getRuntimeSettings()).resolves.toMatchObject({ cacheEnabled: true });
    during.resolve(jsonResponse({ mode: "production", cacheEnabled: false }));
    await interim;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("automatically recovers an affected directory after a structural write without retrying the write", async () => {
    const old = deferred<Response>();
    const write = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(write.promise)
      .mockResolvedValueOnce(jsonResponse({ id: 2, title: "Refreshed edition" }));
    vi.stubGlobal("fetch", fetchMock);
    const read = api.getWork(2);
    const refreshing = api.refreshWorkLocalFiles(2);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    write.resolve(jsonResponse({ workId: 2 }));
    await refreshing;
    await expect(read).resolves.toMatchObject({ title: "Refreshed edition" });
    old.reject(new Error("Old transport failed"));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/works/2",
      "/api/works/2/local-files/refresh",
      "/api/works/2",
    ]);
    expect(recordApiError).not.toHaveBeenCalled();
  });

  it("does not recover a directory after its session changes while waiting for a write", async () => {
    const old = deferred<Response>();
    const write = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(write.promise);
    vi.stubGlobal("fetch", fetchMock);
    const read = api.getWork(2);
    const refreshing = api.refreshWorkLocalFiles(2);
    changeApiSession();
    await expect(read).rejects.toMatchObject({ name: "AbortError", message: "The session has changed." });
    write.resolve(jsonResponse({ workId: 2 }));
    old.resolve(jsonResponse({ id: 2 }));
    await expect(refreshing).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordApiError).not.toHaveBeenCalled();
  });

  it.each(["success", "http failure", "network failure"] as const)(
    "rejects a late %s from the previous account",
    async (result) => {
      const old = deferred<Response>();
      const fresh = deferred<Response>();
      const fetchMock = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
      vi.stubGlobal("fetch", fetchMock);
      observeApiPrincipal(1);
      const pending = api.getWorkSummary(1);
      const epoch = apiSessionVersion();
      observeApiPrincipal(2);
      expect(apiSessionVersion()).toBeGreaterThan(epoch);
      const current = api.getWorkSummary(1);
      if (result === "network failure") old.reject(new Error("Previous server failure"));
      else
        old.resolve(
          jsonResponse(
            result === "success" ? { id: 1 } : { error: "Previous HTTP failure" },
            result === "success" ? 200 : 503,
          ),
        );
      await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "The session has changed." });
      fresh.resolve(jsonResponse({ id: 1, title: "Current account view" }));
      await expect(current).resolves.toMatchObject({ title: "Current account view" });
      expect(recordApiError).not.toHaveBeenCalled();
    },
  );

  it.each(["success", "decode failure", "http failure"] as const)(
    "rejects an old response body's %s",
    async (result) => {
      const body = deferred<unknown>();
      const response = jsonResponse({}, result === "http failure" ? 503 : 200);
      const readingBody = vi.spyOn(response, "json").mockReturnValue(body.promise);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      const pending = api.getWorkSummary(1);
      await vi.waitFor(() => expect(readingBody).toHaveBeenCalledOnce());
      changeApiSession();
      if (result === "decode failure") body.reject(new SyntaxError("Old body failed to decode"));
      else body.resolve(result === "success" ? { id: 1 } : { error: "Old HTTP failure" });
      await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "The session has changed." });
      expect(recordApiError).not.toHaveBeenCalled();
    },
  );

  it("does not let an old write's completion evict current-session reads", async () => {
    const write = deferred<Response>();
    const read = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(write.promise).mockReturnValueOnce(read.promise);
    vi.stubGlobal("fetch", fetchMock);
    const saving = api.updateSettings({ cacheEnabled: true });
    changeApiSession();
    const first = api.getRuntimeSettings();
    write.resolve(jsonResponse({}));
    await expect(saving).rejects.toMatchObject({ name: "AbortError" });
    const joined = api.getRuntimeSettings();
    read.resolve(jsonResponse({ mode: "production" }));
    await Promise.all([first, joined]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fences a logout/login cycle into the same account", async () => {
    const old = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, user: { id: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ id: 1, title: "New session view" }));
    vi.stubGlobal("fetch", fetchMock);
    observeApiPrincipal(1);
    const pending = api.getWork(1);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError", message: "The session has changed." });
    await api.logout();
    await api.login("synthetic-user", "synthetic-password");
    await rejected;
    old.resolve(jsonResponse({ id: 1, title: "Old session view" }));
    await expect(api.getWork(1)).resolves.toMatchObject({ title: "New session view" });
  });

  it("rejects a delayed mutation body failure after a session change", async () => {
    const body = deferred<unknown>();
    const response = jsonResponse({});
    const readingBody = vi.spyOn(response, "json").mockReturnValue(body.promise);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const pending = api.updateSettings({ cacheEnabled: true });
    await vi.waitFor(() => expect(readingBody).toHaveBeenCalledOnce());
    changeApiSession();
    body.reject(new SyntaxError("Old write body failed to decode"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "The session has changed." });
    expect(recordApiError).not.toHaveBeenCalled();
  });

  it("stops a workflow event stream when its session changes", async () => {
    const body = new ReadableStream<Uint8Array>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    const onMessage = vi.fn();
    const pending = api.streamWorkflowRunEvents(41, 0, new AbortController().signal, onMessage);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError", message: "The session has changed." });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    changeApiSession();
    await rejected;
    expect(onMessage).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it("sends the manual Fetch disk reserve by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await api.planRemoteSourceWorkFetch(7, "RJ00000000", ["track.mp3"]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      paths: ["track.mp3"],
      localPaths: [],
      targetRoot: "",
      decisions: [],
      minFreeBytes: 2 * 1024 * 1024 * 1024,
    });
  });

  it("treats a terminal workflow tick followed by stream closure as a normal completion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event: tick\ndata: {"status":"succeeded","lastEventId":12}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const messages: unknown[] = [];

    await expect(
      api.streamWorkflowRunEvents(41, 11, new AbortController().signal, (message) => messages.push(message)),
    ).resolves.toBeUndefined();

    expect(messages).toEqual([{ type: "tick", status: "succeeded", lastEventId: 12 }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/workflow-runs/41/events/stream?afterId=11");
    expect(new Headers(init.headers).get("Accept")).toBe("text/event-stream");
  });

  it("isolates tag requests across a cookie login and discards an old response", async () => {
    let respondOld!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            respondOld = resolve;
          }),
      )
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, user: { id: 2 } }))
      .mockResolvedValueOnce(jsonResponse({ scope: "work", tags: [{ name: "Example new tag" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const old = api.listUserTags("work");
    const discarded = expect(old).rejects.toMatchObject({ name: "AbortError" });
    await api.login("synthetic-user", "synthetic-password");
    const fresh = api.listUserTags("work");
    respondOld(jsonResponse({ scope: "work", tags: [{ name: "Example old tag" }] }));
    await discarded;
    await expect(fresh).resolves.toMatchObject({ tags: [{ name: "Example new tag" }] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fences pre-write and mid-write settings reuse without aborting their existing callers", async () => {
    const pending: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const before = api.getRuntimeSettings();
    const write = api.updateSettings({ cacheEnabled: false });
    const during = api.getRuntimeSettings();
    pending[1](jsonResponse({ cacheEnabled: false }));
    await write;
    const after = api.getRuntimeSettings();
    pending[0](jsonResponse({ cacheEnabled: true }));
    pending[2](jsonResponse({ cacheEnabled: true }));
    pending[3](jsonResponse({ cacheEnabled: false }));
    await expect(Promise.all([before, during, after])).resolves.toEqual([
      { cacheEnabled: true },
      { cacheEnabled: true },
      { cacheEnabled: false },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("shares tag reads while independently cancelling each subscriber", async () => {
    let respond!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const cancelled = api.listUserTags("work", controller.signal);
    const remaining = api.listUserTags("work");
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const signal = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal;
    expect(signal?.aborted).toBe(false);
    respond(jsonResponse({ scope: "work", tags: [] }));
    await expect(remaining).resolves.toMatchObject({ tags: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a delayed body from a previous session even after fetch returned", async () => {
    let finishBody!: (value: unknown) => void;
    const response = jsonResponse({});
    vi.spyOn(response, "json").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishBody = resolve;
        }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const read = api.listUsers();
    const rejected = expect(read).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(finishBody).toBeTypeOf("function"));
    changeApiSession();
    finishBody([{ id: 1 }]);
    await rejected;
  });

  it("discards a network failure from an earlier session without publishing diagnostics", async () => {
    let fail!: (error: Error) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((_, reject) => (fail = reject))),
    );
    const read = api.listUsers();
    const rejected = expect(read).rejects.toMatchObject({ name: "AbortError" });
    changeApiSession();
    fail(new TypeError("Example old network failure"));
    await rejected;
    expect(recordApiError).not.toHaveBeenCalled();
  });
});
