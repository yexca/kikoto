import { apiMutationResources, apiReadResources } from "@/lib/apiRequestResources";
import { apiSessionSignal, apiSessionVersion, assertApiSession } from "@/lib/apiSession";
import { SITE_MAINTENANCE_EVENT } from "@/lib/appEvents";
import { DEMO_METADATA_LANGUAGES_HEADER, demoMetadataLanguagesHeaderValue } from "@/lib/demoMetadataLanguages";
import { combineAbortSignals, retryInvalidatedRequest, sharedInflightRequests } from "@/lib/inflightRequests";
import { recordApiError } from "@/lib/mobileDiagnostics";
import { nativeAssetURL } from "@/lib/nativeAssetTransport";
import { getStoredServerURL, getStoredSessionToken, isNativeApp } from "@/lib/serverConfig";

const BUILD_API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export function API_BASE() {
  if (isNativeApp()) return getStoredServerURL();
  return BUILD_API_BASE;
}

function apiURL(path: string, base = API_BASE()) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  if (!base) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function assetURL(path: string) {
  if (!path) return "";
  return nativeAssetURL(apiURL(path), API_BASE());
}

export class ApiError extends Error {
  status: number;
  code: string;
  retryable: boolean;

  constructor(message: string, status: number, code = "", retryable = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export async function responseError(response: Response, fallback: string) {
  try {
    assertResponseCurrent(response);
    const payload = await response.json().catch(() => ({ error: fallback, code: "", retryable: false }));
    assertResponseCurrent(response);
    const message = payload.error ?? fallback;
    recordApiError({
      method: "HTTP",
      path: response.url || fallback,
      status: response.status,
      message,
    });
    if (payload.code === "site_maintenance") globalThis.dispatchEvent?.(new Event(SITE_MAINTENANCE_EVENT));
    return new ApiError(message, response.status, payload.code ?? "", payload.retryable === true);
  } finally {
    responseContexts.get(response)?.complete();
  }
}

async function requestJSON<T>(path: string, init: RequestInit = {}): Promise<T> {
  const version = apiSessionVersion();
  try {
    const response = await fetchAPI(path, init);
    if (!response.ok) {
      throw await responseError(response, `${init.method ?? "GET"} ${path} failed with ${response.status}`);
    }
    return await readApiJSON<T>(response);
  } finally {
    assertApiSession(version);
    init.signal?.throwIfAborted();
  }
}

export function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestJSON<T>(path, { signal });
}

const responseContexts = new WeakMap<Response, { version: number; signal: AbortSignal; complete: () => void }>();

export function assertResponseCurrent(response: Response) {
  const context = responseContexts.get(response);
  if (!context) return;
  assertApiSession(context.version);
  context.signal.throwIfAborted();
}

/** The session and caller signal that fences a response `fetchAPI` returned. */
export function responseSignal(response: Response) {
  return responseContexts.get(response)!.signal;
}

/** Settles a response whose body is read outside `readApiJSON`, such as a stream. */
export function completeResponse(response: Response) {
  responseContexts.get(response)?.complete();
}

export async function readApiJSON<T>(response: Response): Promise<T> {
  try {
    assertResponseCurrent(response);
    return (await response.json()) as T;
  } finally {
    // A session or caller can change while the response body is being read,
    // including when decoding fails. Neither old results nor old errors escape.
    try {
      assertResponseCurrent(response);
    } finally {
      responseContexts.get(response)?.complete();
    }
  }
}

// Concurrent callers of the same idempotent GET share one request. A caller's
// abort only detaches that caller; a settled request is never reused.
export async function sharedGetJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const version = apiSessionVersion();
  const key = JSON.stringify([version, API_BASE(), path, demoMetadataLanguagesHeaderValue()]);
  const cancellation = combineAbortSignals(apiSessionSignal(), signal);
  const current = cancellation.signal;
  try {
    return await retryInvalidatedRequest(
      () => sharedInflightRequests.run(key, (shared) => getJSON<T>(path, shared), current, apiReadResources(path)),
      current,
    );
  } finally {
    try {
      assertApiSession(version);
      current.throwIfAborted();
    } finally {
      cancellation.dispose();
    }
  }
}

export function postJSON<T>(path: string): Promise<T> {
  return requestJSON<T>(path, { method: "POST" });
}

export async function postJSONBody<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return requestJSON<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function patchJSONBody<T>(path: string, body: unknown): Promise<T> {
  return requestJSON<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function putJSONBody<T>(path: string, body: unknown): Promise<T> {
  return requestJSON<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteJSON<T>(path: string): Promise<T> {
  return requestJSON<T>(path, { method: "DELETE" });
}

// A write that may outlive the page (a pagehide flush) opts into keepalive.
export async function sendJSONBody<T>(
  method: "POST" | "PATCH" | "PUT",
  path: string,
  body: unknown,
  init: Pick<RequestInit, "signal" | "keepalive"> = {},
): Promise<T> {
  return requestJSON<T>(path, {
    ...init,
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A multipart upload; the browser sets the boundary, so no content type is forced. */
async function sendFormData<T>(path: string, body: FormData, init: Pick<RequestInit, "signal"> = {}): Promise<T> {
  return requestJSON<T>(path, { ...init, method: "POST", body });
}

/**
 * The authenticated JSON transport for focused feature API modules. It carries
 * the same browser cookie or native bearer credentials and error mapping as `api`.
 */
export const apiTransport = {
  getJSON,
  sendJSONBody,
  sendFormData,
  deleteJSON,
};

function requestInit(init: RequestInit = {}, authenticate = true): RequestInit {
  const headers = new Headers(init.headers);
  const demoMetadataLanguages = demoMetadataLanguagesHeaderValue();
  if (authenticate && demoMetadataLanguages) headers.set(DEMO_METADATA_LANGUAGES_HEADER, demoMetadataLanguages);
  if (isNativeApp()) {
    headers.set("X-Kikoto-Mobile", "1");
    if (authenticate) {
      const token = getStoredSessionToken();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }
  }
  return {
    ...init,
    credentials: !authenticate || isNativeApp() ? "omit" : "include",
    headers,
  };
}

export async function fetchAPI(path: string, init: RequestInit = {}, baseURL?: string, authenticate = true) {
  const url = apiURL(path, baseURL);
  const method = (init.method ?? "GET").toUpperCase();
  const version = apiSessionVersion();
  const cancellation = combineAbortSignals(apiSessionSignal(), init.signal);
  const signal = cancellation.signal;
  const resources = method !== "GET" && method !== "HEAD" ? apiMutationResources(path) : null;
  let settleWrite = () => {};
  const settled = new Promise<void>((resolve) => {
    settleWrite = resolve;
  });
  const invalidateResources = () => {
    if (!resources) return;
    if (resources.forget === null) sharedInflightRequests.forgetAll();
    else sharedInflightRequests.forgetResources(resources.forget);
    sharedInflightRequests.invalidateResources(resources.interrupt, settled);
  };
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    cancellation.dispose();
    // The body can still be loading after headers arrive. Fence reads from
    // the whole mutation, including a failed decode or HTTP error response.
    if (version === apiSessionVersion()) invalidateResources();
    settleWrite();
  };
  let returnedResponse = false;
  signal.throwIfAborted();
  invalidateResources();
  try {
    const response = await fetch(url, requestInit({ ...init, signal }, authenticate));
    assertApiSession(version);
    signal.throwIfAborted();
    responseContexts.set(response, { version, signal, complete });
    returnedResponse = true;
    return response;
  } catch (error) {
    assertApiSession(version);
    signal.throwIfAborted();
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    recordApiError({
      method: init.method ?? "GET",
      path: url,
      message: error instanceof Error ? error.message : "Network request failed.",
    });
    throw error;
  } finally {
    // JSON/error decoding completes successful transports. Network failures
    // complete here. Old writes never affect reads in a newer session.
    if (!returnedResponse) complete();
  }
}
