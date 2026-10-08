/**
 * Separators that end a token in a multi-value field: ASCII, full-width, and
 * ideographic commas, semicolons, and line breaks. Spaces stay inside a token
 * so names such as "ASMR voice" keep working.
 */
export const TOKEN_SEPARATORS = /[,，、;；\r\n]+/u;

/** For values that never contain spaces, such as work codes and extensions. */
export const WORD_TOKEN_SEPARATORS = /[\s,，、;；]+/u;

/**
 * Splits typed or pasted text into finished tokens and the unfinished rest.
 * Only text before the last separator is finished, so "a, b" yields ["a"]
 * and keeps "b" in the field until another separator, Enter, or blur.
 */
export function splitTokenDraft(text: string, separators: RegExp = TOKEN_SEPARATORS) {
  const parts = text.split(separators);
  if (parts.length === 1) return { tokens: [] as string[], rest: text };
  const rest = (parts.pop() ?? "").trimStart();
  return { tokens: parts.map((part) => part.trim()).filter(Boolean), rest };
}

/**
 * Appends normalized additions in order, skipping empty values and any value
 * whose key is already present.
 */
export function appendTokens(
  values: readonly string[],
  additions: readonly string[],
  normalize: (token: string) => string = (token) => token.trim(),
  keyOf: (value: string) => string = (value) => value.toLowerCase(),
) {
  const next = [...values];
  const seen = new Set(values.map(keyOf));
  for (const addition of additions) {
    const value = normalize(addition);
    const key = keyOf(value);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    next.push(value);
  }
  return next;
}
