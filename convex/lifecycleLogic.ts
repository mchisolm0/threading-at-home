import type {
  ResultPackage,
  RunnerCapability,
  TaskLease,
  TaskRequest
} from "@oss-capacity/core";

export type LeaseCandidateTask = Pick<
  TaskRequest,
  | "id"
  | "projectId"
  | "status"
  | "type"
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
};

const sandboxRank = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2
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

  return task.requiredCapabilities.every((capability) =>
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
    subscriptionAllowsTask(state.subscription, state.task)
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
