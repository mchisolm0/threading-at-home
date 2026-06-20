import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exampleTaskLease,
  exampleTaskRequest,
  exampleVolunteerPolicy
} from "@oss-capacity/core";
import { describe, expect, it } from "vitest";

import { runCli, type CliDependencies, type CliIO } from "../src/cli.js";
import type { BrokerClient } from "../src/broker.js";
import type { RunnerConfig } from "../src/config.js";

const authHash = `sha256:${"b".repeat(64)}`;
const taskSnapshotHash = `sha256:${"d".repeat(64)}`;
const now = new Date("2026-06-20T15:30:00.000Z");
const autoUploadPolicy = {
  ...exampleVolunteerPolicy,
  review: {
    ...exampleVolunteerPolicy.review,
    requireBeforeUpload: false
  }
};

function createIo(env: NodeJS.ProcessEnv = {}): {
  readonly io: CliIO;
  readonly stdout: { value: string };
  readonly stderr: { value: string };
} {
  const stdout = { value: "" };
  const stderr = { value: "" };

  return {
    io: {
      env,
      stdout: {
        write: (chunk: string | Uint8Array) => {
          stdout.value += chunk.toString();
          return true;
        }
      },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          stderr.value += chunk.toString();
          return true;
        }
      }
    },
    stdout,
    stderr
  };
}

function createBroker(
  calls: unknown[],
  overrides: Partial<BrokerClient> = {}
): BrokerClient {
  return {
    exchangeRunnerSetupToken: async (input) => {
      calls.push({ method: "exchangeRunnerSetupToken", input });

      return {
        runnerId: input.runner.runnerId,
        displayName: input.runner.displayName,
        platform: input.runner.platform,
        architecture: input.runner.architecture,
        codexCliVersion: input.runner.codexCliVersion,
        codexAuthMode: input.runner.codexAuthMode,
        supportedSandboxModes: input.runner.supportedSandboxModes,
        supportsNetwork: input.runner.supportsNetwork,
        supportsPatchCapture: input.runner.supportsPatchCapture,
        supportedTaskTypes: input.runner.supportedTaskTypes,
        maxOutputBytes: input.runner.maxOutputBytes,
        registeredAt: input.runner.registeredAt,
        lastSeenAt: input.now
      };
    },
    heartbeatRunner: async (input) => {
      calls.push({ method: "heartbeatRunner", input });

      return {
        runnerId: input.runnerId,
        platform: input.runner.platform,
        architecture: input.runner.architecture,
        codexAuthMode: input.runner.codexAuthMode,
        supportedSandboxModes: input.runner.supportedSandboxModes,
        supportsNetwork: input.runner.supportsNetwork,
        supportsPatchCapture: input.runner.supportsPatchCapture,
        supportedTaskTypes: input.runner.supportedTaskTypes,
        maxOutputBytes: input.runner.maxOutputBytes,
        registeredAt: input.runner.registeredAt,
        lastSeenAt: input.now
      };
    },
    runnerConfiguration: async (input) => {
      calls.push({ method: "runnerConfiguration", input });

      return {
        runner: {
          runnerId: input.runnerId,
          platform: "darwin",
          architecture: "arm64",
          codexAuthMode: "chatgpt",
          supportedSandboxModes: ["read-only"],
          supportsNetwork: false,
          supportsPatchCapture: false,
          supportedTaskTypes: ["analysis"],
          maxOutputBytes: 1024,
          registeredAt: now.toISOString(),
          lastSeenAt: now.toISOString()
        },
        policy: null,
        subscriptions: []
      };
    },
    eligibleTask: async (input) => {
      calls.push({ method: "eligibleTask", input });
      return null;
    },
    leaseEligibleTask: async (input) => {
      calls.push({ method: "leaseEligibleTask", input });
      return null;
    },
    completeRun: async (input) => {
      calls.push({ method: "completeRun", input });
      return input.resultPackage;
    },
    failRun: async (input) => {
      calls.push({ method: "failRun", input });
      return input.resultPackage;
    },
    ...overrides
  };
}

describe("runner CLI", () => {
  it("logs in with a locally hashed setup token and writes redacted output", async () => {
    const { io, stdout, stderr } = createIo();
    const calls: unknown[] = [];
    const writes: { path: string; config: RunnerConfig }[] = [];
    const dependencies: CliDependencies = {
      now: () => now,
      createRunnerId: () => "runner-test",
      createLocalRunnerAuthHash: () => authHash,
      createBrokerClient: () => createBroker(calls),
      readCodexAccountState: async () => ({
        codexCliVersion: "0.140.0",
        authenticated: true,
        authMode: "chatgpt",
        requiresOpenaiAuth: false,
        account: {
          type: "chatgpt",
          planType: "pro"
        }
      }),
      writeConfig: async (path, config) => {
        writes.push({ path, config });
      }
    };
    const exitCode = await runCli(
      [
        "login",
        "--config",
        "/tmp/runner.json",
        "--broker-url",
        "https://example.convex.cloud",
        "--token",
        "ocr_local-token",
        "--name",
        "Local Runner"
      ],
      io,
      dependencies
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.config.runnerAuthTokenHash).toBe(authHash);
    expect(JSON.stringify(calls)).toContain("exchangeRunnerSetupToken");
    expect(JSON.stringify(calls)).toContain("sha256:");
    expect(JSON.stringify(calls)).toContain("codex.exec.json");
    expect(JSON.stringify(calls)).toContain("codex.exec.output_schema");
    expect(JSON.stringify(calls)).not.toContain("ocr_local-token");
    expect(stdout.value).not.toContain(authHash);
    expect(stdout.value).not.toContain("ocr_local-token");
  });

  it("diagnoses config, broker, and Codex without printing local auth material", async () => {
    const { io, stdout } = createIo();
    const calls: unknown[] = [];
    const config: RunnerConfig = {
      schemaVersion: 1,
      brokerUrl: "https://example.convex.cloud",
      runnerId: "runner-test",
      runnerAuthTokenHash: authHash,
      codexBin: "codex",
      maxOutputBytes: 1024,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    const exitCode = await runCli(["diagnose", "--config", "/tmp/runner.json"], io, {
      readConfig: async () => config,
      createBrokerClient: () => createBroker(calls),
      readCodexAccountState: async () => ({
        codexCliVersion: "0.140.0",
        authenticated: true,
        authMode: "chatgpt",
        account: {
          type: "chatgpt",
          planType: "user@example.com"
        } as { type: string; planType: string; email: string }
      }),
      readCodexRateLimits: async () => ({
        codexCliVersion: "0.140.0",
        account: {
          authenticated: true,
          authMode: "chatgpt"
        },
        rateLimits: [
          {
            type: "primary",
            usedPercent: 7
          }
        ]
      })
    });
    const output = JSON.parse(stdout.value) as { ok: boolean };

    expect(exitCode).toBe(0);
    expect(output.ok).toBe(true);
    expect(stdout.value).not.toContain(authHash);
    expect(stdout.value).not.toContain("/tmp/runner.json");
    expect(stdout.value).not.toContain("user@example.com");
    expect(stdout.value).toContain("[redacted]");
  });

  it("redacts local paths from diagnostic errors", async () => {
    const { io, stdout } = createIo();
    const exitCode = await runCli(["diagnose", "--config", "/tmp/runner.json"], io, {
      readConfig: async () => {
        throw new Error(
          "ENOENT: no such file or directory, open '/tmp/runner.json'"
        );
      }
    });
    const output = JSON.parse(stdout.value) as { ok: boolean };

    expect(exitCode).toBe(0);
    expect(output.ok).toBe(false);
    expect(stdout.value).not.toContain("/tmp/runner.json");
    expect(stdout.value).toContain("[redacted-path]");
  });

  it("returns a nonzero exit code when run-once cannot upload failure", async () => {
    const { io, stdout, stderr } = createIo();
    const calls: unknown[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "oss-capacity-cli-workspaces-"));
    const logRoot = await mkdtemp(join(tmpdir(), "oss-capacity-cli-logs-"));
    const config: RunnerConfig = {
      schemaVersion: 1,
      brokerUrl: "https://example.convex.cloud",
      runnerId: exampleTaskLease.runnerId,
      runnerAuthTokenHash: authHash,
      codexBin: "codex",
      maxOutputBytes: 1024,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    const exitCode = await runCli(
      [
        "run-once",
        "--config",
        "/tmp/runner.json",
        "--workspace-dir",
        workspaceRoot,
        "--log-dir",
        logRoot
      ],
      io,
      {
        readConfig: async () => config,
        createBrokerClient: () =>
          createBroker(calls, {
            runnerConfiguration: async (input) => {
              calls.push({ method: "runnerConfiguration", input });

              return {
                runner: {
                  runnerId: input.runnerId,
                  platform: "darwin",
                  architecture: "arm64",
                  codexAuthMode: "chatgpt",
                  supportedSandboxModes: ["read-only"],
                  supportsNetwork: false,
                  supportsPatchCapture: false,
                  supportedTaskTypes: ["triage"],
                  maxOutputBytes: config.maxOutputBytes,
                  registeredAt: now.toISOString(),
                  lastSeenAt: now.toISOString()
                },
                policy: autoUploadPolicy,
                subscriptions: []
              };
            },
            eligibleTask: async (input) => {
              calls.push({ method: "eligibleTask", input });
              return exampleTaskRequest;
            },
            leaseEligibleTask: async (input) => {
              calls.push({ method: "leaseEligibleTask", input });

              return {
                task: exampleTaskRequest,
                lease: {
                  ...exampleTaskLease,
                  leaseId: input.leaseId,
                  runId: input.runId,
                  runnerId: input.runnerId,
                  leasedAt: input.now,
                  expiresAt: input.expiresAt,
                  heartbeatAt: input.now,
                  taskSnapshotHash,
                  leaseTokenHash: input.leaseTokenHash
                }
              };
            },
            failRun: async (input) => {
              calls.push({ method: "failRun", input });
              throw new Error(`upload failed for ${authHash}`);
            }
          }),
        readCodexAccountState: async () => ({
          codexCliVersion: "0.140.0",
          authenticated: true,
          authMode: "chatgpt"
        }),
        readCodexRateLimits: async () => ({
          account: {
            authenticated: true,
            authMode: "chatgpt"
          },
          rateLimits: [{ usedPercent: 10 }]
        }),
        exec: async (_file, args) => {
          if (args.includes("rev-parse")) {
            return {
              stdout: "0123456789abcdef0123456789abcdef01234567\n",
              stderr: ""
            };
          }

          return { stdout: "", stderr: "" };
        },
        runCodexExec: async () => {
          throw new Error("Codex failed for user@example.com at /Users/me/.codex/auth.json");
        }
      }
    );
    const output = JSON.parse(stdout.value) as { ok: boolean; error?: string };

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    expect(output.ok).toBe(false);
    expect(stdout.value).not.toContain(authHash);
    expect(stdout.value).not.toContain("user@example.com");
    expect(stdout.value).not.toContain("/Users/me/.codex/auth.json");
  });

  it("leases an eligible task, runs Codex read-only, and uploads the result", async () => {
    const { io, stdout, stderr } = createIo();
    const calls: unknown[] = [];
    const codexCalls: unknown[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "oss-capacity-cli-workspaces-"));
    const logRoot = await mkdtemp(join(tmpdir(), "oss-capacity-cli-logs-"));
    const config: RunnerConfig = {
      schemaVersion: 1,
      brokerUrl: "https://example.convex.cloud",
      runnerId: exampleTaskLease.runnerId,
      runnerAuthTokenHash: authHash,
      codexBin: "codex",
      maxOutputBytes: 1024,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    const task = {
      ...exampleTaskRequest,
      requiredCapabilities: [
        "codex.exec.json",
        "codex.exec.output_schema",
        "sandbox.read_only",
        "network.disabled"
      ]
    };
    const exitCode = await runCli(
      [
        "run-once",
        "--config",
        "/tmp/runner.json",
        "--workspace-dir",
        workspaceRoot,
        "--log-dir",
        logRoot
      ],
      io,
      {
        readConfig: async () => config,
        createBrokerClient: () =>
          createBroker(calls, {
            runnerConfiguration: async (input) => {
              calls.push({ method: "runnerConfiguration", input });

              return {
                runner: {
                  runnerId: input.runnerId,
                  platform: "darwin",
                  architecture: "arm64",
                  codexAuthMode: "chatgpt",
                  supportedSandboxModes: ["read-only"],
                  supportsNetwork: false,
                  supportsPatchCapture: false,
                  supportedTaskTypes: ["triage"],
                  maxOutputBytes: config.maxOutputBytes,
                  registeredAt: now.toISOString(),
                  lastSeenAt: now.toISOString()
                },
                policy: autoUploadPolicy,
                subscriptions: [
                  {
                    projectId: task.projectId,
                    repository: task.repository,
                    enabled: true,
                    taskTypeAllowlist: ["triage"],
                    maxSandbox: "read-only",
                    allowNetwork: false,
                    allowPatches: false,
                    updatedAt: now.toISOString()
                  }
                ]
              };
            },
            eligibleTask: async (input) => {
              calls.push({ method: "eligibleTask", input });
              return task;
            },
            leaseEligibleTask: async (input) => {
              calls.push({ method: "leaseEligibleTask", input });

              return {
                task,
                lease: {
                  ...exampleTaskLease,
                  leaseId: input.leaseId,
                  runId: input.runId,
                  runnerId: input.runnerId,
                  leasedAt: input.now,
                  expiresAt: input.expiresAt,
                  heartbeatAt: input.now,
                  taskSnapshotHash,
                  leaseTokenHash: input.leaseTokenHash
                }
              };
            }
          }),
        readCodexAccountState: async () => ({
          codexCliVersion: "0.140.0",
          authenticated: true,
          authMode: "chatgpt"
        }),
        readCodexRateLimits: async () => ({
          account: {
            authenticated: true,
            authMode: "chatgpt"
          },
          rateLimits: [{ usedPercent: 10 }]
        }),
        exec: async (_file, args) => {
          if (args.includes("rev-parse")) {
            return {
              stdout: "0123456789abcdef0123456789abcdef01234567\n",
              stderr: ""
            };
          }

          return { stdout: "", stderr: "" };
        },
        runCodexExec: async (input) => {
          codexCalls.push(input);

          return {
            codexCliVersion: "0.140.0",
            finalMessage: "The read-only task completed.",
            structuredOutput: {
              path: input.structuredOutputPath ?? "/tmp/output.json",
              text: "{\"summary\":\"Mocked read-only result\",\"risks\":[]}",
              json: {
                summary: "Mocked read-only result",
                risks: []
              }
            },
            events: [
              {
                type: "message",
                finalMessage: "The read-only task completed."
              }
            ],
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              totalTokens: 120
            },
            logs: [],
            exitCode: 0
          };
        }
      }
    );
    const output = JSON.parse(stdout.value) as { status: string; ok: boolean };
    const completeRunCall = calls.find(
      (call): call is { method: "completeRun"; input: { resultPackage: unknown } } =>
        typeof call === "object" &&
        call !== null &&
        "method" in call &&
        call.method === "completeRun"
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(output.ok).toBe(true);
    expect(output.status).toBe("completed");
    expect(codexCalls).toHaveLength(1);
    expect(codexCalls[0]).toMatchObject({
      sandbox: "read-only",
      config: {
        "shell_environment_policy.inherit": "none"
      }
    });
    expect(JSON.stringify(codexCalls[0])).toContain("Do not edit files");
    expect(completeRunCall).toBeDefined();
    expect(completeRunCall?.input.resultPackage).toMatchObject({
      runStatus: "completed",
      sandbox: "read-only",
      resultVisibility: "maintainer_only",
      summary: "Mocked read-only result"
    });
    expect(calls.some((call) => JSON.stringify(call).includes("failRun"))).toBe(false);
  });
});
