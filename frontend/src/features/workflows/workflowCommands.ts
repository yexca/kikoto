import { parseWorkflowDefinition, type WorkflowInputDefinition } from "./definitionModel";
import type { WorkflowDefinition } from "@/lib/api";

export type ParsedWorkflowCommand = {
  isCommand: boolean;
  alias: string;
  arguments: string[];
  error: string;
};

export type WorkflowCommandValues = {
  values: Record<string, string>;
  errors: string[];
};

export type PublishedWorkflowCommand = {
  definition: WorkflowDefinition;
  alias: string;
  document: Extract<ReturnType<typeof parseWorkflowDefinition>, { kind: "v2" }>["document"];
};

export function publishedWorkflowCommandsForUser(definitions: WorkflowDefinition[], currentUserId: number | null) {
  if (currentUserId === null) return [];
  return definitions.flatMap((definition): PublishedWorkflowCommand[] => {
    if (definition.scope !== "user" || definition.ownerUserId !== currentUserId) return [];
    const parsed = parseWorkflowDefinition(definition.definitionJson);
    if (parsed.kind !== "v2" || !parsed.document.command.enabled || !parsed.document.command.alias.trim()) return [];
    return [{ definition, alias: parsed.document.command.alias, document: parsed.document }];
  });
}

export function parseWorkflowCommand(query: string): ParsedWorkflowCommand {
  const trimmed = query.trim();
  if (!trimmed.startsWith("/")) return { isCommand: false, alias: "", arguments: [], error: "" };
  const tokenized = tokenize(trimmed.slice(1));
  if (tokenized.error) return { isCommand: true, alias: tokenized.tokens[0] ?? "", arguments: tokenized.tokens.slice(1), error: tokenized.error };
  return {
    isCommand: true,
    alias: tokenized.tokens[0] ?? "",
    arguments: tokenized.tokens.slice(1),
    error: "",
  };
}

export function workflowCommandInputValues(arguments_: string[], inputs: WorkflowInputDefinition[]): WorkflowCommandValues {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const errors: string[] = [];
  const inputMap = new Map(inputs.map((input) => [input.key.toLowerCase(), input]));
  const named: string[] = [];
  const positional: string[] = [];
  for (const argument of arguments_) {
    const separator = argument.indexOf("=");
    const key = separator >= 0 ? argument.slice(0, separator).trim().toLowerCase() : "";
    if (separator >= 0 && (inputs.length !== 1 || key === inputs[0].key.toLowerCase())) named.push(argument);
    else positional.push(argument);
  }

  for (const argument of named) {
    const separator = argument.indexOf("=");
    const key = argument.slice(0, separator).trim();
    const value = argument.slice(separator + 1).trim();
    const input = inputMap.get(key.toLowerCase());
    if (!input) {
      errors.push(`Unknown input: ${key}.`);
      continue;
    }
    if (hasOwn(values, input.key)) {
      errors.push(`Input ${input.key} was provided more than once.`);
      continue;
    }
    values[input.key] = value;
  }

  if (positional.length > 0) {
    if (inputs.length !== 1) {
      errors.push("Use key=value arguments when a workflow has multiple inputs.");
    } else if (hasOwn(values, inputs[0].key)) {
      errors.push(`Input ${inputs[0].key} was provided more than once.`);
    } else {
      values[inputs[0].key] = positional.join(" ");
    }
  }

  for (const input of inputs) {
    if (!hasOwn(values, input.key) && input.defaultValue !== undefined) values[input.key] = input.defaultValue;
    const value = values[input.key]?.trim() ?? "";
    if (input.required && !value) errors.push(`${input.label || input.key} is required.`);
    if (!value) continue;
    const validation = validateInputValue(input.type, value);
    if (validation) errors.push(`${input.label || input.key}: ${validation}`);
    values[input.key] = value;
  }
  return { values, errors };
}

export function workflowCommandUsage(alias: string, inputs: WorkflowInputDefinition[]) {
  if (inputs.length === 0) return `/${alias}`;
  if (inputs.length === 1) return `/${alias} <${inputs[0].key}>`;
  return `/${alias} ${inputs.map((input) => `${input.key}=<value>`).join(" ")}`;
}

export function workflowRunInputPayload(inputs: WorkflowInputDefinition[], values: Record<string, unknown>) {
  return Object.fromEntries(inputs.flatMap((input) => {
    const value = values[input.key];
    if (!input.required && (value === null || value === undefined || (typeof value === "string" && value.trim() === ""))) return [];
    return [[input.key, value]];
  }));
}

function validateInputValue(type: WorkflowInputDefinition["type"], value: string) {
  if (type === "circle_id" && !/^[RBV]G\d{5,8}$/i.test(value)) return "use a DLsite circle id such as RG01234.";
  if (type === "work_code" && !/^(RJ|BJ|VJ|CC)\d{4,8}$/i.test(value)) return "use a supported work code.";
  return "";
}

function tokenize(value: string): { tokens: string[]; error: string } {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return { tokens, error: quote ? "Close the quoted argument." : "" };
}

function hasOwn(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
