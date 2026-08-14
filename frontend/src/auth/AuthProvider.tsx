import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { api, type AuthState, type CurrentUser, type RuntimeSettings } from "@/lib/api";

type AuthContextValue = {
  isLoading: boolean;
  user: CurrentUser | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshRuntime: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
  runtimeMode: RuntimeSettings["mode"];
  demoMode: boolean;
  anonymousAccessEnabled: boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeSettings["mode"]>("production");
  const [anonymousAccessEnabled, setAnonymousAccessEnabled] = useState(false);

  const refresh = useCallback(async () => {
    const state = await api.me();
    setAuth(state);
  }, []);

  const refreshRuntime = useCallback(async () => {
    const settings = await api.getRuntimeSettings();
    setRuntimeMode(settings.mode);
    setAnonymousAccessEnabled(settings.anonymousAccessEnabled ?? false);
  }, []);

  useEffect(() => {
    Promise.all([
      refresh().catch(() => setAuth({ authenticated: false })),
      refreshRuntime().catch(() => {
        setRuntimeMode("production");
        setAnonymousAccessEnabled(false);
      }),
    ]).finally(() => setIsLoading(false));
  }, [refresh, refreshRuntime]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isLoading,
      user: auth?.authenticated ? auth.user : null,
      login: async (username, password) => {
        const state = await api.login(username, password);
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
    [anonymousAccessEnabled, auth, isLoading, refresh, refreshRuntime, runtimeMode],
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
