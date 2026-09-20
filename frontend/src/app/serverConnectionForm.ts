export type ServerProtocol = "http" | "https";

export function serverFormFromURL(value: string): { protocol: ServerProtocol; address: string; port: string } {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    return {
      protocol: parsed.protocol === "https:" ? "https" : "http",
      address: `${hostname}${parsed.pathname !== "/" ? parsed.pathname : ""}`,
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return { protocol: "http", address: value, port: "7655" };
  }
}

export function serverURLFromForm(protocol: ServerProtocol, address: string, port: string) {
  const nextAddress = address.trim().replace(/^https?:\/\//i, "");
  const separator = nextAddress.indexOf("/");
  const host = separator >= 0 ? nextAddress.slice(0, separator) : nextAddress;
  const path = separator >= 0 ? nextAddress.slice(separator) : "";
  const bracketedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${protocol}://${bracketedHost}:${port.trim()}${path}`;
}
