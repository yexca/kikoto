import { Server, WifiOff } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { getStoredServerURL, isNativeApp, normalizeServerURL, setStoredServerURL } from "@/lib/serverConfig";

type ConnectionState = "checking" | "ready" | "setup";

export function MobileServerGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConnectionState>(() => (isNativeApp() ? "checking" : "ready"));
  const [serverURL, setServerURL] = useState(() => getStoredServerURL());
  const [error, setError] = useState("");
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (!isNativeApp()) return;
    const stored = getStoredServerURL();
    if (!stored) {
      setState("setup");
      return;
    }
    api
      .health(stored)
      .then((result) => {
        setVersion(result.version);
        setState("ready");
      })
      .catch(() => {
        setServerURL(stored);
        setError("Kikoto server is not reachable from this device.");
        setState("setup");
      });
  }, []);

  if (state === "ready") return <>{children}</>;
  if (state === "checking") {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">
        Connecting to Kikoto...
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setVersion("");
    try {
      const normalized = normalizeServerURL(serverURL);
      const result = await api.health(normalized);
      setStoredServerURL(normalized);
      setVersion(result.version);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to connect to Kikoto.");
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-8">
      <section className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-5">
          <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-secondary text-secondary-foreground">
            {error ? <WifiOff className="h-5 w-5" /> : <Server className="h-5 w-5" />}
          </div>
          <h1 className="text-xl font-semibold">Connect to Kikoto</h1>
          <p className="mt-1 text-sm text-muted-foreground">Enter the address of your Kikoto server.</p>
        </div>

        <form className="space-y-3" onSubmit={submit}>
          <label className="grid gap-1.5 text-sm font-medium">
            Server address
            <input
              className="h-10 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={serverURL}
              onChange={(event) => setServerURL(event.target.value)}
              placeholder="http://192.168.1.20:7655"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
            />
          </label>
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {version && (
            <div className="rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">
              Server version {version}
            </div>
          )}
          <Button className="w-full">Connect</Button>
        </form>
      </section>
    </main>
  );
}
