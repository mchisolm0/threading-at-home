import { inspect } from "node:util";

import { redactSensitiveText } from "@oss-capacity/core";

export function sanitizeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : inspect(error, { depth: 1 });

  return sanitizeText(message);
}

export function sanitizeText(value: string): string {
  return redactSensitiveText(value);
}

export function redactDiagnosticValue<T>(value: T): T {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    return value;
  }

  return JSON.parse(sanitizeText(serialized)) as T;
}
