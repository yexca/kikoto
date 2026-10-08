import { AlertCircle, CheckCircle2 } from "lucide-react";

import { TokenInput } from "@/components/ui/token-input";
import { WORD_TOKEN_SEPARATORS } from "@/lib/tokenDraft";
import { isWorkCode } from "@/lib/workCode";

export type WorkCodesParseResult = {
  codes: string[];
  invalid: string[];
};

export function normalizeWorkCodeToken(token: string) {
  return token.trim().toUpperCase();
}

/** Splits the field's tokens into valid work codes and invalid entries, keeping their order. */
export function parseWorkCodes(values: readonly string[]): WorkCodesParseResult {
  const codes: string[] = [];
  const invalid: string[] = [];
  for (const value of values) {
    if (isWorkCode(value)) codes.push(value);
    else invalid.push(value);
  }
  return { codes, invalid };
}

export function WorkCodesField({
  value,
  onChange,
  className = "",
  readOnly = false,
  ariaLabel,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  className?: string;
  readOnly?: boolean;
  ariaLabel?: string;
}) {
  const parsed = parseWorkCodes(value);
  return (
    <div className={`space-y-2 ${className}`}>
      <TokenInput
        values={value}
        onChange={onChange}
        normalize={normalizeWorkCodeToken}
        isValid={isWorkCode}
        separators={WORD_TOKEN_SEPARATORS}
        readOnly={readOnly}
        placeholder={"RJ00000000, RJ00000001"}
        ariaLabel={ariaLabel}
        className="app-scrollbar max-h-48 overflow-y-auto"
        itemClassName="font-mono"
      />
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
          {parsed.codes.length} valid
        </span>
        <span className={`inline-flex items-center gap-1 ${parsed.invalid.length > 0 ? "text-error-foreground" : ""}`}>
          <AlertCircle className="h-3.5 w-3.5" />
          {parsed.invalid.length} invalid
        </span>
      </div>
    </div>
  );
}
