import { useMemo } from "react";

import { NativeSelect } from "@/components/ui/input";
import { timeZoneNames, timeZoneOffset } from "@/lib/timeZone";

/**
 * Chooses an IANA time zone, or the empty value that follows the device. Each
 * zone shows its current offset; the list holds every zone this browser knows
 * plus the ones already in use.
 */
export function TimeZoneSelect({
  id,
  value,
  followLabel,
  inUse,
  disabled,
  ariaLabel,
  onChange,
}: {
  id?: string;
  /** An IANA zone name, or an empty string to follow the device. */
  value: string;
  /** Names the option that follows the device, with the zone it resolves to. */
  followLabel: string;
  /** Zones offered even when this browser does not list them. */
  inUse: ReadonlyArray<string | null | undefined>;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
}) {
  const inUseKey = inUse.filter(Boolean).join("|");
  const options = useMemo(() => {
    const now = new Date();
    return timeZoneNames(value, ...inUseKey.split("|")).map((name) => {
      const offset = timeZoneOffset(name, now);
      return { name, label: offset ? `${name} (${offset})` : name };
    });
  }, [inUseKey, value]);
  return (
    <NativeSelect
      id={id}
      className="w-48 max-w-full sm:w-72"
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{followLabel}</option>
      {options.map((option) => (
        <option key={option.name} value={option.name}>
          {option.label}
        </option>
      ))}
    </NativeSelect>
  );
}
