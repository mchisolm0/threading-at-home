import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CodexClientError,
  CodexExecError,
  type CodexAppServerTransport,
  type CodexProcess,
  compareVersions,
  createCodexAppServerTransport,
  detectCodexCliVersion,
  parseCodexExecEvent,
  parseCodexVersion,
  readCodexAccountState,
  readCodexRateLimits,
  runCodexExec
} from "../src/index.js";

class FakeTransport implements CodexAppServerTransport {
  readonly requests: {
    readonly method: string;
    readonly params?: unknown;
  }[] = [];
  readonly notifications: {
    readonly method: string;
    readonly params?: unknown;
  }[] = [];

  constructor(private readonly responses: Record<string, unknown>) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    const response = this.responses[method];

    if (response instanceof Error) {
      throw response;
    }

    return response;
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  close(): void {}
}

class HangingTransport implements CodexAppServerTransport {
  async request(): Promise<unknown> {
    return await new Promise(() => {});
  }

  notify(): void {}

  close(): void {}
}

class MockCodexProcess extends EventEmitter implements CodexProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinLines: unknown[] = [];
  killed = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        if (line.length > 0) {
          this.stdinLines.push(JSON.parse(line));
        }
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }

  override on(
    event: "close" | "error" | "exit",
    listener: (errorOrCode: Error | number | null, signal?: NodeJS.Signals | null) => void
  ): this {
    return super.on(event, listener);
  }
}

const versionDetector = async (): Promise<string> => "0.140.0";

describe("Codex app-server client", () => {
  it("parses and compares Codex CLI versions", () => {
    expect(parseCodexVersion("codex-cli 0.140.0")).toBe("0.140.0");
    expect(parseCodexVersion("codex 1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(parseCodexVersion("not codex")).toBeUndefined();
    expect(compareVersions("0.140.1", "0.140.0")).toBe(1);
    expect(compareVersions("0.139.9", "0.140.0")).toBe(-1);
    expect(compareVersions("0.140.0", "0.140.0")).toBe(0);
    expect(compareVersions("0.140.0-beta.1", "0.140.0")).toBe(-1);
    expect(compareVersions("0.140.0", "0.140.0-beta.1")).toBe(1);
  });

  it("reads sanitized Codex account state without exposing raw account fields", async () => {
    const transport = new FakeTransport({
      initialize: {},
      "account/read": {
        requiresOpenaiAuth: false,
        account: {
          type: "chatgpt",
          planType: "pro",
          email: "volunteer@example.com",
          accessToken: "secret-token",
          id: "acct_local_123"
        }
      }
    });

    await expect(
      readCodexAccountState({ transport, versionDetector })
    ).resolves.toEqual({
      codexCliVersion: "0.140.0",
      authenticated: true,
      authMode: "chatgpt",
      requiresOpenaiAuth: false,
      account: {
        type: "chatgpt",
        planType: "pro"
      }
    });
    expect(JSON.stringify(await readCodexAccountState({ transport, versionDetector }))).not.toContain(
      "secret-token"
    );
    expect(transport.notifications).toContainEqual({
      method: "initialized",
      params: {}
    });
  });

  it("reads sanitized rate limits and omits unrelated local account details", async () => {
    const transport = new FakeTransport({
      initialize: {},
      "account/read": {
        requiresOpenaiAuth: false,
        account: {
          type: "chatgpt",
          planType: "team",
          login: "local-volunteer",
          refreshToken: "refresh-secret"
        }
      },
      "account/rateLimits/read": {
        rateLimits: [
          {
            type: "primary",
            usedPercent: 42,
            windowDurationMins: 300,
            resetsAt: "2026-06-18T20:00:00Z",
            rateLimitReachedType: null,
            internalBucketId: "bucket-secret"
          },
          {
            usedPercent: "not-a-number"
          }
        ],
        rateLimitResetCredits: 1,
        rawCredentialPath: "/Users/example/.codex/auth.json"
      }
    });

    const result = await readCodexRateLimits({ transport, versionDetector });

    expect(result).toEqual({
      codexCliVersion: "0.140.0",
      account: {
        codexCliVersion: "0.140.0",
        authenticated: true,
        authMode: "chatgpt",
        requiresOpenaiAuth: false,
        account: {
          type: "chatgpt",
          planType: "team"
        }
      },
      rateLimits: [
        {
          type: "primary",
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: "2026-06-18T20:00:00Z",
          rateLimitReachedType: undefined
        }
      ],
      rateLimitResetCredits: 1
    });
    expect(JSON.stringify(result)).not.toContain("refresh-secret");
    expect(JSON.stringify(result)).not.toContain("auth.json");
    expect(JSON.stringify(result)).not.toContain("bucket-secret");
  });

  it("models unauthenticated and unavailable rate-limit states explicitly", async () => {
    await expect(
      readCodexRateLimits({
        versionDetector,
        transport: new FakeTransport({
          initialize: {},
          "account/read": {
            requiresOpenaiAuth: true,
            account: null
          }
        })
      })
    ).rejects.toMatchObject({
      code: "codex_unauthenticated"
    });

    await expect(
      readCodexRateLimits({
        versionDetector,
        transport: new FakeTransport({
          initialize: {},
          "account/read": {
            requiresOpenaiAuth: false,
            account: {
              type: "chatgpt"
            }
          },
          "account/rateLimits/read": {
            rateLimits: []
          }
        })
      })
    ).rejects.toMatchObject({
      code: "codex_rate_limit_unavailable"
    });
  });

  it("rejects unsupported Codex versions before contacting app-server", async () => {
    const transport = new FakeTransport({});

    await expect(
      readCodexAccountState({
        transport,
        versionDetector: async () => "0.139.9"
      })
    ).rejects.toMatchObject({
      code: "codex_unsupported_version"
    });
    expect(transport.requests).toEqual([]);
  });

  it("times out hung app-server requests", async () => {
    await expect(
      readCodexAccountState({
        transport: new HangingTransport(),
        versionDetector,
        timeoutMs: 1
      })
    ).rejects.toMatchObject({
      code: "codex_timeout",
      retryable: true
    });
  });

  it("times out injected version detectors and account probes", async () => {
    await expect(
      readCodexAccountState({
        transport: new FakeTransport({}),
        versionDetector: async () => await new Promise(() => {}),
        timeoutMs: 1
      })
    ).rejects.toMatchObject({
      code: "codex_timeout"
    });

    await expect(
      readCodexRateLimits({
        transport: new FakeTransport({
          initialize: {},
          "account/read": new Promise(() => {})
        }),
        versionDetector,
        timeoutMs: 1
      })
    ).rejects.toMatchObject({
      code: "codex_timeout"
    });
  });

  it("kills the version subprocess when version detection times out", async () => {
    const mockProcess = new MockCodexProcess();

    await expect(
      detectCodexCliVersion({
        timeoutMs: 1,
        spawnProcess(command, args) {
          expect(command).toBe("codex");
          expect(args).toEqual(["--version"]);
          return mockProcess;
        }
      })
    ).rejects.toMatchObject({
      code: "codex_timeout"
    });
    expect(mockProcess.killed).toBe(true);
  });

  it("sends and receives app-server JSONL without requiring a live Codex process", async () => {
    const mockProcess = new MockCodexProcess();
    const transport = createCodexAppServerTransport({
      spawnProcess(command, args) {
        expect(command).toBe("codex");
        expect(args).toEqual(["app-server"]);
        return mockProcess;
      }
    });

    const response = transport.request("account/read", { refreshToken: false });
    mockProcess.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          requiresOpenaiAuth: false
        }
      })}\n`
    );

    await expect(response).resolves.toEqual({
      requiresOpenaiAuth: false
    });
    transport.notify("initialized", {});

    expect(mockProcess.stdinLines).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "account/read",
        params: {
          refreshToken: false
        }
      },
      {
        jsonrpc: "2.0",
        method: "initialized",
        params: {}
      }
    ]);
    await transport.close();
  });

  it("wraps invalid app-server JSONL in a sanitized parse error", async () => {
    const mockProcess = new MockCodexProcess();
    const transport = createCodexAppServerTransport({
      spawnProcess() {
        return mockProcess;
      }
    });

    const response = transport.request("account/read");
    mockProcess.stderr.write("token=super-secret /Users/example/.codex/auth.json\n");
    mockProcess.stdout.write("this is not json\n");

    await expect(response).rejects.toBeInstanceOf(CodexClientError);
    await expect(response).rejects.toMatchObject({
      code: "codex_parse_error"
    });
    await expect(response).rejects.not.toThrow("super-secret");
    await transport.close();
  });

  it("does not echo raw JSON-RPC error messages", async () => {
    const mockProcess = new MockCodexProcess();
    const transport = createCodexAppServerTransport({
      spawnProcess() {
        return mockProcess;
      }
    });

    const response = transport.request("account/read");
    mockProcess.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32_000,
          message: "token=secret-from-codex"
        }
      })}\n`
    );

    await expect(response).rejects.toMatchObject({
      code: "codex_protocol_error",
      message: "Codex app-server returned a JSON-RPC error"
    });
    await expect(response).rejects.not.toThrow("secret-from-codex");
    await transport.close();
  });
});

describe("Codex exec runner", () => {
  it("spawns codex exec with JSONL, ephemeral, schema, and structured output flags", async () => {
    const mockProcess = new MockCodexProcess();
    const tempDir = await mkdtemp(join(tmpdir(), "oss-capacity-codex-test-"));
    const schemaPath = join(tempDir, "schema.json");
    const outputPath = join(tempDir, "result.json");
    const cwd = tempDir;
    let markSpawned: () => void = () => {};
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    await writeFile(schemaPath, "{}\n", "utf8");
    await writeFile(
      outputPath,
      `${JSON.stringify({ status: "ok", summary: "ready" })}\n`,
      "utf8"
    );

    const resultPromise = runCodexExec({
      prompt: "Summarize the task",
      cwd,
      outputSchema: { path: schemaPath },
      structuredOutputPath: outputPath,
      sandbox: "read-only",
      model: "gpt-5",
      config: {
        "shell_environment_policy.inherit": "none"
      },
      versionDetector,
      spawnProcess(command, args, spawnOptions) {
        markSpawned();
        expect(command).toBe("codex");
        expect(args).toEqual([
          "exec",
          "--json",
          "--ephemeral",
          "--cd",
          cwd,
          "--sandbox",
          "read-only",
          "--model",
          "gpt-5",
          "--config",
          'shell_environment_policy.inherit="none"',
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "Summarize the task"
        ]);
        expect(spawnOptions).toMatchObject({
          cwd,
          stdio: "pipe"
        });
        return mockProcess;
      }
    });
    await spawned;

    mockProcess.stdout.write(
      `${JSON.stringify({
        type: "thread.started",
        thread_id: "thread-local"
      })}\n`
    );
    mockProcess.stdout.write(
      `${JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20
        },
        final_response: "raw event final"
      })}\n`
    );
    mockProcess.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({
      codexCliVersion: "0.140.0",
      finalMessage: `${JSON.stringify({ status: "ok", summary: "ready" })}\n`,
      structuredOutput: {
        path: outputPath,
        json: {
          status: "ok",
          summary: "ready"
        }
      },
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20
      },
      exitCode: 0
    });
  });

  it("waits for close before resolving final exec output", async () => {
    const mockProcess = new MockCodexProcess();
    let markSpawned: () => void = () => {};
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const resultPromise = runCodexExec({
      prompt: "Capture late output",
      versionDetector,
      spawnProcess() {
        markSpawned();
        return mockProcess;
      }
    });

    await spawned;
    mockProcess.emit("exit", 0, null);
    mockProcess.stdout.write(
      `${JSON.stringify({
        type: "turn.completed",
        final_response: "late final response"
      })}\n`
    );
    mockProcess.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({
      finalMessage: "late final response"
    });
  });

  it("parses JSONL events into narrow sanitized event records", () => {
    expect(
      parseCodexExecEvent(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "message",
            role: "assistant",
            content: [{ text: "done" }],
            apiToken: "secret"
          },
          rawLocalPath: "/Users/example/.codex/auth.json"
        })
      )
    ).toEqual({
      type: "item.completed",
      threadId: undefined,
      turnId: undefined,
      itemType: "message",
      usage: undefined,
      finalMessage: "done",
      structuredOutputPath: undefined
    });
  });

  it("wraps invalid exec JSONL without echoing raw output", () => {
    expect(() => parseCodexExecEvent("token=super-secret")).toThrow(CodexClientError);
    expect(() => parseCodexExecEvent("token=super-secret")).not.toThrow("super-secret");
  });

  it("kills codex exec on timeout", async () => {
    const mockProcess = new MockCodexProcess();

    await expect(
      runCodexExec({
        prompt: "Hang",
        timeoutMs: 1,
        versionDetector,
        spawnProcess() {
          return mockProcess;
        }
      })
    ).rejects.toMatchObject({
      code: "codex_timeout",
      retryable: true
    });
    expect(mockProcess.killed).toBe(true);
  });

  it("kills codex exec on cancellation", async () => {
    const mockProcess = new MockCodexProcess();
    const controller = new AbortController();
    let markSpawned: () => void = () => {};
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const resultPromise = runCodexExec({
      prompt: "Cancel",
      versionDetector,
      signal: controller.signal,
      spawnProcess() {
        markSpawned();
        return mockProcess;
      }
    });

    await spawned;
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({
      code: "codex_cancelled",
      retryable: true
    });
    expect(mockProcess.killed).toBe(true);
  });

  it("cancels and kills version detection before spawning exec", async () => {
    const versionProcess = new MockCodexProcess();
    const controller = new AbortController();
    let execSpawned = false;
    let markVersionSpawned: () => void = () => {};
    const versionSpawned = new Promise<void>((resolve) => {
      markVersionSpawned = resolve;
    });
    const resultPromise = runCodexExec({
      prompt: "Cancel during version detection",
      signal: controller.signal,
      versionDetector: async (input) =>
        await detectCodexCliVersion({
          codexBin: input.codexBin,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          spawnProcess() {
            markVersionSpawned();
            return versionProcess;
          }
        }),
      spawnProcess() {
        execSpawned = true;
        return new MockCodexProcess();
      }
    });

    await versionSpawned;
    controller.abort();

    await expect(resultPromise).rejects.toBeInstanceOf(CodexExecError);
    await expect(resultPromise).rejects.toMatchObject({
      code: "codex_cancelled",
      retryable: true
    });
    expect(versionProcess.killed).toBe(true);
    expect(execSpawned).toBe(false);
  });

  it("reports cancellation when version detection rejects with AbortError", async () => {
    const controller = new AbortController();
    let execSpawned = false;
    let markVersionStarted: () => void = () => {};
    const versionStarted = new Promise<void>((resolve) => {
      markVersionStarted = resolve;
    });
    const resultPromise = runCodexExec({
      prompt: "Cancel cooperative detector",
      signal: controller.signal,
      versionDetector: async (input) =>
        await new Promise<string>((_resolve, reject) => {
          markVersionStarted();
          input.signal?.addEventListener("abort", () => {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        }),
      spawnProcess() {
        execSpawned = true;
        return new MockCodexProcess();
      }
    });

    await versionStarted;
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({
      code: "codex_cancelled",
      retryable: true
    });
    expect(execSpawned).toBe(false);
  });

  it("captures sanitized stderr logs on failed exec", async () => {
    const mockProcess = new MockCodexProcess();
    let markSpawned: () => void = () => {};
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const resultPromise = runCodexExec({
      prompt: "Fail",
      versionDetector,
      spawnProcess() {
        markSpawned();
        return mockProcess;
      }
    });

    await spawned;
    mockProcess.stderr.write(
      "Bearer secret-token token=another-secret /Users/example/.codex/auth.json\n"
    );
    mockProcess.emit("close", 1, null);

    await expect(resultPromise).rejects.toBeInstanceOf(CodexExecError);
    await expect(resultPromise).rejects.toMatchObject({
      code: "codex_exec_failed",
      message: "Codex exec failed with exit code 1",
      logs: [
        {
          stream: "stderr",
          message: "Bearer [redacted] token=[redacted] [codex-home]"
        }
      ]
    });
    await expect(resultPromise).rejects.not.toThrow("secret-token");
    await expect(resultPromise).rejects.not.toThrow("auth.json");
  });
});
