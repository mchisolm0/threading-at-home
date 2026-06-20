import type {
  RateLimitSnapshot,
  ResultPackage,
  RunnerCapability,
  RunnerCapabilityKey,
  TaskLease,
  TaskRequest,
  VolunteerPolicy
} from "@oss-capacity/core";
import { validatePrivateBetaRateLimits } from "@oss-capacity/core";

export type LeaseCandidateTask = Pick<
  TaskRequest,
  | "id"
  | "projectId"
  | "status"
  | "type"
  | "expectedSize"
  | "permissions"
  | "requiredCapabilities"
  | "maxRuns"
  | "expiresAt"
>;

export type LeaseCandidateState = {
  readonly task: LeaseCandidateTask;
  readonly activeLeaseCount: number;
  readonly runCount: number;
  readonly subscription?: {
    readonly enabled: boolean;
    readonly taskTypeAllowlist: readonly string[];
    readonly maxSandbox: string;
    readonly allowNetwork: boolean;
    readonly allowPatches: boolean;
  };
  readonly policy?: Pick<
    VolunteerPolicy,
    | "enabled"
    | "projectAllowlist"
    | "taskTypeAllowlist"
    | "capacity"
    | "permissions"
  >;
  readonly rateLimits?: RateLimitSnapshot;
};

export type StaleRunCleanupDecision =
  | {
      readonly shouldExpire: false;
    }
  | {
      readonly shouldExpire: true;
      readonly reason:
        | "missing_lease"
        | "expired_active_lease"
        | "expired_lease"
        | "released_lease"
        | "completed_lease"
        | "revoked_lease";
    };

const sandboxRank = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2
} as const;

const taskSizeRank = {
  small: 0,
  medium: 1,
  large: 2
} as const;

const terminalRunStatuses = new Set(["completed", "failed", "canceled", "expired"]);

function isExpired(expiresAt: string | undefined, now: string): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(now);
}

function supportsTask(
  runner: Pick<
    RunnerCapability,
    | "supportedCapabilities"
    | "supportedSandboxModes"
    | "supportedTaskTypes"
    | "supportsNetwork"
    | "supportsPatchCapture"
  >,
  task: LeaseCandidateTask
): boolean {
  if (!runner.supportedTaskTypes.includes(task.type)) {
    return false;
  }

  if (!runner.supportedSandboxModes.includes(task.permissions.sandbox)) {
    return false;
  }

  if (task.permissions.network && !runner.supportsNetwork) {
    return false;
  }

  if (task.permissions.allowPatches && !runner.supportsPatchCapture) {
    return false;
  }

  return task.requiredCapabilities.every((capability: RunnerCapabilityKey) =>
    runner.supportedCapabilities.includes(capability)
  );
}

function subscriptionAllowsTask(
  subscription: LeaseCandidateState["subscription"],
  task: LeaseCandidateTask
): boolean {
  if (!subscription?.enabled) {
    return false;
  }

  if (!subscription.taskTypeAllowlist.includes(task.type)) {
    return false;
  }

  const maxSandboxRank =
    sandboxRank[subscription.maxSandbox as keyof typeof sandboxRank];
  const taskSandboxRank =
    sandboxRank[task.permissions.sandbox as keyof typeof sandboxRank];

  if (maxSandboxRank === undefined || taskSandboxRank === undefined) {
    return false;
  }

  if (taskSandboxRank > maxSandboxRank) {
    return false;
  }

  if (task.permissions.network && !subscription.allowNetwork) {
    return false;
  }

  return !task.permissions.allowPatches || subscription.allowPatches;
}

function policyAllowsTask(
  policy: LeaseCandidateState["policy"],
  task: LeaseCandidateTask
): boolean {
  if (policy === undefined) {
    return false;
  }

  if (!policy.enabled) {
    return false;
  }

  if (!policy.projectAllowlist.includes(task.projectId)) {
    return false;
  }

  if (!policy.taskTypeAllowlist.includes(task.type)) {
    return false;
  }

  const maxTaskSizeRank =
    taskSizeRank[policy.capacity.maxEstimatedSize as keyof typeof taskSizeRank];
  const taskExpectedSizeRank =
    taskSizeRank[task.expectedSize as keyof typeof taskSizeRank];

  if (maxTaskSizeRank === undefined || taskExpectedSizeRank === undefined) {
    return false;
  }

  if (taskExpectedSizeRank > maxTaskSizeRank) {
    return false;
  }

  const maxSandboxRank =
    sandboxRank[policy.permissions.maxSandbox as keyof typeof sandboxRank];
  const taskSandboxRank =
    sandboxRank[task.permissions.sandbox as keyof typeof sandboxRank];

  if (maxSandboxRank === undefined || taskSandboxRank === undefined) {
    return false;
  }

  if (taskSandboxRank > maxSandboxRank) {
    return false;
  }

  if (task.permissions.network && !policy.permissions.allowNetwork) {
    return false;
  }

  return !task.permissions.allowPatches || policy.permissions.allowPatches;
}

export function canLeaseTask(
  state: LeaseCandidateState,
  runner: Pick<
    RunnerCapability,
    | "supportedCapabilities"
    | "supportedSandboxModes"
    | "supportedTaskTypes"
    | "supportsNetwork"
    | "supportsPatchCapture"
  >,
  now: string
): boolean {
  return (
    state.task.status === "active" &&
    !isExpired(state.task.expiresAt, now) &&
    state.activeLeaseCount === 0 &&
    state.runCount < state.task.maxRuns &&
    supportsTask(runner, state.task) &&
    subscriptionAllowsTask(state.subscription, state.task) &&
    policyAllowsTask(state.policy, state.task) &&
    validatePrivateBetaRateLimits({
      ...state.rateLimits,
      volunteerMaxRunsPerDay: state.policy?.capacity.maxRunsPerDay
    }).length === 0
  );
}

export function shouldExpireLease(
  lease: { readonly status: string; readonly expiresAt: string },
  now: string
): boolean {
  return lease.status === "active" && Date.parse(lease.expiresAt) <= Date.parse(now);
}

export function isTerminalRunStatus(status: string): boolean {
  return terminalRunStatuses.has(status);
}

export function shouldExpireStaleRun(
  run: { readonly status: string; readonly leaseId?: string },
  lease:
    | {
        readonly status: string;
        readonly expiresAt: string;
      }
    | null,
  now: string
): StaleRunCleanupDecision {
  if (isTerminalRunStatus(run.status)) {
    return { shouldExpire: false };
  }

  if (run.leaseId === undefined || lease === null) {
    return { shouldExpire: true, reason: "missing_lease" };
  }

  if (shouldExpireLease(lease, now)) {
    return { shouldExpire: true, reason: "expired_active_lease" };
  }

  switch (lease.status) {
    case "expired":
      return { shouldExpire: true, reason: "expired_lease" };
    case "released":
      return { shouldExpire: true, reason: "released_lease" };
    case "completed":
      return { shouldExpire: true, reason: "completed_lease" };
    case "revoked":
      return { shouldExpire: true, reason: "revoked_lease" };
    default:
      return { shouldExpire: false };
  }
}

export function assertTerminalResultPackage(
  resultPackage: ResultPackage,
  expectedStatus: "completed" | "failed"
): void {
  if (resultPackage.runStatus !== expectedStatus) {
    throw new Error(`Expected a ${expectedStatus} result package`);
  }
}

export function assertLeaseCanReceiveTerminalResult(
  lease: Pick<TaskLease, "status" | "expiresAt">,
  now: string,
  completedAt: string
): void {
  if (lease.status !== "active") {
    throw new Error(`Cannot write a result for ${lease.status} lease`);
  }

  if (Date.parse(lease.expiresAt) <= Date.parse(now)) {
    throw new Error("Cannot write a result for expired lease");
  }

  if (Date.parse(completedAt) >= Date.parse(lease.expiresAt)) {
    throw new Error("Result completed after lease expiration");
  }
}
