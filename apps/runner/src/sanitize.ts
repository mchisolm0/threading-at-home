import { inspect } from "node:util";

export function sanitizeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : inspect(error, { depth: 1 });

  return sanitizeText(message);
}

export function sanitizeText(value: string): string {
  return value
    .replace(/sha256:[a-f0-9]{64}/gi, "[redacted]")
    .replace(/ocr_[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .replace(/(^|[\s'"])(\/(?:Users|home|tmp|var|private)\/[^ "'\n]+)/g, "$1[redacted-path]")
    .replace(/\/Users\/[^ "'\n]+/g, "[redacted-path]")
    .replace(/\\Users\\[^ "'\n]+/g, "[redacted-path]");
}

export function redactDiagnosticValue<T>(value: T): T {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    return value;
  }

  return JSON.parse(sanitizeText(serialized)) as T;
}
