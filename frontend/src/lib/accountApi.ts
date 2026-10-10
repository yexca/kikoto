import { apiSessionVersion, assertApiSession, changeApiSession, observeApiPrincipal } from "@/lib/apiSession";
import {
  deleteJSON,
  fetchAPI,
  getJSON,
  patchJSONBody,
  postJSON,
  postJSONBody,
  readApiJSON,
  responseError,
} from "@/lib/apiTransport";
import type { RecommendationConfig } from "@/lib/libraryApi";
import { clearStoredSessionToken, isNativeApp, setStoredSessionToken } from "@/lib/serverConfig";
import type { DirectoryRoutingRule } from "@/lib/settingsApi";

export type UserPreferences = {
  directoryRoutingRules: DirectoryRoutingRule[];
  recommendationConfig: RecommendationConfig;
  recommendationThreshold: number;
  recommendationDefaults: RecommendationConfig;
  /** The user's own metadata language priority; null shows each work's original language. */
  metadataLanguages: string[] | null;
};

/** Account roles; behavior follows each role's permissions, never its name. */
export type AccountRole = "super_admin" | "admin" | "contributor" | "user";

export type CurrentUser = {
  id: number;
  username: string;
  displayName: string;
  uiLocale: "auto" | "en" | "zh-Hans" | "zh-Hant" | "ja" | "ko";
  role: AccountRole;
  permissions: string[];
  devMode: boolean;
  demoMode: boolean;
  passwordManagedBy: "environment" | "account";
};

export type ManagedUser = {
  id: number;
  username: string;
  displayName: string;
  role: AccountRole;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** The root account managed through the environment in environment mode. */
  environmentManaged?: boolean;
};

/** setupRequired marks a production instance that has no administrator yet. */
export type AuthState =
  { authenticated: false; setupRequired?: boolean } | { authenticated: true; user: CurrentUser; sessionToken?: string };

export type InitialSetupPayload = {
  setupToken: string;
  username: string;
  password: string;
};

export type AccessPolicy = {
  anonymousAccessEnabled: boolean;
};

export type HealthStatus = {
  status: string;
  version: string;
  minClientVersion?: string;
  minAndroidClientVersion?: string;
};

async function login(username: string, password: string) {
  changeApiSession();
  const version = apiSessionVersion();
  const state = await postJSONBody<AuthState>("/api/auth/login", { username, password });
  assertApiSession(version);
  if (state.authenticated && state.sessionToken) {
    const syncing = setStoredSessionToken(state.sessionToken);
    const syncingVersion = apiSessionVersion();
    try {
      await syncing;
    } finally {
      assertApiSession(syncingVersion);
    }
  }
  changeApiSession();
  observeApiPrincipal(state.authenticated ? state.user.id : null);
  return state;
}

async function completeInitialSetup(payload: InitialSetupPayload) {
  changeApiSession();
  const version = apiSessionVersion();
  const state = await postJSONBody<AuthState>("/api/auth/setup", payload);
  assertApiSession(version);
  if (state.authenticated && state.sessionToken) {
    const syncing = setStoredSessionToken(state.sessionToken);
    const syncingVersion = apiSessionVersion();
    try {
      await syncing;
    } finally {
      assertApiSession(syncingVersion);
    }
  }
  changeApiSession();
  observeApiPrincipal(state.authenticated ? state.user.id : null);
  return state;
}

async function logout() {
  changeApiSession();
  const version = apiSessionVersion();
  try {
    return await postJSON<{ ok: boolean }>("/api/auth/logout");
  } finally {
    assertApiSession(version);
    const clearing = isNativeApp() ? clearStoredSessionToken() : Promise.resolve();
    const clearedVersion = apiSessionVersion();
    try {
      await clearing;
    } finally {
      assertApiSession(clearedVersion);
      changeApiSession();
    }
  }
}

export const accountApi = {
  health: async (baseURL?: string, signal?: AbortSignal) => {
    const response = await fetchAPI("/health", { redirect: "error", signal }, baseURL, false);
    if (!response.ok) {
      throw await responseError(response, `GET /health failed with ${response.status}`);
    }
    return readApiJSON<HealthStatus>(response);
  },
  me: async () => {
    const version = apiSessionVersion();
    const state = await getJSON<AuthState>("/api/auth/me");
    assertApiSession(version);
    observeApiPrincipal(state.authenticated ? state.user.id : null);
    return state;
  },
  updateCurrentAccount: (payload: {
    displayName?: string;
    uiLocale?: CurrentUser["uiLocale"];
    currentPassword?: string;
    newPassword?: string;
  }) => patchJSONBody<AuthState>("/api/auth/me", payload),
  login,
  completeInitialSetup,
  logout,
  listUsers: () => getJSON<ManagedUser[]>("/api/users"),
  createUser: (payload: {
    username: string;
    displayName: string;
    role: ManagedUser["role"];
    password: string;
    enabled: boolean;
  }) => postJSONBody<ManagedUser>("/api/users", payload),
  updateUser: (
    id: number,
    payload: { displayName?: string; role?: ManagedUser["role"]; password?: string; enabled?: boolean },
  ) => patchJSONBody<ManagedUser>(`/api/users/${id}`, payload),
  deleteUser: (id: number) => deleteJSON<{ ok: boolean }>(`/api/users/${id}`),
  getUserPreferences: (signal?: AbortSignal) => getJSON<UserPreferences>("/api/auth/me/preferences", signal),
  updateUserPreferences: (payload: Partial<Omit<UserPreferences, "recommendationDefaults">>) =>
    patchJSONBody<UserPreferences>("/api/auth/me/preferences", payload),
  updateAccessPolicy: (payload: AccessPolicy) => patchJSONBody<AccessPolicy>("/api/access-policy", payload),
};
