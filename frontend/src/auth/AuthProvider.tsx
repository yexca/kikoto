import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { api, type AuthState, type CurrentUser } from "@/lib/api";

type AuthContextValue = {
  isLoading: boolean;
  user: CurrentUser | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (permission: string) => boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = async () => {
    const state = await api.me();
    setAuth(state);
  };

  useEffect(() => {
    refresh()
      .catch(() => setAuth({ authenticated: false }))
      .finally(() => setIsLoading(false));
  }, []);

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
        await refresh().catch(() => setAuth({ authenticated: false }));
      },
      hasPermission: (permission) => {
        if (!auth?.authenticated) return false;
        return auth.user.permissions.includes(permission) || auth.user.permissions.includes("system:admin");
      },
    }),
    [auth, isLoading],
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
