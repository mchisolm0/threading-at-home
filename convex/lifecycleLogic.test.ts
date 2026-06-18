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
  shouldExpireLease
} from "./lifecycleLogic.js";

const now = "2026-06-18T12:00:00Z";

const subscription = {
  enabled: true,
  taskTypeAllowlist: ["analysis", "triage", "docs_draft"],
  maxSandbox: "read-only",
  allowNetwork: false,
  allowPatches: false
};

describe("lifecycle planning helpers", () => {
  it("allows a subscribed runner to lease a compatible active task", () => {
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
    ).toBe(true);
  });

  it("rejects a task that already has an active unexpired lease", () => {
    expect(
      canLeaseTask(
        {
          task: exampleTaskRequest,
          activeLeaseCount: 1,
          runCount: 0,
          subscription
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
          subscription
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
        "2026-06-18T12:20:00Z",
        "2026-06-18T12:30:00Z"
      )
    ).toThrow("Result completed after lease expiration");
  });
});
