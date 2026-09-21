import { Server, WifiOff } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { api } from "@/lib/api";
import { serverFormFromURL, serverURLFromForm, type ServerProtocol } from "./serverConnectionForm";
import {
  getStoredServerURL,
  hydrateNativeConfig,
  isNativeApp,
  normalizeServerURL,
  setStoredServerURL,
} from "@/lib/serverConfig";

type ConnectionState = "checking" | "ready" | "setup";
const serverProtocols: ServerProtocol[] = ["http", "https"];

export function MobileServerGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<ConnectionState>(() => (isNativeApp() ? "checking" : "ready"));
  const initialForm = serverFormFromURL(getStoredServerURL());
  const [protocol, setProtocol] = useState<ServerProtocol>(initialForm.protocol);
  const [address, setAddress] = useState(initialForm.address);
  const [port, setPort] = useState(initialForm.port);
  const [error, setError] = useState("");
  const [version, setVersion] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const connectionController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!isNativeApp()) return;
    hydrateNativeConfig()
      .then(() => {
        const stored = getStoredServerURL();
        if (!stored) {
          setState("setup");
          return;
        }
        const form = serverFormFromURL(stored);
        setProtocol(form.protocol);
        setAddress(form.address);
        setPort(form.port);
        return api
          .health(stored)
          .then((result) => {
            setVersion(result.version);
            setState("ready");
          })
          .catch(() => {
            const form = serverFormFromURL(stored);
            setProtocol(form.protocol);
            setAddress(form.address);
            setPort(form.port);
            setError(t("serverGate.unreachable"));
            setState("setup");
          });
      })
      .catch(() => {
        setError(t("serverGate.settingsUnavailable"));
        setState("setup");
      });
    return () => connectionController.current?.abort();
  }, []);

  if (state === "ready") return <>{children}</>;
  if (state === "checking") {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
        {t("serverGate.connecting")}
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isConnecting) {
      connectionController.current?.abort();
      setIsConnecting(false);
      return;
    }
    setError("");
    setVersion("");
    const numericPort = Number(port.trim());
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      setError(t("serverGate.invalidPort"));
      return;
    }
    const controller = new AbortController();
    connectionController.current = controller;
    setIsConnecting(true);
    try {
      const normalized = normalizeServerURL(serverURLFromForm(protocol, address, port));
      const result = await api.health(normalized, controller.signal);
      await setStoredServerURL(normalized);
      setVersion(result.version);
      setState("ready");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Unable to connect to Kikoto.");
    } finally {
      if (connectionController.current === controller) {
        connectionController.current = null;
        setIsConnecting(false);
      }
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-8">
      <section className="min-w-0 w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-5">
          <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-secondary text-secondary-foreground">
            {error ? <WifiOff className="h-5 w-5" /> : <Server className="h-5 w-5" />}
          </div>
          <h1 className="text-xl font-semibold">{t("serverGate.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("serverGate.subtitle")}</p>
        </div>

        <form className="space-y-3" onSubmit={submit}>
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 grid min-w-0 gap-1.5 text-sm font-medium">
              {t("serverGate.serverAddress")}
              <Input
                fieldSize="lg"
                className="w-full min-w-0"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="192.0.2.1"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                disabled={isConnecting}
              />
            </label>
            <label className="grid min-w-0 gap-1.5 text-sm font-medium">
              {t("serverGate.protocol")}
              <NativeSelect
                fieldSize="lg"
                className="w-full min-w-0 px-2"
                value={protocol}
                onChange={(event) => setProtocol(event.target.value as ServerProtocol)}
                disabled={isConnecting}
              >
                {serverProtocols.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="grid min-w-0 gap-1.5 text-sm font-medium">
              {t("serverGate.port")}
              <Input
                fieldSize="lg"
                className="w-full min-w-0"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder="7655"
                inputMode="numeric"
                autoComplete="off"
                disabled={isConnecting}
              />
            </label>
          </div>
          {error && (
            <div className="rounded-md border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground">
              {error}
            </div>
          )}
          {isConnecting && (
            <div className="rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">
              {t("serverGate.connectingAttempt")}
            </div>
          )}
          {version && (
            <div className="rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">
              {t("serverGate.serverVersion", { version })}
            </div>
          )}
          <Button className="min-h-11 w-full" type="submit">
            {isConnecting ? t("serverGate.cancel") : t("serverGate.connect")}
          </Button>
        </form>
      </section>
    </main>
  );
}
