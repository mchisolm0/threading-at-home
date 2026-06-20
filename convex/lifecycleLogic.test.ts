import { describe, expect, it } from "vitest";

import {
  exampleResultPackage,
  exampleRunnerCapability,
  exampleTaskLease,
  exampleTaskRequest
} from "@oss-capacity/core";

import {
  assertLeaseCanReceiveTerminalResult,
  assertTerminalResultPackage,
  canLeaseTask,
  type LeaseCandidateState,
  shouldExpireLease,
  shouldExpireStaleRun
} from "./lifecycleLogic.js";

const now = "2026-06-18T12:00:00Z";

const subscription = {
  enabled: true,
  taskTypeAllowlist: ["analysis", "triage", "docs_draft"],
  maxSandbox: "read-only",
  allowNetwork: false,
  allowPatches: false
};

const enabledPolicy = {
  enabled: true,
  projectAllowlist: [exampleTaskRequest.projectId],
  taskTypeAllowlist: ["analysis", "triage", "docs_draft"],
  capacity: {
    maxUsedPercent: 80,
    onlyIfResetsWithinMinutes: 180,
    maxRunsPerDay: 3,
    maxEstimatedSize: "small"
  },
  permissions: {
    maxSandbox: "read-only",
    allowNetwork: false,
    allowPatches: false
  }
} satisfies LeaseCandidateState["policy"];

const patchTask = {
  ...exampleTaskRequest,
  type: "patch_proposal",
  permissions: {
    sandbox: "workspace-write",
    network: false,
    allowPatches: true,
    publicPosting: "maintainer_only"
  },
  requiredCapabilities: [
    "codex.exec.json",
    "sandbox.workspace_write",
    "network.disabled",
    "patch.capture"
  ]
} satisfies LeaseCandidateState["task"];

describe("lifecycle planning helpers", () => {
  it("allows a subscribed runner to lease a compatible active task", () => {
    expect(
      canLeaseTask(
        {
          task: exampleTaskRequest,
          activeLeaseCount: 0,
          runCount: 0,
          subscription,
          policy: enabledPolicy
        },
        exampleRunnerCapability,
        now
      )
    ).toBe(true);
  });

  it("allows UI-created schema tasks that require read-only runner capabilities", () => {
    expect(
      canLeaseTask(
        {
          task: {
            ...exampleTaskRequest,
            requiredCapabilities: [
              "codex.exec.json",
              "codex.exec.output_schema",
              "sandbox.read_only",
              "network.disabled"
            ]
          },
          activeLeaseCount: 0,
          runCount: 0,
          subscription,
          policy: enabledPolicy
        },
        exampleRunnerCapability,
        now
      )
    ).toBe(true);
  });

  it("allows patch proposal leases only when runner, policy, and subscription opt in", () => {
    expect(
      canLeaseTask(
        {
          task: patchTask,
          activeLeaseCount: 0,
          runCount: 0,
          subscription: {
            ...subscription,
            taskTypeAllowlist: ["patch_proposal"],
            maxSandbox: "workspace-write",
            allowPatches: true
          },
          policy: {
            ...enabledPolicy,
            taskTypeAllowlist: ["patch_proposal"],
            permissions: {
              ...enabledPolicy.permissions,
              maxSandbox: "workspace-write",
              allowPatches: true
            }
          }
        },
        exampleRunnerCapability,
        now
      )
    ).toBe(true);

    expect(
      canLeaseTask(
        {
          task: patchTask,
          activeLeaseCount: 0,
          runCount: 0,
          subscription: {
            ...subscription,
            taskTypeAllowlist: ["patch_proposal"],
            maxSandbox: "workspace-write",
            allowPatches: false
          },
          policy: {
            ...enabledPolicy,
            taskTypeAllowlist: ["patch_proposal"],
            permissions: {
              ...enabledPolicy.permissions,
              maxSandbox: "workspace-write",
              allowPatches: true
            }
          }
        },
        exampleRunnerCapability,
        now
      )
    ).toBe(false);
  });

  it("rejects a task that already has an active unexpired lease", () => {
    expect(
      canLeaseTask(
        {
          task: exampleTaskRequest,
          activeLeaseCount: 1,
          runCount: 0,
          subscription,
          policy: enabledPolicy
        },
        exampleRunnerCapability,
        now
      )
    ).toBe(false);
  });

  it("rejects a task after maxRuns is reached", () => {
    expect(
      canLeaseTask(
        {
          task: exampleTaskRequest,
          activeLeaseCount: 0,
          runCount: exampleTaskRequest.maxRuns,
          subscription,
          policy: enabledPolicy
        },
        exampleRunnerCapability,
        now
      )
    ).toBe(false);
  });

  it("rejects tasks outside the volunteer subscription policy", () => {
    expect(
      canLeaseTask(
        {
          task: {
            ...exampleTaskRequest,
            permissions: {
              ...exampleTaskRequest.permissions,
              network: true
            }
          },
          activeLeaseCount: 0,
          runCount: 0,
          subscription
        },
        {
          ...exampleRunnerCapability,
          supportsNetwork: true
        },
        now
      )
    ).toBe(false);
  });

  it("rejects leases when the volunteer policy is paused", () => {
    expect(
      canLeaseTask(
        {
          task: exampleTaskRequest,
          activeLeaseCount: 0,
          runCount: 0,
          subscription,
          policy: {
            enabled: false,
            projectAllowlist: [exampleTaskRequest.projectId],
            taskTypeAllowlist: ["analysis", "triage", "docs_draft"],
            capacity: {
              maxUsedPercent: 80,
              onlyIfResetsWithinMinutes: 180,
              maxRunsPerDay: 3,
              maxEstimatedSize: "small"
            },
            permissions: {
              maxSandbox: "read-only",
              allowNetwork: false,
              allowPatches: false
            }
          }
        },
        exampleRunnerCapability,
        now
      )
    ).toBe(false);
  });

  it("rejects leases when the volunteer has no saved policy", () => {
    expect(
      canLeaseTask(
        {
          task: exampleTaskRequest,
          activeLeaseCount: 0,
          runCount: 0,
          subscription
        },
        exampleRunnerCapability,
        now
      )
    ).toBe(false);
  });

  it("rejects leases once private beta volunteer and project caps are reached", () => {
    expect(
      canLeaseTask(
        {
          task: exampleTaskRequest,
          activeLeaseCount: 0,
          runCount: 0,
          subscription,
          policy: enabledPolicy,
          rateLimits: {
            projectRunsLeasedToday: 50,
            volunteerRunsLeasedToday: enabledPolicy.capacity.maxRunsPerDay
          }
        },
        exampleRunnerCapability,
        now
      )
    ).toBe(false);
  });

  it("rejects leases outside the volunteer policy project allowlist", () => {
    expect(
      canLeaseTask(
        {
          task: exampleTaskRequest,
          activeLeaseCount: 0,
          runCount: 0,
          subscription,
          policy: {
            enabled: true,
            projectAllowlist: ["other/project"],
            taskTypeAllowlist: ["analysis", "triage", "docs_draft"],
            capacity: {
              maxUsedPercent: 80,
              onlyIfResetsWithinMinutes: 180,
              maxRunsPerDay: 3,
              maxEstimatedSize: "small"
            },
            permissions: {
              maxSandbox: "read-only",
              allowNetwork: false,
              allowPatches: false
            }
          }
        },
        exampleRunnerCapability,
        now
      )
    ).toBe(false);
  });

  it("rejects leases outside tightened volunteer policy permissions", () => {
    expect(
      canLeaseTask(
        {
          task: {
            ...exampleTaskRequest,
            permissions: {
              ...exampleTaskRequest.permissions,
              network: true
            }
          },
          activeLeaseCount: 0,
          runCount: 0,
          subscription: {
            ...subscription,
            allowNetwork: true
          },
          policy: {
            enabled: true,
            projectAllowlist: [exampleTaskRequest.projectId],
            taskTypeAllowlist: ["analysis", "triage", "docs_draft"],
            capacity: {
              maxUsedPercent: 80,
              onlyIfResetsWithinMinutes: 180,
              maxRunsPerDay: 3,
              maxEstimatedSize: "small"
            },
            permissions: {
              maxSandbox: "read-only",
              allowNetwork: false,
              allowPatches: false
            }
          }
        },
        {
          ...exampleRunnerCapability,
          supportsNetwork: true
        },
        now
      )
    ).toBe(false);
  });

  it("expires only active leases whose deadline has passed", () => {
    expect(
      shouldExpireLease(
        { status: "active", expiresAt: "2026-06-18T11:59:00Z" },
        now
      )
    ).toBe(true);
    expect(
      shouldExpireLease(
        { status: "completed", expiresAt: "2026-06-18T11:59:00Z" },
        now
      )
    ).toBe(false);
  });

  it("marks stale nonterminal runs with expired active leases for cleanup", () => {
    expect(
      shouldExpireStaleRun(
        { status: "leased", leaseId: exampleTaskLease.leaseId },
        {
          status: "active",
          expiresAt: "2026-06-18T11:59:00Z"
        },
        now
      )
    ).toEqual({ shouldExpire: true, reason: "expired_active_lease" });
  });

  it("leaves nonterminal runs with fresh active leases alone", () => {
    expect(
      shouldExpireStaleRun(
        { status: "running", leaseId: exampleTaskLease.leaseId },
        {
          status: "active",
          expiresAt: "2026-06-18T12:01:00Z"
        },
        now
      )
    ).toEqual({ shouldExpire: false });
  });

  it("cleans up nonterminal runs whose lease was already finalized", () => {
    expect(
      shouldExpireStaleRun(
        { status: "leased", leaseId: exampleTaskLease.leaseId },
        {
          status: "expired",
          expiresAt: "2026-06-18T11:59:00Z"
        },
        now
      )
    ).toEqual({ shouldExpire: true, reason: "expired_lease" });
  });

  it("does not re-expire already-terminal runs during stale cleanup", () => {
    expect(
      shouldExpireStaleRun(
        { status: "completed", leaseId: exampleTaskLease.leaseId },
        {
          status: "active",
          expiresAt: "2026-06-18T11:59:00Z"
        },
        now
      )
    ).toEqual({ shouldExpire: false });
  });

  it("expires stale nonterminal runs without a lease record", () => {
    expect(
      shouldExpireStaleRun({ status: "queued" }, null, now)
    ).toEqual({ shouldExpire: true, reason: "missing_lease" });
  });

  it("requires complete and fail mutations to receive matching terminal packages", () => {
    expect(() =>
      assertTerminalResultPackage(exampleResultPackage, "completed")
    ).not.toThrow();
    expect(() =>
      assertTerminalResultPackage(exampleResultPackage, "failed")
    ).toThrow("Expected a failed result package");
  });

  it("accepts terminal results only inside an active lease window", () => {
    expect(() =>
      assertLeaseCanReceiveTerminalResult(
        exampleTaskLease,
        "2026-06-18T12:10:00Z",
        "2026-06-18T12:20:00Z"
      )
    ).not.toThrow();

    expect(() =>
      assertLeaseCanReceiveTerminalResult(
        exampleTaskLease,
        "2026-06-18T12:31:00Z",
        "2026-06-18T12:20:00Z"
      )
    ).toThrow("Cannot write a result for expired lease");

    expect(() =>
      assertLeaseCanReceiveTerminalResult(
        exampleTaskLease,
        "2026-06-18T12:45:00Z",
        "2026-06-18T12:10:00Z"
      )
    ).toThrow("Cannot write a result for expired lease");

    expect(() =>
      assertLeaseCanReceiveTerminalResult(
        exampleTaskLease,
        "2026-06-18T12:20:00Z",
        "2026-06-18T12:30:00Z"
      )
    ).toThrow("Result completed after lease expiration");
  });
});
