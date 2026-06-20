import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exampleTaskLease,
  exampleTaskRequest,
  exampleVolunteerPolicy,
  type ResultPackage
} from "@oss-capacity/core";
import { describe, expect, it } from "vitest";

import type { BrokerClient } from "../src/broker.js";
import type { RunnerConfig } from "../src/config.js";
import { checkCapacity, runOnce } from "../src/runLoop.js";

const authHash = `sha256:${"b".repeat(64)}`;
const taskSnapshotHash = `sha256:${"d".repeat(64)}`;
const now = new Date("2026-06-20T16:00:00.000Z");
const later = new Date("2026-06-20T16:02:00.000Z");
const autoUploadPolicy = {
  ...exampleVolunteerPolicy,
  review: {
    ...exampleVolunteerPolicy.review,
    requireBeforeUpload: false
  }
};

const config: RunnerConfig = {
  schemaVersion: 1,
  brokerUrl: "https://example.convex.cloud",
  runnerId: exampleTaskLease.runnerId,
  runnerAuthTokenHash: authHash,
  codexBin: "codex",
  maxOutputBytes: 1024 * 1024,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString()
};

function createBroker(calls: unknown[], overrides: Partial<BrokerClient> = {}): BrokerClient {
  return {
    exchangeRunnerSetupToken: async () => {
      throw new Error("not used");
    },
    heartbeatRunner: async () => {
      throw new Error("not used");
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

describe("runner run-once loop", () => {
  it("blocks capacity when Codex rate limits exceed policy", async () => {
    const capacity = await checkCapacity({
      config,
      policy: autoUploadPolicy,
      dependencies: {
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
          rateLimits: [
            {
              type: "primary",
              usedPercent: 99
            }
          ]
        })
      }
    });

    expect(capacity.ok).toBe(false);
    expect(capacity.reasons).toContain("codex_rate_limit_exceeded");
  });

  it("skips before leasing when volunteer policy requires review before upload", async () => {
    const calls: unknown[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "oss-capacity-workspaces-"));
    const logRoot = await mkdtemp(join(tmpdir(), "oss-capacity-logs-"));
    const result = await runOnce({
      config,
      broker: createBroker(calls, {
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
            policy: exampleVolunteerPolicy,
            subscriptions: []
          };
        }
      }),
      workspaceRoot,
      logRoot,
      dependencies: {
        now: () => now,
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
        })
      }
    });

    expect(result.status).toBe("skipped");
    expect(result.capacity.reasons).toContain("upload_review_required");
    expect(calls.some((call) => JSON.stringify(call).includes("leaseEligibleTask"))).toBe(
      false
    );
    expect(calls.some((call) => JSON.stringify(call).includes("completeRun"))).toBe(
      false
    );
    expect(calls.some((call) => JSON.stringify(call).includes("failRun"))).toBe(
      false
    );
  });

  it("leases, refreshes workspace, runs Codex read-only, and uploads structured output", async () => {
    const calls: unknown[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "oss-capacity-workspaces-"));
    const logRoot = await mkdtemp(join(tmpdir(), "oss-capacity-logs-"));
    let tick = 0;
    const result = await runOnce({
      config,
      broker: createBroker(calls),
      workspaceRoot,
      logRoot,
      dependencies: {
        now: () => (tick++ === 0 ? now : later),
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
          rateLimits: [
            {
              type: "primary",
              usedPercent: 10
            }
          ]
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
        runCodexExec: async (options) => {
          expect(options.sandbox).toBe("read-only");
          expect(options.config).toMatchObject({
            "shell_environment_policy.inherit": "none"
          });

          return {
            codexCliVersion: "0.140.0",
            finalMessage: "done",
            structuredOutput: {
              path: String(options.structuredOutputPath),
              text: "{}",
              json: {
                summary: "Three groups need maintainer review.",
                groups: [],
                risks: []
              }
            },
            events: [{ type: "turn.completed" }],
            usage: {
              inputTokens: 1,
              outputTokens: 2,
              totalTokens: 3
            },
            logs: [],
            exitCode: 0
          };
        }
      }
    });
    const completeCall = calls.find(
      (call): call is { method: "completeRun"; input: { resultPackage: ResultPackage } } =>
        typeof call === "object" &&
        call !== null &&
        "method" in call &&
        call.method === "completeRun"
    );

    expect(result.status).toBe("completed");
    expect(JSON.stringify(result)).not.toContain(authHash);
    expect(completeCall?.input.resultPackage.runStatus).toBe("completed");
    expect(completeCall?.input.resultPackage.structuredOutput).toMatchObject({
      summary: "Three groups need maintainer review."
    });
    expect(completeCall?.input.resultPackage.repositoryCommitSha).toBe(
      "0123456789abcdef0123456789abcdef01234567"
    );
  });

  it("runs eligible patch proposal tasks in workspace-write mode and uploads a patch artifact", async () => {
    const calls: unknown[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "oss-capacity-workspaces-"));
    const logRoot = await mkdtemp(join(tmpdir(), "oss-capacity-logs-"));
    const patchTask = {
      ...exampleTaskRequest,
      type: "patch_proposal" as const,
      permissions: {
        sandbox: "workspace-write" as const,
        network: false,
        allowPatches: true,
        publicPosting: "maintainer_only" as const
      },
      requiredCapabilities: [
        "codex.exec.json" as const,
        "codex.exec.output_schema" as const,
        "sandbox.workspace_write" as const,
        "network.disabled" as const,
        "patch.capture" as const
      ]
    };
    const result = await runOnce({
      config,
      broker: createBroker(calls, {
        eligibleTask: async (input) => {
          calls.push({ method: "eligibleTask", input });
          return patchTask;
        },
        leaseEligibleTask: async (input) => {
          calls.push({ method: "leaseEligibleTask", input });

          return {
            task: patchTask,
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
      workspaceRoot,
      logRoot,
      dependencies: {
        now: () => now,
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

          if (args.includes("--name-status")) {
            return { stdout: "M\tsrc/widget.ts\n", stderr: "" };
          }

          if (args.includes("--numstat")) {
            return { stdout: "1\t1\tsrc/widget.ts\n", stderr: "" };
          }

          if (args.includes("diff")) {
            return {
              stdout:
                "diff --git a/src/widget.ts b/src/widget.ts\n@@ -1 +1 @@\n-old\n+new\n",
              stderr: ""
            };
          }

          return { stdout: "", stderr: "" };
        },
        runCodexExec: async (options) => {
          expect(options.sandbox).toBe("workspace-write");
          expect(options.prompt).toContain("patch proposal task");
          expect(options.prompt).toContain("Do not create commits");

          return {
            codexCliVersion: "0.140.0",
            finalMessage: "patch ready",
            structuredOutput: {
              path: String(options.structuredOutputPath),
              text: "{}",
              json: {
                summary: "Prepared a minimal patch.",
                risks: []
              }
            },
            events: [{ type: "turn.completed" }],
            logs: [],
            exitCode: 0
          };
        }
      }
    });
    const completeCall = calls.find(
      (call): call is { method: "completeRun"; input: { resultPackage: ResultPackage } } =>
        typeof call === "object" &&
        call !== null &&
        "method" in call &&
        call.method === "completeRun"
    );

    expect(result.status).toBe("completed");
    expect(completeCall?.input.resultPackage.sandbox).toBe("workspace-write");
    expect(completeCall?.input.resultPackage.patchArtifact).toMatchObject({
      kind: "unified_diff",
      approvalStatus: "pending",
      fileCount: 1
    });
    expect(completeCall?.input.resultPackage.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "patch",
          mediaType: "text/x-diff"
        })
      ])
    );
  });

  it("omits Codex version from uploaded results when privacy policy disables sharing", async () => {
    const calls: unknown[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "oss-capacity-workspaces-"));
    const logRoot = await mkdtemp(join(tmpdir(), "oss-capacity-logs-"));
    const result = await runOnce({
      config,
      broker: createBroker(calls, {
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
            policy: {
              ...autoUploadPolicy,
              privacy: {
                ...autoUploadPolicy.privacy,
                shareCodexVersion: false
              }
            },
            subscriptions: []
          };
        }
      }),
      workspaceRoot,
      logRoot,
      dependencies: {
        now: () => now,
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
        runCodexExec: async () => ({
          codexCliVersion: "0.140.0",
          finalMessage: "done",
          structuredOutput: {
            path: "/tmp/output.json",
            text: "{}",
            json: {
              summary: "Done.",
              groups: [],
              risks: []
            }
          },
          events: [{ type: "turn.completed" }],
          logs: [],
          exitCode: 0
        })
      }
    });
    const completeCall = calls.find(
      (call): call is { method: "completeRun"; input: { resultPackage: ResultPackage } } =>
        typeof call === "object" &&
        call !== null &&
        "method" in call &&
        call.method === "completeRun"
    );

    expect(result.status).toBe("completed");
    expect(completeCall?.input.resultPackage.codexCliVersion).toBeUndefined();
  });

  it("uploads a failed result and writes sanitized local logs on execution failure", async () => {
    const calls: unknown[] = [];
    const workspaceRoot = await mkdtemp(join(tmpdir(), "oss-capacity-workspaces-"));
    const logRoot = await mkdtemp(join(tmpdir(), "oss-capacity-logs-"));
    const result = await runOnce({
      config,
      broker: createBroker(calls),
      workspaceRoot,
      logRoot,
      dependencies: {
        now: () => now,
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
    });
    const failCall = calls.find(
      (call): call is { method: "failRun"; input: { resultPackage: ResultPackage } } =>
        typeof call === "object" &&
        call !== null &&
        "method" in call &&
        call.method === "failRun"
    );
    const logFiles = await readFile(join(logRoot, `${result.log.id}.json`), "utf8");

    expect(result.status).toBe("failed");
    expect(failCall?.input.resultPackage.runStatus).toBe("failed");
    expect(failCall?.input.resultPackage.error?.message).not.toContain("user@example.com");
    expect(logFiles).not.toContain("user@example.com");
    expect(logFiles).not.toContain("/Users/me/.codex/auth.json");
  });
});
