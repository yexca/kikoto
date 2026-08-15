import { intlLocaleFor, type ResolvedUiLocale } from "@/i18n";

export function formatNumber(value: number, locale: ResolvedUiLocale) {
  return new Intl.NumberFormat(intlLocaleFor(locale)).format(value);
}

export function formatDateTime(value: string | number | Date, locale: ResolvedUiLocale) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(intlLocaleFor(locale), { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatCurrency(value: number, currency: string, locale: ResolvedUiLocale) {
  return new Intl.NumberFormat(intlLocaleFor(locale), { style: "currency", currency }).format(value);
}

export function formatList(values: readonly string[], locale: ResolvedUiLocale) {
  return new Intl.ListFormat(intlLocaleFor(locale), { style: "long", type: "conjunction" }).format(values);
}
