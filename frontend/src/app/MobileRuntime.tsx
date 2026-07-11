import { Network } from "@capacitor/network";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { APP_CLIENT_VERSION, compareVersions } from "@/lib/appInfo";
import { api, type HealthStatus } from "@/lib/api";
import { recordDiagnostic } from "@/lib/mobileDiagnostics";
import { getStoredServerURL, isNativeApp } from "@/lib/serverConfig";

type MobileConnectionKind = "idle" | "online" | "checking" | "reconnecting" | "offline" | "version-warning";

type MobileConnection = {
  kind: MobileConnectionKind;
  message: string;
  serverVersion: string;
  minimumClientVersion: string;
  lastCheckedAt: string;
};

type MobileRuntimeContextValue = {
  connection: MobileConnection;
  reconnect: () => Promise<HealthStatus | null>;
};

const initialConnection: MobileConnection = {
  kind: "idle",
  message: "",
  serverVersion: "",
  minimumClientVersion: "",
  lastCheckedAt: "",
};

const MobileRuntimeContext = createContext<MobileRuntimeContextValue>({
  connection: initialConnection,
  reconnect: async () => null,
});

export function MobileRuntimeProvider({ children }: { children: React.ReactNode }) {
  const [connection, setConnection] = useState<MobileConnection>(initialConnection);

  const applyHealth = useCallback((health: HealthStatus) => {
    const minimumClientVersion = health.minAndroidClientVersion || health.minClientVersion || "";
    const needsUpdate = minimumClientVersion && compareVersions(APP_CLIENT_VERSION, minimumClientVersion) < 0;
    const versionMismatch = health.version && compareVersions(APP_CLIENT_VERSION, health.version) !== 0;
    const next: MobileConnection = {
      kind: needsUpdate || versionMismatch ? "version-warning" : "online",
      message: needsUpdate
        ? `Server requires client ${minimumClientVersion} or newer.`
        : versionMismatch
          ? `Client ${APP_CLIENT_VERSION} connected to server ${health.version}.`
          : "Connected",
      serverVersion: health.version,
      minimumClientVersion,
      lastCheckedAt: new Date().toISOString(),
    };
    setConnection(next);
    recordDiagnostic({ kind: "connection", message: next.message });
  }, []);

  const reconnect = useCallback(async () => {
    if (!isNativeApp()) return null;
    const server = getStoredServerURL();
    if (!server) {
      setConnection({
        ...initialConnection,
        kind: "offline",
        message: "Server is not configured.",
        lastCheckedAt: new Date().toISOString(),
      });
      return null;
    }
    setConnection((current) => ({
      ...current,
      kind: current.kind === "offline" ? "reconnecting" : "checking",
      message: "Checking server connection...",
    }));
    try {
      const health = await api.health(server);
      applyHealth(health);
      return health;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Server is not reachable.";
      const next = {
        ...initialConnection,
        kind: "offline" as const,
        message,
        lastCheckedAt: new Date().toISOString(),
      };
      setConnection(next);
      recordDiagnostic({ kind: "connection", message: "Connection failed", detail: message });
      return null;
    }
  }, [applyHealth]);

  useEffect(() => {
    if (!isNativeApp()) return;
    void reconnect();
    const timer = window.setInterval(() => {
      void reconnect();
    }, 30000);
    let disposed = false;
    Network.addListener("networkStatusChange", (status) => {
      if (disposed) return;
      if (!status.connected) {
        const next = {
          ...initialConnection,
          kind: "offline" as const,
          message: "Network is offline.",
          lastCheckedAt: new Date().toISOString(),
        };
        setConnection(next);
        recordDiagnostic({ kind: "connection", message: next.message });
        return;
      }
      setConnection((current) => ({
        ...current,
        kind: "reconnecting",
        message: `Network changed to ${status.connectionType}; reconnecting...`,
      }));
      void reconnect();
    }).catch((error) => {
      recordDiagnostic({
        kind: "runtime",
        message: "Network listener failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    });
    return () => {
      disposed = true;
      window.clearInterval(timer);
      void Network.removeAllListeners();
    };
  }, [reconnect]);

  const value = useMemo<MobileRuntimeContextValue>(() => ({ connection, reconnect }), [connection, reconnect]);
  return <MobileRuntimeContext.Provider value={value}>{children}</MobileRuntimeContext.Provider>;
}

export function useMobileRuntime() {
  return useContext(MobileRuntimeContext);
}
