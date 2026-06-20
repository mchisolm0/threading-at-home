import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import { isTokenHash } from "./token.js";

export const runnerConfigSchemaVersion = 1;

export type RunnerConfig = {
  readonly schemaVersion: typeof runnerConfigSchemaVersion;
  readonly brokerUrl: string;
  readonly runnerId: string;
  readonly runnerAuthTokenHash: string;
  readonly displayName?: string;
  readonly codexBin: string;
  readonly maxOutputBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeenAt?: string;
};

export type RedactedRunnerConfig = Omit<RunnerConfig, "runnerAuthTokenHash"> & {
  readonly runnerAuthTokenHash: "[redacted]";
};

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OSS_CAPACITY_RUNNER_CONFIG) {
    return env.OSS_CAPACITY_RUNNER_CONFIG;
  }

  if (platform() === "win32" && env.APPDATA) {
    return join(env.APPDATA, "oss-capacity", "runner.json");
  }

  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "oss-capacity", "runner.json");
}

export async function readRunnerConfig(path: string): Promise<RunnerConfig> {
  const raw = await readFile(path, "utf8");
  return parseRunnerConfig(JSON.parse(raw));
}

export async function writeRunnerConfig(
  path: string,
  config: RunnerConfig
): Promise<void> {
  const parsed = parseRunnerConfig(config);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(path, 0o600);
}

export function parseRunnerConfig(value: unknown): RunnerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Runner config must be an object");
  }

  const config = value as Record<string, unknown>;
  const parsed = {
    schemaVersion: requireLiteral(config.schemaVersion, runnerConfigSchemaVersion, "schemaVersion"),
    brokerUrl: requireUrl(config.brokerUrl, "brokerUrl"),
    runnerId: requireString(config.runnerId, "runnerId"),
    runnerAuthTokenHash: requireTokenHash(config.runnerAuthTokenHash, "runnerAuthTokenHash"),
    displayName: optionalString(config.displayName, "displayName"),
    codexBin: requireString(config.codexBin, "codexBin"),
    maxOutputBytes: requirePositiveInteger(config.maxOutputBytes, "maxOutputBytes"),
    createdAt: requireIsoDateTime(config.createdAt, "createdAt"),
    updatedAt: requireIsoDateTime(config.updatedAt, "updatedAt"),
    lastSeenAt: optionalIsoDateTime(config.lastSeenAt, "lastSeenAt")
  };

  return parsed;
}

export function redactRunnerConfig(config: RunnerConfig): RedactedRunnerConfig {
  return {
    ...config,
    runnerAuthTokenHash: "[redacted]"
  };
}

function requireLiteral<T extends string | number>(
  value: unknown,
  expected: T,
  fieldName: string
): T {
  if (value !== expected) {
    throw new Error(`${fieldName} must be ${expected}`);
  }

  return expected;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireString(value, fieldName);
}

function requireUrl(value: unknown, fieldName: string): string {
  const stringValue = requireString(value, fieldName);

  try {
    const url = new URL(stringValue);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }

    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      throw new Error("http is only supported for local development");
    }

    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${fieldName} must be an http(s) URL`);
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function requireTokenHash(value: unknown, fieldName: string): string {
  const stringValue = requireString(value, fieldName);

  if (!isTokenHash(stringValue)) {
    throw new Error(`${fieldName} must be a sha256 token hash`);
  }

  return stringValue;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return value as number;
}

function requireIsoDateTime(value: unknown, fieldName: string): string {
  const stringValue = requireString(value, fieldName);

  if (Number.isNaN(Date.parse(stringValue))) {
    throw new Error(`${fieldName} must be an ISO date-time string`);
  }

  return stringValue;
}

function optionalIsoDateTime(value: unknown, fieldName: string): string | undefined {
  return value === undefined ? undefined : requireIsoDateTime(value, fieldName);
}
