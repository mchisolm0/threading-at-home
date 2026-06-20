import type { JsonValue, ResultPackage } from "@oss-capacity/core";

export type StructuredEntry = {
  readonly key: string;
  readonly label: string;
  readonly value: JsonValue;
};

export function formatLabel(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

export function formatDurationMs(startedAt: string, completedAt: string): string {
  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);

  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "unknown";
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  const seconds = Math.round(durationMs / 100) / 10;

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);

  return `${minutes}m ${remainingSeconds}s`;
}

export function formatNumber(value: number | undefined): string {
  return value === undefined ? "not reported" : new Intl.NumberFormat("en-US").format(value);
}

export function totalCommandDurationMs(resultPackage: ResultPackage): number {
  return resultPackage.commandSummaries.reduce(
    (total, command) => total + command.durationMs,
    0
  );
}

export function structuredEntries(value: JsonValue): readonly StructuredEntry[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => ({
      key: String(index),
      label: `Item ${index + 1}`,
      value: item
    }));
  }

  if (typeof value === "object" && value !== null) {
    return Object.entries(value).map(([key, item]) => ({
      key,
      label: formatLabel(key),
      value: item
    }));
  }

  return [];
}

export function isStructuredContainer(value: JsonValue): boolean {
  return typeof value === "object" && value !== null;
}
