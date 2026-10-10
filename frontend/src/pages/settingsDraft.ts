/**
 * The settings one section's Save sends: that section's own fields and nothing
 * else. A setting that belongs to another section is not sent, so it is never
 * revalidated and cannot make this save fail.
 */
export function sectionSettings<Draft extends object, Key extends keyof Draft>(
  draft: Draft,
  keys: readonly Key[],
): Pick<Draft, Key> {
  const section = {} as Pick<Draft, Key>;
  for (const key of keys) section[key] = draft[key];
  return section;
}

/**
 * The draft after one section was saved: the server's values, with the edits
 * still pending in the other sections kept as typed.
 */
export function draftAfterSectionSave<Draft extends object>(
  saved: Draft,
  draft: Draft,
  savedBefore: Draft,
  savedKeys: readonly (keyof Draft)[],
): Draft {
  const next = { ...saved };
  for (const key of Object.keys(draft) as Array<keyof Draft>) {
    if (!savedKeys.includes(key) && draft[key] !== savedBefore[key]) next[key] = draft[key];
  }
  return next;
}
