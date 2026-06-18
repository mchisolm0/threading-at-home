import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export const codexPackageLabel = "oss-capacity:codex";

export const minimumSupportedCodexVersion = "0.140.0";
export const defaultCodexTimeoutMs = 15_000;

export type CodexFailureCode =
  | "codex_unavailable"
  | "codex_unsupported_version"
  | "codex_timeout"
  | "codex_parse_error"
  | "codex_protocol_error"
  | "codex_unauthenticated"
  | "codex_rate_limit_unavailable";

export class CodexClientError extends Error {
  readonly code: CodexFailureCode;
  readonly retryable: boolean;

  constructor(input: {
    readonly code: CodexFailureCode;
    readonly message: string;
    readonly retryable?: boolean;
    readonly cause?: unknown;
  }) {
    super(input.message);
    this.name = "CodexClientError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.cause = input.cause;
  }
}

export type CodexAuthMode = "chatgpt" | "api_key" | "unknown";

export type CodexAccountSummary = {
  readonly type?: string;
  readonly planType?: string;
};

export type CodexAccountState = {
  readonly codexCliVersion?: string;
  readonly authenticated: boolean;
  readonly authMode: CodexAuthMode;
  readonly requiresOpenaiAuth?: boolean;
  readonly account?: CodexAccountSummary;
};

export type CodexRateLimit = {
  readonly type?: string;
  readonly usedPercent: number;
  readonly windowDurationMins?: number;
  readonly resetsAt?: string;
  readonly rateLimitReachedType?: string;
};

export type CodexRateLimitState = {
  readonly codexCliVersion?: string;
  readonly account: CodexAccountState;
  readonly rateLimits: readonly CodexRateLimit[];
  readonly rateLimitResetCredits?: number;
};

export type CodexRpcRequestOptions = {
  readonly timeoutMs?: number;
};

export type CodexAppServerTransport = {
  readonly request: (
    method: string,
    params?: unknown,
    options?: CodexRpcRequestOptions
  ) => Promise<unknown>;
  readonly notify: (method: string, params?: unknown) => void;
  readonly close: () => Promise<void> | void;
};

export type CodexVersionDetector = (input: {
  readonly codexBin: string;
  readonly timeoutMs: number;
}) => Promise<string>;

export type CodexClientOptions = {
  readonly codexBin?: string;
  readonly timeoutMs?: number;
  readonly minimumVersion?: string;
  readonly transport?: CodexAppServerTransport;
  readonly versionDetector?: CodexVersionDetector;
  readonly clientInfo?: {
    readonly name: string;
    readonly title: string;
    readonly version: string;
  };
};

export type CodexProcess = {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly kill: () => boolean;
  readonly on: (
    event: "error" | "exit",
    listener: (errorOrCode: Error | number | null, signal?: NodeJS.Signals | null) => void
  ) => CodexProcess;
};

export type CodexProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => CodexProcess;

type JsonRpcMessage = {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
};

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

type RawAccountReadResult = {
  readonly account?: unknown;
  readonly requiresOpenaiAuth?: unknown;
};

type RawRateLimitsReadResult = {
  readonly rateLimits?: unknown;
  readonly rateLimitResetCredits?: unknown;
};

const defaultClientInfo = {
  name: "oss_capacity",
  title: "OSS Capacity",
  version: "0.0.0"
};

const defaultSpawner: CodexProcessSpawner = (command, args, options) =>
  spawn(command, [...args], options) as ChildProcessWithoutNullStreams;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sanitizeAccount(
  result: RawAccountReadResult,
  codexCliVersion?: string
): CodexAccountState {
  const account = asObject(result.account);
  const accountSummary =
    account === undefined
      ? undefined
      : {
          type: asOptionalString(account.type),
          planType: asOptionalString(account.planType)
        };
  const hasAccountDetails =
    accountSummary !== undefined &&
    (accountSummary.type !== undefined || accountSummary.planType !== undefined);

  return {
    codexCliVersion,
    authenticated: account !== undefined,
    authMode: inferAuthMode(account),
    requiresOpenaiAuth:
      typeof result.requiresOpenaiAuth === "boolean"
        ? result.requiresOpenaiAuth
        : undefined,
    account: hasAccountDetails ? accountSummary : undefined
  };
}

function inferAuthMode(account: Record<string, unknown> | undefined): CodexAuthMode {
  const type = asOptionalString(account?.type)?.toLowerCase();

  if (type === "chatgpt" || type === "plan" || type === "openai") {
    return "chatgpt";
  }

  if (type === "api_key" || type === "api-key" || type === "apikey") {
    return "api_key";
  }

  return "unknown";
}

function sanitizeRateLimit(value: unknown): CodexRateLimit | undefined {
  const limit = asObject(value);
  const usedPercent = asOptionalNumber(limit?.usedPercent);

  if (limit === undefined || usedPercent === undefined) {
    return undefined;
  }

  return {
    type: asOptionalString(limit.type),
    usedPercent,
    windowDurationMins: asOptionalNumber(limit.windowDurationMins),
    resetsAt: asOptionalString(limit.resetsAt),
    rateLimitReachedType: asOptionalString(limit.rateLimitReachedType)
  };
}

function sanitizeRateLimits(result: RawRateLimitsReadResult): {
  readonly rateLimits: readonly CodexRateLimit[];
  readonly rateLimitResetCredits?: number;
} {
  const rawRateLimits = Array.isArray(result.rateLimits) ? result.rateLimits : [];
  const rateLimits = rawRateLimits
    .map((rateLimit) => sanitizeRateLimit(rateLimit))
    .filter((rateLimit): rateLimit is CodexRateLimit => rateLimit !== undefined);

  return {
    rateLimits,
    rateLimitResetCredits: asOptionalNumber(result.rateLimitResetCredits)
  };
}

function ensureInitialized(
  transport: CodexAppServerTransport,
  options: Required<Pick<CodexClientOptions, "timeoutMs" | "clientInfo">>
): Promise<void> {
  return withTimeout(
    async () => {
      await transport.request(
        "initialize",
        {
          clientInfo: options.clientInfo,
          capabilities: { experimentalApi: true }
        },
        { timeoutMs: options.timeoutMs }
      );
      transport.notify("initialized", {});
    },
    options.timeoutMs,
    "Timed out initializing Codex app-server"
  );
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new CodexClientError({
              code: "codex_timeout",
              message,
              retryable: true
            })
          );
          controller.abort();
        }, timeoutMs);
      })
    ]);
  } catch (error) {
    if (!(error instanceof CodexClientError) && isAbortError(error)) {
      throw new CodexClientError({
        code: "codex_timeout",
        message,
        retryable: true,
        cause: error
      });
    }
    throw error;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function createManagedTransport(options: {
  readonly codexBin: string;
  readonly timeoutMs: number;
  readonly transport?: CodexAppServerTransport;
}): Promise<{
  readonly transport: CodexAppServerTransport;
  readonly ownsTransport: boolean;
}> {
  if (options.transport !== undefined) {
    return {
      transport: options.transport,
      ownsTransport: false
    };
  }

  return {
    transport: createCodexAppServerTransport({
      codexBin: options.codexBin,
      timeoutMs: options.timeoutMs
    }),
    ownsTransport: true
  };
}

async function detectAndValidateVersion(options: {
  readonly codexBin: string;
  readonly timeoutMs: number;
  readonly minimumVersion: string;
  readonly versionDetector: CodexVersionDetector;
}): Promise<string> {
  const version = await withTimeout(
    () =>
      options.versionDetector({
        codexBin: options.codexBin,
        timeoutMs: options.timeoutMs
      }),
    options.timeoutMs,
    "Timed out detecting Codex CLI version"
  );

  if (compareVersions(version, options.minimumVersion) < 0) {
    throw new CodexClientError({
      code: "codex_unsupported_version",
      message: `Codex CLI ${version} is older than the supported minimum ${options.minimumVersion}`
    });
  }

  return version;
}

function normalizedClientOptions(options: CodexClientOptions = {}): Required<
  Pick<CodexClientOptions, "codexBin" | "timeoutMs" | "minimumVersion" | "versionDetector" | "clientInfo">
> & {
  readonly transport?: CodexAppServerTransport;
} {
  return {
    codexBin: options.codexBin ?? "codex",
    timeoutMs: options.timeoutMs ?? defaultCodexTimeoutMs,
    minimumVersion: options.minimumVersion ?? minimumSupportedCodexVersion,
    transport: options.transport,
    versionDetector: options.versionDetector ?? detectCodexCliVersion,
    clientInfo: options.clientInfo ?? defaultClientInfo
  };
}

export async function readCodexAccountState(
  options: CodexClientOptions = {}
): Promise<CodexAccountState> {
  const normalized = normalizedClientOptions(options);
  const codexCliVersion = await detectAndValidateVersion(normalized);
  const managed = await createManagedTransport(normalized);

  try {
    await ensureInitialized(managed.transport, normalized);
    const rawAccount = asObject(
      await withTimeout(
        () =>
          managed.transport.request(
            "account/read",
            { refreshToken: false },
            { timeoutMs: normalized.timeoutMs }
          ),
        normalized.timeoutMs,
        "Timed out reading Codex account state"
      )
    );

    if (rawAccount === undefined) {
      throw new CodexClientError({
        code: "codex_protocol_error",
        message: "Codex account/read returned an invalid response"
      });
    }

    return sanitizeAccount(rawAccount, codexCliVersion);
  } finally {
    if (managed.ownsTransport) {
      await managed.transport.close();
    }
  }
}

export async function readCodexRateLimits(
  options: CodexClientOptions = {}
): Promise<CodexRateLimitState> {
  const normalized = normalizedClientOptions(options);
  const codexCliVersion = await detectAndValidateVersion(normalized);
  const managed = await createManagedTransport(normalized);

  try {
    await ensureInitialized(managed.transport, normalized);
    const rawAccount = asObject(
      await withTimeout(
        () =>
          managed.transport.request(
            "account/read",
            { refreshToken: false },
            { timeoutMs: normalized.timeoutMs }
          ),
        normalized.timeoutMs,
        "Timed out reading Codex account state"
      )
    );

    if (rawAccount === undefined) {
      throw new CodexClientError({
        code: "codex_protocol_error",
        message: "Codex account/read returned an invalid response"
      });
    }

    const account = sanitizeAccount(rawAccount, codexCliVersion);

    if (!account.authenticated || account.requiresOpenaiAuth === true) {
      throw new CodexClientError({
        code: "codex_unauthenticated",
        message: "Codex account state is unavailable or unauthenticated"
      });
    }

    const rawRateLimits = asObject(
      await withTimeout(
        () =>
          managed.transport.request(
            "account/rateLimits/read",
            undefined,
            { timeoutMs: normalized.timeoutMs }
          ),
        normalized.timeoutMs,
        "Timed out reading Codex rate limits"
      )
    );

    if (rawRateLimits === undefined) {
      throw new CodexClientError({
        code: "codex_protocol_error",
        message: "Codex account/rateLimits/read returned an invalid response"
      });
    }

    const rateLimitState = sanitizeRateLimits(rawRateLimits);

    if (rateLimitState.rateLimits.length === 0) {
      throw new CodexClientError({
        code: "codex_rate_limit_unavailable",
        message: "Codex rate limits are unavailable"
      });
    }

    return {
      codexCliVersion,
      account,
      ...rateLimitState
    };
  } finally {
    if (managed.ownsTransport) {
      await managed.transport.close();
    }
  }
}

export function createCodexAppServerTransport(options: {
  readonly codexBin?: string;
  readonly timeoutMs?: number;
  readonly spawnProcess?: CodexProcessSpawner;
} = {}): CodexAppServerTransport {
  const codexBin = options.codexBin ?? "codex";
  const timeoutMs = options.timeoutMs ?? defaultCodexTimeoutMs;
  const spawnProcess = options.spawnProcess ?? defaultSpawner;
  const process = spawnProcess(codexBin, ["app-server"], {
    stdio: "pipe"
  });
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let closed = false;

  process.on("error", (error) => {
    rejectPending(
      pending,
      new CodexClientError({
        code: "codex_unavailable",
        message: "Codex app-server is unavailable",
        retryable: true,
        cause: error
      })
    );
  });

  process.on("exit", (codeOrError) => {
    if (!closed) {
      rejectPending(
        pending,
        new CodexClientError({
          code: "codex_unavailable",
          message: `Codex app-server exited before completing pending requests${
            typeof codeOrError === "number" ? ` (code ${codeOrError})` : ""
          }`,
          retryable: true
        })
      );
    }
  });

  process.stderr.on("data", () => {
    // Stderr can include local paths or account details. It is intentionally not retained.
  });

  const lines = createInterface({ input: process.stdout });
  lines.on("line", (line) => {
    let message: JsonRpcMessage;

    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      rejectPending(
        pending,
        new CodexClientError({
          code: "codex_parse_error",
          message: "Codex app-server emitted invalid JSON",
          retryable: true,
          cause: error
        })
      );
      return;
    }

    if (typeof message.id !== "number") {
      return;
    }

    const waiter = pending.get(message.id);

    if (waiter === undefined) {
      return;
    }

    pending.delete(message.id);
    clearTimeout(waiter.timeout);

    if (message.error !== undefined) {
      waiter.reject(
        new CodexClientError({
          code: "codex_protocol_error",
          message: "Codex app-server returned a JSON-RPC error",
          retryable: true
        })
      );
      return;
    }

    waiter.resolve(message.result);
  });

  function writeMessage(message: unknown): void {
    if (closed) {
      throw new CodexClientError({
        code: "codex_unavailable",
        message: "Codex app-server transport is closed",
        retryable: true
      });
    }

    process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  return {
    request(method, params, requestOptions) {
      const id = nextId;
      nextId += 1;

      return new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(
            new CodexClientError({
              code: "codex_timeout",
              message: `Timed out waiting for Codex app-server method ${method}`,
              retryable: true
            })
          );
        }, requestOptions?.timeoutMs ?? timeoutMs);

        pending.set(id, { resolve, reject, timeout });

        try {
          writeMessage({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timeout);
          reject(error);
        }
      });
    },
    notify(method, params) {
      writeMessage({ jsonrpc: "2.0", method, params });
    },
    close() {
      closed = true;
      lines.close();
      rejectPending(
        pending,
        new CodexClientError({
          code: "codex_unavailable",
          message: "Codex app-server transport closed",
          retryable: true
        })
      );
      process.kill();
    }
  };
}

function rejectPending(
  pending: Map<number, PendingRequest>,
  error: CodexClientError
): void {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
  pending.clear();
}

export async function detectCodexCliVersion(input: {
  readonly codexBin?: string;
  readonly timeoutMs?: number;
  readonly spawnProcess?: CodexProcessSpawner;
} = {}): Promise<string> {
  const codexBin = input.codexBin ?? "codex";
  const timeoutMs = input.timeoutMs ?? defaultCodexTimeoutMs;
  const spawnProcess = input.spawnProcess ?? defaultSpawner;

  return await withTimeout(
    (signal) =>
      new Promise<string>((resolve, reject) => {
        const process = spawnProcess(codexBin, ["--version"], {
          stdio: "pipe"
        });
        let stdout = "";
        let stderr = "";

        signal.addEventListener(
          "abort",
          () => {
            process.kill();
          },
          { once: true }
        );
        process.stdout.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        process.stderr.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        process.on("error", (error) => {
          reject(
            new CodexClientError({
              code: "codex_unavailable",
              message: "Codex CLI is unavailable",
              retryable: true,
              cause: error
            })
          );
        });
        process.on("exit", (codeOrError) => {
          if (typeof codeOrError === "number" && codeOrError !== 0) {
            reject(
              new CodexClientError({
                code: "codex_unavailable",
                message: `Codex CLI version command failed with exit code ${codeOrError}`,
                retryable: true
              })
            );
            return;
          }

          const version = parseCodexVersion(`${stdout}\n${stderr}`);

          if (version === undefined) {
            reject(
              new CodexClientError({
                code: "codex_protocol_error",
                message: "Unable to parse Codex CLI version output"
              })
            );
            return;
          }

          resolve(version);
        });
      }),
    timeoutMs,
    "Timed out detecting Codex CLI version"
  );
}

export function parseCodexVersion(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
}

export function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);

  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];

    if (difference !== 0) {
      return difference > 0 ? 1 : -1;
    }
  }

  if (isPrereleaseVersion(left) && !isPrereleaseVersion(right)) {
    return -1;
  }

  if (!isPrereleaseVersion(left) && isPrereleaseVersion(right)) {
    return 1;
  }

  return 0;
}

function isPrereleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version);
}

function versionParts(version: string): readonly [number, number, number] {
  const parsed = version.match(/^(\d+)\.(\d+)\.(\d+)/);

  if (parsed === null) {
    throw new CodexClientError({
      code: "codex_protocol_error",
      message: `Invalid Codex CLI version: ${version}`
    });
  }

  return [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
}
