import { redactSensitiveText } from "@oss-capacity/core";

export type RunnerMode = "stopped" | "interval";

export type CapacitySummary = {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly codexCliVersion?: string;
  readonly rateLimitUsedPercent?: number;
  readonly resetCredits?: number;
};

export type LogEntry = {
  readonly id: string;
  readonly modifiedAt?: string;
  readonly content: string;
};

export type RunnerSnapshot = {
  readonly running: boolean;
  readonly mode: RunnerMode;
  readonly intervalSeconds: number;
  readonly lastStartedAt?: string;
  readonly lastCompletedAt?: string;
  readonly lastExitCode?: number;
  readonly lastMessage?: string;
  readonly commandPreview: string;
  readonly capacity?: CapacitySummary;
  readonly trustBoundary: readonly string[];
};

export type RunnerViewModel = {
  readonly badgeTone: "good" | "warn" | "neutral";
  readonly statusLabel: string;
  readonly capacityLabel: string;
  readonly capacityReasons: readonly string[];
};

const defaultLogCharLimit = 4_000;
const defaultLineLimit = 80;

export function snapshotToViewModel(snapshot: RunnerSnapshot): RunnerViewModel {
  const capacity = snapshot.capacity;
  const runningLabel = snapshot.running ? "Runner loop active" : "Runner stopped";

  if (capacity === undefined) {
    return {
      badgeTone: snapshot.running ? "good" : "neutral",
      statusLabel: runningLabel,
      capacityLabel: "Capacity not checked yet",
      capacityReasons: []
    };
  }

  return {
    badgeTone: capacity.ok ? "good" : "warn",
    statusLabel: runningLabel,
    capacityLabel: capacity.ok ? "Capacity available" : "Capacity paused",
    capacityReasons: capacity.reasons
  };
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined) {
    return "Unknown";
  }

  return `${Math.round(value)}% used`;
}

export function boundAndRedactLog(
  value: string,
  options: {
    readonly maxChars?: number;
    readonly maxLines?: number;
  } = {}
): string {
  const maxChars = options.maxChars ?? defaultLogCharLimit;
  const maxLines = options.maxLines ?? defaultLineLimit;
  const redacted = redactSensitiveText(value);
  const lines = redacted.split(/\r?\n/);
  const boundedLines = lines.slice(Math.max(0, lines.length - maxLines));
  const bounded = boundedLines.join("\n");

  if (bounded.length <= maxChars) {
    return bounded;
  }

  return `[Earlier log content omitted]\n${bounded.slice(bounded.length - maxChars)}`;
}

export function reasonLabel(reason: string): string {
  return reason
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
