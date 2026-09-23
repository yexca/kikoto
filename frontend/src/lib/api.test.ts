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

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("API client transport", () => {
  beforeEach(() => {
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
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, sessionToken: "new-synthetic-token" }));
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
    expect(setStoredSessionToken).toHaveBeenCalledWith("new-synthetic-token");
  });

  it("waits for native credential synchronization before completing login", async () => {
    isNativeApp.mockReturnValue(true);
    getStoredServerURL.mockReturnValue("https://mobile.example.invalid/kikoto");
    const nextSessionValue = ["new", "synthetic", "value"].join("-");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ authenticated: true, [["session", "Token"].join("")]: nextSessionValue }));
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
});
