import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges classes at component boundaries that accept caller overrides. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
