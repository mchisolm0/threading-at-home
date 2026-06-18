import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CodexClientError,
  type CodexAppServerTransport,
  type CodexProcess,
  compareVersions,
  createCodexAppServerTransport,
  parseCodexVersion,
  readCodexAccountState,
  readCodexRateLimits
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
    this.emit("exit", 0, null);
    return true;
  }

  override on(
    event: "error" | "exit",
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
