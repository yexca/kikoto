import { USER_PREFERENCES_CHANGED } from "@/lib/recommendationSession";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import {
  api,
  ApiError,
  type AuthState,
  type CurrentUser,
  type InitialSetupPayload,
  type RuntimeSettings,
} from "@/lib/api";

type AuthContextValue = {
  isLoading: boolean;
  /**
   * The server could not answer who the viewer is (network failure or a
   * server error). This is not a signed-out state; only `retryBootstrap`
   * or a later successful refresh can resolve it.
   */
  bootstrapFailed: boolean;
  retryBootstrap: () => Promise<void>;
  recommendationThreshold: number;
  user: CurrentUser | null;
  /** A production instance with no administrator; only initial setup can proceed. */
  setupRequired: boolean;
  login: (username: string, password: string) => Promise<void>;
  completeSetup: (payload: InitialSetupPayload) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshRuntime: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
  runtimeMode: RuntimeSettings["mode"];
  demoMode: boolean;
  anonymousAccessEnabled: boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// A request that never got an answer, or a server error, says nothing about
// the viewer's session. Other rejections keep the signed-out fallback.
function isServerUnavailable(error: unknown) {
  return !(error instanceof ApiError) || error.status >= 500;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [bootstrapFailed, setBootstrapFailed] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeSettings["mode"]>("production");
  const [anonymousAccessEnabled, setAnonymousAccessEnabled] = useState(false);

  const userId = auth?.authenticated ? auth.user.id : null;
  const [recommendationThreshold, setRecommendationThreshold] = useState({ userId, value: 50 });
  useEffect(() => {
    let cancelled = false;
    const refreshPreferences = () => {
      void api
        .getRuntimeSettings()
        .then((settings) => {
          if (!cancelled) setRecommendationThreshold({ userId, value: settings.recommendationThreshold ?? 50 });
        })
        .catch(() => undefined);
    };
    refreshPreferences();
    window.addEventListener(USER_PREFERENCES_CHANGED, refreshPreferences);
    return () => {
      cancelled = true;
      window.removeEventListener(USER_PREFERENCES_CHANGED, refreshPreferences);
    };
  }, [userId]);

  const refresh = useCallback(async () => {
    const state = await api.me();
    setAuth(state);
    setBootstrapFailed(false);
  }, []);

  const refreshRuntime = useCallback(async () => {
    const settings = await api.getRuntimeSettings();
    setRuntimeMode(settings.mode);
    setAnonymousAccessEnabled(settings.anonymousAccessEnabled ?? false);
  }, []);

  // A network failure or server error keeps the viewer's state unknown rather
  // than presenting it as signed out, so a restart during an outage does not
  // send a signed-in viewer to the login page.
  const bootstrap = useCallback(async () => {
    const [authResult, runtimeResult] = await Promise.allSettled([refresh(), refreshRuntime()]);
    let failed = false;
    if (authResult.status === "rejected") {
      if (isServerUnavailable(authResult.reason)) failed = true;
      else setAuth({ authenticated: false });
    }
    if (runtimeResult.status === "rejected" && isServerUnavailable(runtimeResult.reason)) failed = true;
    setBootstrapFailed(failed);
  }, [refresh, refreshRuntime]);

  useEffect(() => {
    void bootstrap().finally(() => setIsLoading(false));
  }, [bootstrap]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isLoading,
      bootstrapFailed,
      retryBootstrap: bootstrap,
      recommendationThreshold: recommendationThreshold.userId === userId ? recommendationThreshold.value : 50,
      user: auth?.authenticated ? auth.user : null,
      setupRequired: auth?.authenticated === false && auth.setupRequired === true,
      login: async (username, password) => {
        const state = await api.login(username, password);
        setAuth(state);
      },
      completeSetup: async (payload) => {
        const state = await api.completeInitialSetup(payload);
        setAuth(state);
      },
      logout: async () => {
        await api.logout();
        await Promise.all([
          refresh().catch(() => setAuth({ authenticated: false })),
          refreshRuntime().catch(() => setAnonymousAccessEnabled(false)),
        ]);
      },
      refresh,
      refreshRuntime,
      hasPermission: (permission) => {
        if (!auth?.authenticated) return false;
        return auth.user.permissions.includes(permission) || auth.user.permissions.includes("system:admin");
      },
      runtimeMode,
      demoMode: runtimeMode === "demo",
      anonymousAccessEnabled,
    }),
    [
      anonymousAccessEnabled,
      auth,
      bootstrap,
      bootstrapFailed,
      isLoading,
      refresh,
      refreshRuntime,
      runtimeMode,
      recommendationThreshold,
      userId,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return value;
}
