import { Network } from "@capacitor/network";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { APP_CLIENT_VERSION, appVersionStatus, githubReleaseURL } from "@/lib/appInfo";
import { api, type HealthStatus } from "@/lib/api";
import { recordDiagnostic } from "@/lib/mobileDiagnostics";
import { getStoredServerURL, isNativeApp } from "@/lib/serverConfig";

type MobileConnectionKind =
  | "idle"
  | "online"
  | "checking"
  | "reconnecting"
  | "offline"
  | "client-update-available"
  | "client-update-required"
  | "server-update-available";

type MobileConnection = {
  kind: MobileConnectionKind;
  message: string;
  serverVersion: string;
  minimumClientVersion: string;
  releaseUrl: string;
  noticeKey: string;
  lastCheckedAt: string;
};

type MobileRuntimeContextValue = {
  connection: MobileConnection;
  keyboardOpen: boolean;
  reconnect: () => Promise<HealthStatus | null>;
};

const initialConnection: MobileConnection = {
  kind: "idle",
  message: "",
  serverVersion: "",
  minimumClientVersion: "",
  releaseUrl: "",
  noticeKey: "",
  lastCheckedAt: "",
};

const MobileRuntimeContext = createContext<MobileRuntimeContextValue>({
  connection: initialConnection,
  keyboardOpen: false,
  reconnect: async () => null,
});

export function MobileRuntimeProvider({ children }: { children: React.ReactNode }) {
  const [connection, setConnection] = useState<MobileConnection>(initialConnection);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const keyboardBaselineHeight = useRef(0);

  const applyHealth = useCallback((health: HealthStatus) => {
    const minimumClientVersion = health.minAndroidClientVersion || health.minClientVersion || "";
    const versionStatus = appVersionStatus(APP_CLIENT_VERSION, health.version, minimumClientVersion);
    const targetVersion =
      versionStatus === "client-update-required"
        ? minimumClientVersion
        : versionStatus === "client-update-available"
          ? health.version
          : versionStatus === "server-update-available"
            ? APP_CLIENT_VERSION
            : "";
    const next: MobileConnection = {
      kind: versionStatus === "compatible" ? "online" : versionStatus,
      message:
        versionStatus === "client-update-required"
          ? `Android client ${APP_CLIENT_VERSION} is no longer supported. Version ${minimumClientVersion} or newer is required.`
          : versionStatus === "client-update-available"
            ? `Android client ${APP_CLIENT_VERSION} is older than server ${health.version}.`
            : versionStatus === "server-update-available"
              ? `Server ${health.version} is older than Android client ${APP_CLIENT_VERSION}.`
              : "Connected",
      serverVersion: health.version,
      minimumClientVersion,
      releaseUrl: targetVersion ? githubReleaseURL(targetVersion) : "",
      noticeKey: targetVersion ? `${versionStatus}:${targetVersion}` : "",
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
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const isTextInput = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false;
      return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable;
    };
    const currentViewportHeight = () => viewport?.height ?? window.innerHeight;
    const applyViewportMetrics = () => {
      root.style.setProperty("--visual-viewport-width", `${Math.max(1, viewport?.width ?? window.innerWidth)}px`);
      root.style.setProperty("--visual-viewport-height", `${Math.max(1, currentViewportHeight())}px`);
      root.style.setProperty("--visual-viewport-offset-top", `${Math.max(0, viewport?.offsetTop ?? 0)}px`);
      root.style.setProperty("--visual-viewport-offset-left", `${Math.max(0, viewport?.offsetLeft ?? 0)}px`);
    };
    keyboardBaselineHeight.current = Math.max(window.innerHeight, currentViewportHeight());
    let frame: number | null = null;
    const updateKeyboardState = () => {
      frame = null;
      applyViewportMetrics();
      const height = currentViewportHeight();
      const baseline = keyboardBaselineHeight.current || height;
      const focused = isTextInput(document.activeElement);
      const compactViewport = window.matchMedia("(max-width: 1023px)").matches;
      const open = compactViewport && focused && baseline - height > 120;
      setKeyboardOpen(open);
      if (!focused && baseline - height <= 120) {
        keyboardBaselineHeight.current = Math.max(window.innerHeight, height);
      }
    };
    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(updateKeyboardState);
    };
    updateKeyboardState();
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("focusin", scheduleUpdate);
    window.addEventListener("focusout", scheduleUpdate);
    viewport?.addEventListener("resize", scheduleUpdate);
    viewport?.addEventListener("scroll", scheduleUpdate);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("focusin", scheduleUpdate);
      window.removeEventListener("focusout", scheduleUpdate);
      viewport?.removeEventListener("resize", scheduleUpdate);
      viewport?.removeEventListener("scroll", scheduleUpdate);
      root.style.removeProperty("--visual-viewport-width");
      root.style.removeProperty("--visual-viewport-height");
      root.style.removeProperty("--visual-viewport-offset-top");
      root.style.removeProperty("--visual-viewport-offset-left");
    };
  }, []);

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

  const value = useMemo<MobileRuntimeContextValue>(
    () => ({ connection, keyboardOpen, reconnect }),
    [connection, keyboardOpen, reconnect],
  );
  return <MobileRuntimeContext.Provider value={value}>{children}</MobileRuntimeContext.Provider>;
}

export function useMobileRuntime() {
  return useContext(MobileRuntimeContext);
}
