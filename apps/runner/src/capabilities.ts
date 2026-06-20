import { arch, platform } from "node:os";
import { randomUUID } from "node:crypto";

import {
  parseRunnerCapability,
  type RunnerCapability,
  type RunnerCapabilityKey,
  type TaskType
} from "@oss-capacity/core";
import type { CodexAccountState } from "@oss-capacity/codex";

import type { RunnerConfig } from "./config.js";

const supportedTaskTypes: readonly TaskType[] = [
  "analysis",
  "triage",
  "test_investigation",
  "docs_draft",
  "security_review",
  "dependency_review"
];

const baseCapabilities: readonly RunnerCapabilityKey[] = [
  "codex.version_detection",
  "sandbox.read_only",
  "network.disabled",
  "command.summary"
];

export function createRunnerId(): string {
  return `runner-${randomUUID()}`;
}

export function buildRunnerCapability(input: {
  readonly config: Pick<
    RunnerConfig,
    "runnerId" | "displayName" | "createdAt" | "maxOutputBytes"
  >;
  readonly now: string;
  readonly codexAccount?: CodexAccountState;
}): Omit<RunnerCapability, "volunteerUserId"> {
  const capabilities = new Set<RunnerCapabilityKey>(baseCapabilities);

  if (input.codexAccount?.authenticated === true) {
    capabilities.add("codex.app_server.rate_limits");
  }

  const runner = {
    runnerId: input.config.runnerId,
    volunteerUserId: "local-validation-placeholder",
    displayName: input.config.displayName,
    platform: normalizePlatform(platform()),
    architecture: normalizeArchitecture(arch()),
    codexCliVersion: input.codexAccount?.codexCliVersion,
    codexAuthMode: normalizeCodexAuthMode(input.codexAccount?.authMode),
    supportedSandboxModes: ["read-only"],
    supportsNetwork: false,
    supportsPatchCapture: false,
    supportedTaskTypes,
    supportedCapabilities: [...capabilities],
    maxOutputBytes: input.config.maxOutputBytes,
    registeredAt: input.config.createdAt,
    lastSeenAt: input.now
  };

  const parsed = parseRunnerCapability(runner);

  return {
    runnerId: parsed.runnerId,
    displayName: parsed.displayName,
    platform: parsed.platform,
    architecture: parsed.architecture,
    codexCliVersion: parsed.codexCliVersion,
    codexAuthMode: parsed.codexAuthMode,
    supportedSandboxModes: parsed.supportedSandboxModes,
    supportsNetwork: parsed.supportsNetwork,
    supportsPatchCapture: parsed.supportsPatchCapture,
    supportedTaskTypes: parsed.supportedTaskTypes,
    supportedCapabilities: parsed.supportedCapabilities,
    maxOutputBytes: parsed.maxOutputBytes,
    registeredAt: parsed.registeredAt,
    lastSeenAt: parsed.lastSeenAt
  };
}

function normalizePlatform(value: NodeJS.Platform): RunnerCapability["platform"] {
  if (value === "darwin" || value === "linux" || value === "win32") {
    return value;
  }

  return "unknown";
}

function normalizeArchitecture(value: string): RunnerCapability["architecture"] {
  if (value === "arm64" || value === "x64") {
    return value;
  }

  return "unknown";
}

function normalizeCodexAuthMode(
  value: string | undefined
): RunnerCapability["codexAuthMode"] {
  return value === "chatgpt" || value === "api_key" ? value : "unknown";
}
