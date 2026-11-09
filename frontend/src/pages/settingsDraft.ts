/**
 * The settings one change saves: its own fields and nothing else. A setting
 * elsewhere is not sent, so it is never revalidated and cannot make this save
 * fail.
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
 * The draft after a save of `keys` settles: those fields take `settled`, the
 * server's answer or, after a failure, the values saved before. A field still
 * being typed elsewhere keeps what was typed.
 */
export function draftAfterSave<Draft extends object>(
  draft: Draft,
  settled: Draft,
  keys: readonly (keyof Draft)[],
): Draft {
  return { ...draft, ...sectionSettings(settled, keys) };
}
