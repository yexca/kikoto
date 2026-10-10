/**
 * The value of a numeric field that only accepts whole numbers. A typed
 * fraction is dropped rather than sent: the server stores these settings as
 * integers and rejects anything else. Unparseable text stays NaN for the
 * caller's own validation.
 */
export function wholeNumberFromInput(text: string): number {
  const value = Number(text);
  return Number.isFinite(value) ? Math.trunc(value) : value;
}
