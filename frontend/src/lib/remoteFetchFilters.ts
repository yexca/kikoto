/** Extension exclusions narrow the initial Fetch selection before a plan is requested. */
export function parseFetchExtensions(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\s,;，；]+/)
        .map((extension) => extension.trim().toLowerCase().replace(/^\./, ""))
        .filter(Boolean),
    ),
  );
}

export function filterRemoteFetchPaths(paths: string[], excludeExtensions: readonly string[] = []) {
  const excluded = new Set(parseFetchExtensions(excludeExtensions.join(",")));
  return paths.filter((path) => {
    const name = path.split(/[\\/]/).pop() ?? "";
    const dot = name.lastIndexOf(".");
    return dot < 0 || !excluded.has(name.slice(dot + 1).toLowerCase());
  });
}
