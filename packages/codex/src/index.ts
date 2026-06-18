import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
  | "codex_rate_limit_unavailable"
  | "codex_exec_failed"
  | "codex_cancelled";

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

export class CodexExecError extends CodexClientError {
  readonly logs: readonly CodexExecLogEntry[];

  constructor(input: {
    readonly code: CodexFailureCode;
    readonly message: string;
    readonly retryable?: boolean;
    readonly cause?: unknown;
    readonly logs?: readonly CodexExecLogEntry[];
  }) {
    super(input);
    this.name = "CodexExecError";
    this.logs = input.logs ?? [];
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
  readonly signal?: AbortSignal;
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
    event: "close" | "error" | "exit",
    listener: (errorOrCode: Error | number | null, signal?: NodeJS.Signals | null) => void
  ) => CodexProcess;
};

export type CodexProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => CodexProcess;

export type CodexExecSandboxMode = "read-only" | "workspace-write";

export type CodexExecOutputSchema =
  | {
      readonly path: string;
    }
  | {
      readonly schema: Record<string, unknown>;
    };

export type CodexExecOptions = {
  readonly codexBin?: string;
  readonly prompt: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly minimumVersion?: string;
  readonly versionDetector?: CodexVersionDetector;
  readonly spawnProcess?: CodexProcessSpawner;
  readonly outputSchema?: CodexExecOutputSchema;
  readonly structuredOutputPath?: string;
  readonly sandbox?: CodexExecSandboxMode;
  readonly model?: string;
  readonly profile?: string;
  readonly config?: Readonly<Record<string, string | number | boolean>>;
  readonly signal?: AbortSignal;
  readonly logLimit?: number;
};

export type CodexExecUsage = {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
};

export type CodexExecEvent = {
  readonly type: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemType?: string;
  readonly usage?: CodexExecUsage;
  readonly finalMessage?: string;
  readonly structuredOutputPath?: string;
};

export type CodexExecLogEntry = {
  readonly stream: "stdout" | "stderr" | "process";
  readonly message: string;
};

export type CodexExecStructuredOutput = {
  readonly path: string;
  readonly text: string;
  readonly json?: unknown;
};

export type CodexExecResult = {
  readonly codexCliVersion: string;
  readonly finalMessage?: string;
  readonly structuredOutput?: CodexExecStructuredOutput;
  readonly events: readonly CodexExecEvent[];
  readonly usage?: CodexExecUsage;
  readonly logs: readonly CodexExecLogEntry[];
  readonly exitCode: number;
};

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

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
  message: string,
  options: {
    readonly signal?: AbortSignal;
    readonly abortError?: CodexClientError;
  } = {}
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  try {
    if (options.signal?.aborted === true) {
      throw (
        options.abortError ??
        new CodexClientError({
          code: "codex_cancelled",
          message: "Codex operation was cancelled",
          retryable: true
        })
      );
    }

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
      }),
      new Promise<never>((_, reject) => {
        if (options.signal === undefined) {
          return;
        }

        abortListener = () => {
          controller.abort();
          reject(
            options.abortError ??
              new CodexClientError({
                code: "codex_cancelled",
                message: "Codex operation was cancelled",
                retryable: true
              })
          );
        };
        options.signal.addEventListener("abort", abortListener, { once: true });
      })
    ]);
  } catch (error) {
    if (!(error instanceof CodexClientError) && isAbortError(error)) {
      if (options.signal?.aborted === true) {
        throw (
          options.abortError ??
          new CodexClientError({
            code: "codex_cancelled",
            message: "Codex operation was cancelled",
            retryable: true,
            cause: error
          })
        );
      }

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
    if (abortListener !== undefined) {
      options.signal?.removeEventListener("abort", abortListener);
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
  readonly signal?: AbortSignal;
}): Promise<string> {
  const version = await withTimeout(
    (signal) =>
      options.versionDetector({
        codexBin: options.codexBin,
        timeoutMs: options.timeoutMs,
        signal
      }),
    options.timeoutMs,
    "Timed out detecting Codex CLI version",
    {
      signal: options.signal,
      abortError: new CodexClientError({
        code: "codex_cancelled",
        message: "Codex CLI version detection was cancelled",
        retryable: true
      })
    }
  );

  if (compareVersions(version, options.minimumVersion) < 0) {
    throw new CodexClientError({
      code: "codex_unsupported_version",
      message: `Codex CLI ${version} is older than the supported minimum ${options.minimumVersion}`
    });
  }

  return version;
}

async function detectAndValidateExecVersion(
  options: ReturnType<typeof normalizedExecOptions>
): Promise<string> {
  try {
    return await detectAndValidateVersion(options);
  } catch (error) {
    throw toCodexExecError(error, []);
  }
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

export async function runCodexExec(options: CodexExecOptions): Promise<CodexExecResult> {
  const normalized = normalizedExecOptions(options);
  const codexCliVersion = await detectAndValidateExecVersion(normalized);
  const schema = await prepareOutputSchema(normalized.outputSchema);
  const structuredOutputPath =
    normalized.structuredOutputPath === undefined
      ? undefined
      : resolvePath(normalized.structuredOutputPath, normalized.cwd);
  const args = buildCodexExecArgs({
    ...normalized,
    outputSchemaPath: schema.path,
    structuredOutputPath
  });

  try {
    return await runCodexExecProcess({
      ...normalized,
      codexCliVersion,
      args,
      structuredOutputPath,
      expectsStructuredJson: normalized.outputSchema !== undefined
    });
  } finally {
    await schema.cleanup();
  }
}

export function parseCodexExecEvent(line: string): CodexExecEvent {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new CodexClientError({
      code: "codex_parse_error",
      message: "Codex exec emitted invalid JSONL",
      retryable: true,
      cause: error
    });
  }

  const event = asObject(parsed);

  if (event === undefined) {
    throw new CodexClientError({
      code: "codex_protocol_error",
      message: "Codex exec emitted a non-object JSONL event",
      retryable: true
    });
  }

  const type = asOptionalString(event.type) ?? "unknown";
  const item = asObject(event.item);
  const usage = sanitizeExecUsage(event.usage) ?? sanitizeExecUsage(asObject(event.turn)?.usage);
  const finalMessage = extractFinalMessage(event);

  return {
    type,
    threadId:
      asOptionalString(event.thread_id) ??
      asOptionalString(event.threadId) ??
      asOptionalString(asObject(event.thread)?.id),
    turnId:
      asOptionalString(event.turn_id) ??
      asOptionalString(event.turnId) ??
      asOptionalString(asObject(event.turn)?.id),
    itemType: asOptionalString(item?.type),
    usage,
    finalMessage,
    structuredOutputPath:
      sanitizeResultPath(event.output_path) ??
      sanitizeResultPath(event.outputPath) ??
      sanitizeResultPath(event.structured_output_path) ??
      sanitizeResultPath(event.structuredOutputPath)
  };
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

function normalizedExecOptions(options: CodexExecOptions): Required<
  Pick<CodexExecOptions, "codexBin" | "prompt" | "timeoutMs" | "minimumVersion" | "versionDetector" | "spawnProcess" | "logLimit">
> & {
  readonly cwd?: string;
  readonly outputSchema?: CodexExecOutputSchema;
  readonly structuredOutputPath?: string;
  readonly sandbox?: CodexExecSandboxMode;
  readonly model?: string;
  readonly profile?: string;
  readonly config?: Readonly<Record<string, string | number | boolean>>;
  readonly signal?: AbortSignal;
} {
  return {
    codexBin: options.codexBin ?? "codex",
    prompt: options.prompt,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? defaultCodexTimeoutMs,
    minimumVersion: options.minimumVersion ?? minimumSupportedCodexVersion,
    versionDetector: options.versionDetector ?? detectCodexCliVersion,
    spawnProcess: options.spawnProcess ?? defaultSpawner,
    outputSchema: options.outputSchema,
    structuredOutputPath: options.structuredOutputPath,
    sandbox: options.sandbox,
    model: options.model,
    profile: options.profile,
    config: options.config,
    signal: options.signal,
    logLimit: options.logLimit ?? 100
  };
}

async function prepareOutputSchema(
  schema: CodexExecOutputSchema | undefined
): Promise<{
  readonly path?: string;
  readonly cleanup: () => Promise<void>;
}> {
  if (schema === undefined) {
    return {
      cleanup: async () => {}
    };
  }

  if ("path" in schema) {
    return {
      path: schema.path,
      cleanup: async () => {}
    };
  }

  const schemaDir = await mkdtemp(join(tmpdir(), "oss-capacity-codex-schema-"));
  const schemaPath = join(schemaDir, "output-schema.json");
  await writeFile(schemaPath, `${JSON.stringify(schema.schema)}\n`, "utf8");

  return {
    path: schemaPath,
    cleanup: async () => {
      await rm(schemaDir, { force: true, recursive: true });
    }
  };
}

function resolvePath(path: string, cwd: string | undefined): string {
  return isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path);
}

function buildCodexExecArgs(options: ReturnType<typeof normalizedExecOptions> & {
  readonly outputSchemaPath?: string;
  readonly structuredOutputPath?: string;
}): readonly string[] {
  const args: string[] = ["exec", "--json", "--ephemeral"];

  if (options.cwd !== undefined) {
    args.push("--cd", options.cwd);
  }

  if (options.sandbox !== undefined) {
    args.push("--sandbox", options.sandbox);
  }

  if (options.model !== undefined) {
    args.push("--model", options.model);
  }

  if (options.profile !== undefined) {
    args.push("--profile", options.profile);
  }

  for (const [key, value] of Object.entries(options.config ?? {})) {
    args.push("--config", `${key}=${formatConfigValue(value)}`);
  }

  if (options.outputSchemaPath !== undefined) {
    args.push("--output-schema", resolvePath(options.outputSchemaPath, options.cwd));
  }

  if (options.structuredOutputPath !== undefined) {
    args.push("--output-last-message", options.structuredOutputPath);
  }

  args.push(options.prompt);
  return args;
}

function formatConfigValue(value: string | number | boolean): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  return String(value);
}

async function runCodexExecProcess(options: ReturnType<typeof normalizedExecOptions> & {
  readonly codexCliVersion: string;
  readonly args: readonly string[];
  readonly structuredOutputPath?: string;
  readonly expectsStructuredJson: boolean;
}): Promise<CodexExecResult> {
  if (options.signal?.aborted === true) {
    throw new CodexClientError({
      code: "codex_cancelled",
      message: "Codex exec was cancelled",
      retryable: true
    });
  }

  return await new Promise<CodexExecResult>((resolvePromise, rejectPromise) => {
    const child = options.spawnProcess(options.codexBin, options.args, {
      cwd: options.cwd,
      stdio: "pipe"
    });
    const logs: CodexExecLogEntry[] = [];
    const events: CodexExecEvent[] = [];
    let usage: CodexExecUsage | undefined;
    let finalMessage: string | undefined;
    let settled = false;

    const timeout = setTimeout(() => {
      settleReject(
        new CodexClientError({
          code: "codex_timeout",
          message: "Timed out running Codex exec",
          retryable: true
        })
      );
      child.kill();
    }, options.timeoutMs);

    const onAbort = (): void => {
      settleReject(
        new CodexClientError({
          code: "codex_cancelled",
          message: "Codex exec was cancelled",
          retryable: true
        })
      );
      child.kill();
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });

    stdout.on("line", (line) => {
      try {
        const event = parseCodexExecEvent(line);
        events.push(event);
        appendLog(logs, options.logLimit, {
          stream: "stdout",
          message: `event:${event.type}`
        });

        if (event.usage !== undefined) {
          usage = event.usage;
        }

        if (event.finalMessage !== undefined) {
          finalMessage = event.finalMessage;
        }
      } catch (error) {
        settleReject(error);
        child.kill();
      }
    });

    stderr.on("line", (line) => {
      appendLog(logs, options.logLimit, {
        stream: "stderr",
        message: sanitizeLogLine(line)
      });
    });

    child.on("error", (error) => {
      settleReject(
        new CodexClientError({
          code: "codex_unavailable",
          message: "Codex exec is unavailable",
          retryable: true,
          cause: error
        })
      );
    });

    child.on("close", (codeOrError, signal) => {
      const code = typeof codeOrError === "number" ? codeOrError : 0;

      if (settled) {
        return;
      }

      if (code !== 0 || signal !== null) {
        settleReject(
          new CodexClientError({
            code: "codex_exec_failed",
            message: `Codex exec failed${code !== 0 ? ` with exit code ${code}` : ""}`,
            retryable: true
          })
        );
        return;
      }

      void settleSuccess(code);
    });

    function settleReject(error: unknown): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      stdout.close();
      stderr.close();
      options.signal?.removeEventListener("abort", onAbort);
      rejectPromise(toCodexExecError(error, logs));
    }

    async function settleSuccess(exitCode: number): Promise<void> {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      stdout.close();
      stderr.close();
      options.signal?.removeEventListener("abort", onAbort);

      try {
        const structuredOutput =
          options.structuredOutputPath === undefined
            ? undefined
            : await readStructuredOutput(
                options.structuredOutputPath,
                options.expectsStructuredJson
              );

        resolvePromise({
          codexCliVersion: options.codexCliVersion,
          finalMessage: structuredOutput?.text ?? finalMessage,
          structuredOutput,
          events,
          usage,
          logs,
          exitCode
        });
      } catch (error) {
        rejectPromise(toCodexExecError(error, logs));
      }
    }
  });
}

function toCodexExecError(
  error: unknown,
  logs: readonly CodexExecLogEntry[]
): CodexExecError {
  if (error instanceof CodexExecError) {
    return error;
  }

  if (error instanceof CodexClientError) {
    return new CodexExecError({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      cause: error.cause,
      logs
    });
  }

  return new CodexExecError({
    code: "codex_exec_failed",
    message: "Codex exec failed",
    retryable: true,
    cause: error,
    logs
  });
}

function appendLog(
  logs: CodexExecLogEntry[],
  limit: number,
  entry: CodexExecLogEntry
): void {
  if (logs.length >= limit) {
    return;
  }

  logs.push(entry);
}

function sanitizeLogLine(line: string): string {
  return line
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:access|refresh|id|api)?_?token\s*=\s*[^\s]+/gi, "token=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/\/[^\s"]*\.codex\/[^\s"]*/g, "[codex-home]")
    .slice(0, 500);
}

async function readStructuredOutput(
  path: string,
  expectsJson: boolean
): Promise<CodexExecStructuredOutput> {
  const text = await readFile(path, "utf8");
  const trimmed = text.trim();
  const json = parseOptionalJson(trimmed);

  if (expectsJson && json === undefined) {
    throw new CodexClientError({
      code: "codex_protocol_error",
      message: "Codex structured output file was not valid JSON"
    });
  }

  return {
    path,
    text,
    json
  };
}

function parseOptionalJson(text: string): unknown | undefined {
  if (text.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sanitizeExecUsage(value: unknown): CodexExecUsage | undefined {
  const usage = asObject(value);

  if (usage === undefined) {
    return undefined;
  }

  const inputTokens =
    asOptionalNumber(usage.input_tokens) ??
    asOptionalNumber(usage.inputTokens) ??
    asOptionalNumber(usage.prompt_tokens) ??
    asOptionalNumber(usage.promptTokens);
  const outputTokens =
    asOptionalNumber(usage.output_tokens) ??
    asOptionalNumber(usage.outputTokens) ??
    asOptionalNumber(usage.completion_tokens) ??
    asOptionalNumber(usage.completionTokens);
  const totalTokens =
    asOptionalNumber(usage.total_tokens) ?? asOptionalNumber(usage.totalTokens);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

function extractFinalMessage(event: Record<string, unknown>): string | undefined {
  return (
    asOptionalString(event.final_message) ??
    asOptionalString(event.finalMessage) ??
    asOptionalString(event.final_response) ??
    asOptionalString(event.finalResponse) ??
    asOptionalString(event.last_message) ??
    asOptionalString(event.lastMessage) ??
    extractAssistantItemText(asObject(event.item))
  );
}

function extractAssistantItemText(item: Record<string, unknown> | undefined): string | undefined {
  if (item === undefined) {
    return undefined;
  }

  const role = asOptionalString(item.role);
  const isAssistantMessage =
    role === "assistant" ||
    asOptionalString(item.type) === "assistant_message" ||
    asOptionalBoolean(item.is_final_message) === true ||
    asOptionalBoolean(item.isFinalMessage) === true;

  if (!isAssistantMessage) {
    return undefined;
  }

  return asOptionalString(item.text) ?? asOptionalString(item.message) ?? extractContentText(item.content);
}

function extractContentText(content: unknown): string | undefined {
  if (typeof content === "string" && content.length > 0) {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts = content
    .map((part) => {
      const partObject = asObject(part);
      return asOptionalString(partObject?.text);
    })
    .filter((part): part is string => part !== undefined);

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function sanitizeResultPath(value: unknown): string | undefined {
  const path = asOptionalString(value);

  if (path === undefined || path.includes(".codex")) {
    return undefined;
  }

  return path;
}

export async function detectCodexCliVersion(input: {
  readonly codexBin?: string;
  readonly timeoutMs?: number;
  readonly spawnProcess?: CodexProcessSpawner;
  readonly signal?: AbortSignal;
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
    "Timed out detecting Codex CLI version",
    {
      signal: input.signal,
      abortError: new CodexClientError({
        code: "codex_cancelled",
        message: "Codex CLI version detection was cancelled",
        retryable: true
      })
    }
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
