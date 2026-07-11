import { APP_CLIENT_VERSION, versionLabel } from "@/lib/appInfo";
import { getStoredServerURL, isNativeApp } from "@/lib/serverConfig";

type DiagnosticEvent = {
  at: string;
  kind: "api" | "connection" | "runtime";
  message: string;
  detail?: string;
};

const MAX_EVENTS = 30;
const events: DiagnosticEvent[] = [];

export function recordDiagnostic(event: Omit<DiagnosticEvent, "at">) {
  if (!isNativeApp()) return;
  events.push({ ...event, at: new Date().toISOString() });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function recordApiError(input: { method: string; path: string; status?: number; message: string }) {
  recordDiagnostic({
    kind: "api",
    message: `${input.method} ${input.path}${input.status ? ` -> ${input.status}` : ""}`,
    detail: input.message,
  });
}

export function buildMobileDiagnosticsText({
  serverVersion,
  connection,
  user,
}: {
  serverVersion?: string;
  connection?: string;
  user?: string;
}) {
  const lines = [
    "Kikoto Android diagnostics",
    `Generated: ${new Date().toISOString()}`,
    `Client: ${versionLabel()}`,
    `Client version: ${APP_CLIENT_VERSION}`,
    `Server: ${getStoredServerURL() || "not configured"}`,
    `Server version: ${serverVersion || "unknown"}`,
    `Connection: ${connection || "unknown"}`,
    `User: ${user || "anonymous"}`,
    `Online: ${navigator.onLine ? "yes" : "no"}`,
    "",
    "Recent events:",
  ];
  if (events.length === 0) {
    lines.push("- none");
  } else {
    for (const event of events) {
      lines.push(`- [${event.at}] ${event.kind}: ${event.message}`);
      if (event.detail) lines.push(`  ${event.detail}`);
    }
  }
  return lines.join("\n");
}
