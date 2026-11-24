/** Decodes one percent-encoded URL path segment, or returns it unchanged when it is not valid encoding. */
export function safeDecodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
