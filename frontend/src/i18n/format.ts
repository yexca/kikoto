import { intlLocaleFor, type ResolvedUiLocale } from "@/i18n";

// Intl formatter construction dominates per-call formatting cost, and card lists
// format several values per item on every render.
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

export function numberFormat(locale: ResolvedUiLocale, options?: Intl.NumberFormatOptions) {
  const key = `${locale}|${options ? JSON.stringify(options) : ""}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(intlLocaleFor(locale), options);
    numberFormats.set(key, format);
  }
  return format;
}

export function dateTimeFormat(locale: ResolvedUiLocale, options?: Intl.DateTimeFormatOptions) {
  const key = `${locale}|${options ? JSON.stringify(options) : ""}`;
  let format = dateTimeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(intlLocaleFor(locale), options);
    dateTimeFormats.set(key, format);
  }
  return format;
}

export function formatNumber(value: number, locale: ResolvedUiLocale) {
  return numberFormat(locale).format(value);
}

export function formatDateTime(value: string | number | Date, locale: ResolvedUiLocale) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatCurrency(value: number, currency: string, locale: ResolvedUiLocale) {
  return numberFormat(locale, { style: "currency", currency }).format(value);
}

export function formatList(values: readonly string[], locale: ResolvedUiLocale) {
  return new Intl.ListFormat(intlLocaleFor(locale), { style: "long", type: "conjunction" }).format(values);
}
