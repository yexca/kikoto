const zonelessTimestamp = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * Server timestamps are UTC. SQLite CURRENT_TIMESTAMP values and playback
 * times arrive without a zone designator, which Date would read as local time.
 */
export function parseServerTimestamp(value: string | null | undefined): Date | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const zoneless = zonelessTimestamp.exec(trimmed);
  const date = new Date(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}
