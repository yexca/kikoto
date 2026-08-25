import { type ClassValue, clsx } from "clsx";

/** Joins authored class conditions without applying Tailwind conflict rules. */
export function cx(...inputs: ClassValue[]) {
  return clsx(inputs);
}
