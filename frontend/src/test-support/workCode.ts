export const syntheticWorkCodePrefixes = ["RJ", "BJ", "VJ", "CC"] as const;

export type SyntheticWorkCodePrefix = (typeof syntheticWorkCodePrefixes)[number];

const workCodesPerPrefix = 100;

export function syntheticWorkCode(prefix: SyntheticWorkCodePrefix, ordinal: number) {
  if (!syntheticWorkCodePrefixes.includes(prefix)) {
    throw new RangeError(`Unsupported synthetic work-code prefix: ${prefix}`);
  }
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= workCodesPerPrefix) {
    throw new RangeError(`Synthetic work-code ordinal is outside 0..99: ${ordinal}`);
  }
  return `${prefix}${String(ordinal).padStart(8, "0")}`;
}

export function syntheticWorkCodeAt(index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= syntheticWorkCodePrefixes.length * workCodesPerPrefix) {
    throw new RangeError(`Synthetic work-code index is outside 0..399: ${index}`);
  }
  return syntheticWorkCode(
    syntheticWorkCodePrefixes[Math.floor(index / workCodesPerPrefix)],
    index % workCodesPerPrefix,
  );
}
