import {
  readCodexAccountState,
  readCodexRateLimits,
  runCodexExec,
  type CodexAccountState,
  type CodexRateLimitState
} from "@oss-capacity/codex";

import { createBrokerClient, type BrokerClient } from "./broker.js";
import { buildRunnerCapability, createRunnerId } from "./capabilities.js";
import {
  defaultConfigPath,
  parseRunnerConfig,
  readRunnerConfig,
  redactRunnerConfig,
  runnerConfigSchemaVersion,
  writeRunnerConfig,
  type RunnerConfig
} from "./config.js";
import { defaultRunnerStatePath, runOnce } from "./runLoop.js";
import { redactDiagnosticValue, sanitizeError } from "./sanitize.js";
import { createLocalRunnerAuthHash, hashToken } from "./token.js";
import type { WorkspaceDependencies } from "./workspace.js";

const defaultMaxOutputBytes = 2 * 1024 * 1024;

export type CliIO = {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly env: NodeJS.ProcessEnv;
};

export type CliDependencies = {
  readonly now?: () => Date;
  readonly readConfig?: typeof readRunnerConfig;
  readonly writeConfig?: typeof writeRunnerConfig;
  readonly createBrokerClient?: typeof createBrokerClient;
  readonly readCodexAccountState?: typeof readCodexAccountState;
  readonly readCodexRateLimits?: typeof readCodexRateLimits;
  readonly runCodexExec?: typeof runCodexExec;
  readonly createRunnerId?: typeof createRunnerId;
  readonly createLocalRunnerAuthHash?: typeof createLocalRunnerAuthHash;
} & WorkspaceDependencies;

type ParsedArgs = {
  readonly command: string;
  readonly options: Readonly<Record<string, string | boolean>>;
};

type DiagnosticCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: unknown;
  readonly error?: string;
};

export async function runCli(
  argv: readonly string[],
  io: CliIO = {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env
  },
  dependencies: CliDependencies = {}
): Promise<number> {
  const parsed = parseArgs(argv);
  const now = dependencies.now ?? (() => new Date());

  try {
    switch (parsed.command) {
      case "login":
      case "setup":
        await login(parsed, io, dependencies, now);
        return 0;
      case "heartbeat":
        await heartbeat(parsed, io, dependencies, now);
        return 0;
      case "policy":
        await printPolicy(parsed, io, dependencies);
        return 0;
      case "subscriptions":
        await printSubscriptions(parsed, io, dependencies);
        return 0;
      case "diagnose":
      case "diagnostics":
      case "doctor":
        await diagnose(parsed, io, dependencies);
        return 0;
      case "run-once":
      case "once":
        return await runOnceCommand(parsed, io, dependencies);
      case "help":
      case "--help":
      case "-h":
        writeText(io.stdout, helpText());
        return 0;
      default:
        throw new Error(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    writeText(io.stderr, `${formatError(error)}\n`);
    return 1;
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const equalIndex = arg.indexOf("=");

    if (equalIndex > 0) {
      options[arg.slice(2, equalIndex)] = arg.slice(equalIndex + 1);
      continue;
    }

    const key = arg.slice(2);
    const next = rest[index + 1];

    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }

  return { command, options };
}

async function login(
  parsed: ParsedArgs,
  io: CliIO,
  dependencies: CliDependencies,
  now: () => Date
): Promise<void> {
  const configPath = optionString(parsed, "config") ?? defaultConfigPath(io.env);
  const brokerUrl = requiredOption(
    optionString(parsed, "broker-url") ??
      optionString(parsed, "convex-url") ??
      io.env.OSS_CAPACITY_CONVEX_URL,
    "Pass --broker-url or set OSS_CAPACITY_CONVEX_URL"
  );
  const setupToken = requiredOption(
    optionString(parsed, "setup-token") ??
      optionString(parsed, "token") ??
      io.env.OSS_CAPACITY_RUNNER_SETUP_TOKEN,
    "Pass --setup-token, --token, or set OSS_CAPACITY_RUNNER_SETUP_TOKEN"
  );
  const codexBin = optionString(parsed, "codex-bin") ?? "codex";
  const displayName = optionString(parsed, "name");
  const maxOutputBytes = parsePositiveIntegerOption(
    optionString(parsed, "max-output-bytes"),
    defaultMaxOutputBytes,
    "max-output-bytes"
  );
  const timestamp = now().toISOString();
  const config: RunnerConfig = {
    schemaVersion: runnerConfigSchemaVersion,
    brokerUrl,
    runnerId: (dependencies.createRunnerId ?? createRunnerId)(),
    runnerAuthTokenHash:
      (dependencies.createLocalRunnerAuthHash ?? createLocalRunnerAuthHash)(),
    displayName,
    codexBin,
    maxOutputBytes,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const codexAccount = await readOptionalCodexAccount(config, dependencies);
  const runner = buildRunnerCapability({
    config,
    codexAccount,
    now: timestamp
  });
  const broker = createClient(config.brokerUrl, dependencies);
  const registration = await broker.exchangeRunnerSetupToken({
    tokenHash: hashToken(setupToken),
    runnerAuthTokenHash: config.runnerAuthTokenHash,
    runner,
    now: timestamp
  });

  await (dependencies.writeConfig ?? writeRunnerConfig)(configPath, {
    ...config,
    lastSeenAt: registration.lastSeenAt,
    updatedAt: timestamp
  });
  writeJson(io.stdout, {
    ok: true,
    command: "login",
    runner: registration,
    config: {
      present: true,
      value: redactRunnerConfig({
        ...config,
        lastSeenAt: registration.lastSeenAt,
        updatedAt: timestamp
      })
    },
    codex: codexAccountToDiagnostic(codexAccount)
  });
}

async function heartbeat(
  parsed: ParsedArgs,
  io: CliIO,
  dependencies: CliDependencies,
  now: () => Date
): Promise<void> {
  const configPath = optionString(parsed, "config") ?? defaultConfigPath(io.env);
  const config = await (dependencies.readConfig ?? readRunnerConfig)(configPath);
  const timestamp = now().toISOString();
  const codexAccount = await readOptionalCodexAccount(config, dependencies);
  const runner = buildRunnerCapability({
    config,
    codexAccount,
    now: timestamp
  });
  const registration = await createClient(
    config.brokerUrl,
    dependencies
  ).heartbeatRunner({
    runnerId: config.runnerId,
    runnerAuthTokenHash: config.runnerAuthTokenHash,
    runner,
    now: timestamp
  });

  await (dependencies.writeConfig ?? writeRunnerConfig)(configPath, {
    ...config,
    updatedAt: timestamp,
    lastSeenAt: registration.lastSeenAt
  });
  writeJson(io.stdout, {
    ok: true,
    command: "heartbeat",
    runner: registration
  });
}

async function printPolicy(
  parsed: ParsedArgs,
  io: CliIO,
  dependencies: CliDependencies
): Promise<void> {
  const configuration = await fetchRunnerConfiguration(parsed, io, dependencies);

  writeJson(io.stdout, {
    ok: true,
    policy: configuration.policy
  });
}

async function printSubscriptions(
  parsed: ParsedArgs,
  io: CliIO,
  dependencies: CliDependencies
): Promise<void> {
  const configuration = await fetchRunnerConfiguration(parsed, io, dependencies);

  writeJson(io.stdout, {
    ok: true,
    subscriptions: configuration.subscriptions
  });
}

async function diagnose(
  parsed: ParsedArgs,
  io: CliIO,
  dependencies: CliDependencies
): Promise<void> {
  const configPath = optionString(parsed, "config") ?? defaultConfigPath(io.env);
  const checks: DiagnosticCheck[] = [];
  let config: RunnerConfig | undefined;

  try {
    config = parseRunnerConfig(
      await (dependencies.readConfig ?? readRunnerConfig)(configPath)
    );
    checks.push({
      name: "config",
      ok: true,
      detail: {
        present: true,
        value: redactRunnerConfig(config)
      }
    });
  } catch (error) {
    checks.push({
      name: "config",
      ok: false,
      error: sanitizeError(error)
    });
  }

  if (config !== undefined) {
    try {
      const configuration = await createClient(
        config.brokerUrl,
        dependencies
      ).runnerConfiguration({
        runnerId: config.runnerId,
        runnerAuthTokenHash: config.runnerAuthTokenHash
      });

      checks.push({
        name: "broker",
        ok: true,
        detail: {
          runner: configuration.runner,
          policyPresent: configuration.policy !== null,
          subscriptionCount: configuration.subscriptions.length
        }
      });
    } catch (error) {
      checks.push({
        name: "broker",
        ok: false,
        error: sanitizeError(error)
      });
    }

    try {
      const account = await (dependencies.readCodexAccountState ?? readCodexAccountState)({
        codexBin: config.codexBin
      });

      checks.push({
        name: "codex-account",
        ok: account.authenticated && account.requiresOpenaiAuth !== true,
        detail: codexAccountToDiagnostic(account)
      });
    } catch (error) {
      checks.push({
        name: "codex-account",
        ok: false,
        error: sanitizeError(error)
      });
    }

    try {
      const rateLimits = await (dependencies.readCodexRateLimits ?? readCodexRateLimits)({
        codexBin: config.codexBin
      });

      checks.push({
        name: "codex-rate-limits",
        ok: true,
        detail: codexRateLimitsToDiagnostic(rateLimits)
      });
    } catch (error) {
      checks.push({
        name: "codex-rate-limits",
        ok: false,
        error: sanitizeError(error)
      });
    }
  }

  writeJson(io.stdout, {
    ok: checks.every((check) => check.ok),
    checks
  });
}

async function runOnceCommand(
  parsed: ParsedArgs,
  io: CliIO,
  dependencies: CliDependencies
): Promise<number> {
  const configPath = optionString(parsed, "config") ?? defaultConfigPath(io.env);
  const config = await (dependencies.readConfig ?? readRunnerConfig)(configPath);
  const workspaceRoot =
    optionString(parsed, "workspace-dir") ??
    io.env.OSS_CAPACITY_RUNNER_WORKSPACE_DIR ??
    defaultRunnerStatePath("workspaces", io.env);
  const logRoot =
    optionString(parsed, "log-dir") ??
    io.env.OSS_CAPACITY_RUNNER_LOG_DIR ??
    defaultRunnerStatePath("logs", io.env);
  const result = await runOnce({
    config,
    broker: createClient(config.brokerUrl, dependencies),
    workspaceRoot,
    logRoot,
    taskRequestId: optionString(parsed, "task-request-id"),
    leaseMinutes: parsePositiveIntegerOption(
      optionString(parsed, "lease-minutes"),
      30,
      "lease-minutes"
    ),
    codexTimeoutMs: parsePositiveIntegerOption(
      optionString(parsed, "codex-timeout-ms"),
      10 * 60 * 1000,
      "codex-timeout-ms"
    ),
    dependencies
  });

  writeJson(io.stdout, result);
  return result.ok ? 0 : 1;
}

async function fetchRunnerConfiguration(
  parsed: ParsedArgs,
  io: CliIO,
  dependencies: CliDependencies
) {
  const configPath = optionString(parsed, "config") ?? defaultConfigPath(io.env);
  const config = await (dependencies.readConfig ?? readRunnerConfig)(configPath);

  return await createClient(config.brokerUrl, dependencies).runnerConfiguration({
    runnerId: config.runnerId,
    runnerAuthTokenHash: config.runnerAuthTokenHash
  });
}

async function readOptionalCodexAccount(
  config: Pick<RunnerConfig, "codexBin">,
  dependencies: CliDependencies
): Promise<CodexAccountState | undefined> {
  try {
    return await (dependencies.readCodexAccountState ?? readCodexAccountState)({
      codexBin: config.codexBin
    });
  } catch {
    return undefined;
  }
}

function createClient(
  brokerUrl: string,
  dependencies: CliDependencies
): BrokerClient {
  return (dependencies.createBrokerClient ?? createBrokerClient)(brokerUrl);
}

function optionString(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.options[key];

  if (typeof value !== "string") {
    return undefined;
  }

  return value;
}

function requiredOption(value: string | undefined, message: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(message);
  }

  return value.trim();
}

function parsePositiveIntegerOption(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function codexAccountToDiagnostic(account: CodexAccountState | undefined) {
  if (account === undefined) {
    return {
      available: false
    };
  }

  return {
    available: true,
    codexCliVersion: account.codexCliVersion,
    authenticated: account.authenticated,
    authMode: account.authMode,
    requiresOpenaiAuth: account.requiresOpenaiAuth,
    account: redactDiagnosticValue(account.account)
  };
}

function codexRateLimitsToDiagnostic(rateLimits: CodexRateLimitState) {
  return {
    codexCliVersion: rateLimits.codexCliVersion,
    rateLimits: rateLimits.rateLimits,
    rateLimitResetCredits: rateLimits.rateLimitResetCredits
  };
}

function writeJson(stream: Pick<NodeJS.WriteStream, "write">, value: unknown): void {
  writeText(stream, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(stream: Pick<NodeJS.WriteStream, "write">, value: string): void {
  stream.write(value);
}

function formatError(error: unknown): string {
  return `Error: ${sanitizeError(error)}`;
}

function helpText(): string {
  return `OSS Capacity runner

Usage:
  oss-capacity-runner login --broker-url <url> --setup-token <token> [--name <label>]
  oss-capacity-runner heartbeat
  oss-capacity-runner run-once
  oss-capacity-runner policy
  oss-capacity-runner subscriptions
  oss-capacity-runner diagnose

Options:
  --config <path>            Override the local runner config path.
  --broker-url <url>         Convex deployment URL for setup.
  --setup-token <token>      Browser-generated runner setup token for setup.
  --token <token>            Alias for --setup-token.
  --codex-bin <command>      Codex CLI command, default: codex.
  --max-output-bytes <n>     Local output preference for future runs.
  --workspace-dir <path>     Override the local repository cache directory.
  --log-dir <path>           Override the local sanitized runner log directory.
  --task-request-id <id>     Request a specific eligible task.
  --lease-minutes <n>        Lease duration for run-once, default: 30.
  --codex-timeout-ms <n>     Codex execution timeout for run-once.
`;
}
