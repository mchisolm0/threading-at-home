import {
  parseResultPackage,
  parseRunnerCapability,
  parseTaskLease,
  parseTaskRequest,
  type ResultPackage,
  type RunnerCapability,
  type TaskLease,
  type TaskRequest
} from "@oss-capacity/core";
import {
  mutationGeneric,
  type GenericDataModel,
  type GenericMutationCtx
} from "convex/server";
import { v, type GenericId, type Value } from "convex/values";

import {
  assertLeaseCanReceiveTerminalResult,
  assertTerminalResultPackage,
  canLeaseTask,
  isTerminalRunStatus,
  shouldExpireLease
} from "./lifecycleLogic.js";

type MutationCtx = GenericMutationCtx<GenericDataModel>;
type StoredDoc = {
  readonly _id: GenericId<string>;
  readonly [key: string]: Value;
};

const mutation = mutationGeneric;

async function uniqueByIndex<T extends StoredDoc>(
  ctx: MutationCtx,
  table: string,
  indexName: string,
  field: string,
  value: string
): Promise<T | null> {
  return (await ctx.db
    .query(table)
    .withIndex(indexName, (q) => q.eq(field, value))
    .unique()) as T | null;
}

async function collectByIndex<T extends StoredDoc>(
  ctx: MutationCtx,
  table: string,
  indexName: string,
  field: string,
  value: string
): Promise<T[]> {
  return (await ctx.db
    .query(table)
    .withIndex(indexName, (q) => q.eq(field, value))
    .collect()) as T[];
}

async function insertAuditEvent(
  ctx: MutationCtx,
  event: {
    readonly eventType: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly occurredAt: string;
    readonly projectId?: string;
    readonly taskRequestId?: string;
    readonly runId?: string;
    readonly leaseId?: string;
    readonly actorUserId?: string;
    readonly runnerId?: string;
    readonly metadata?: unknown;
  }
): Promise<void> {
  await ctx.db.insert("auditEvents", toConvexDocument(event));
}

function requireIsoNow(now: string): string {
  const parsed = Date.parse(now);

  if (Number.isNaN(parsed)) {
    throw new Error("Expected now to be an ISO date-time string");
  }

  return now;
}

function toConvexValue(value: unknown): Value {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    value instanceof ArrayBuffer
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toConvexValue(item));
  }

  if (typeof value === "object" && value !== null) {
    const objectValue: Record<string, Value> = {};

    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        objectValue[key] = toConvexValue(item);
      }
    }

    return objectValue;
  }

  throw new Error("Expected a Convex-compatible value");
}

function toConvexDocument(value: object): Record<string, Value> {
  return toConvexValue(value) as Record<string, Value>;
}

function withoutSystemFields(doc: StoredDoc): Record<string, Value> {
  const result: Record<string, Value> = {};

  for (const [key, value] of Object.entries(doc)) {
    if (key !== "_id" && key !== "_creationTime") {
      result[key] = value;
    }
  }

  return result;
}

async function activeLeaseCountForTask(
  ctx: MutationCtx,
  taskRequestId: string,
  now: string
): Promise<number> {
  const leases = await collectByIndex<StoredDoc>(
    ctx,
    "taskLeases",
    "by_task_status",
    "taskRequestId",
    taskRequestId
  );

  return leases.filter(
    (lease) =>
      lease.status === "active" &&
      typeof lease.expiresAt === "string" &&
      Date.parse(lease.expiresAt) > Date.parse(now)
  ).length;
}

async function runCountForTask(
  ctx: MutationCtx,
  taskRequestId: string
): Promise<number> {
  const runs = await collectByIndex<StoredDoc>(
    ctx,
    "runs",
    "by_task",
    "taskRequestId",
    taskRequestId
  );

  return runs.length;
}

async function subscriptionForTask(
  ctx: MutationCtx,
  volunteerUserId: string,
  projectId: string
): Promise<StoredDoc | null> {
  const subscriptions = await collectByIndex<StoredDoc>(
    ctx,
    "volunteerProjectSubscriptions",
    "by_volunteer_project",
    "volunteerUserId",
    volunteerUserId
  );

  return (
    subscriptions.find((subscription) => subscription.projectId === projectId) ?? null
  );
}

async function findLeaseableTask(
  ctx: MutationCtx,
  runner: RunnerCapability,
  now: string,
  taskRequestId?: string
): Promise<TaskRequest | null> {
  const candidates = taskRequestId
    ? [
        await uniqueByIndex<StoredDoc>(
          ctx,
          "taskRequests",
          "by_id",
          "id",
          taskRequestId
        )
      ].filter((task): task is StoredDoc => task !== null)
    : await collectByIndex<StoredDoc>(ctx, "taskRequests", "by_status", "status", "active");

  for (const candidate of candidates) {
    const task = parseTaskRequest(withoutSystemFields(candidate));
    const subscription = await subscriptionForTask(
      ctx,
      runner.volunteerUserId,
      task.projectId
    );
    const activeLeaseCount = await activeLeaseCountForTask(ctx, task.id, now);
    const runCount = await runCountForTask(ctx, task.id);

    if (
      canLeaseTask(
        {
          task,
          activeLeaseCount,
          runCount,
          subscription:
            subscription === null
              ? undefined
              : {
                  enabled: subscription.enabled as boolean,
                  taskTypeAllowlist: subscription.taskTypeAllowlist as string[],
                  maxSandbox: subscription.maxSandbox as string,
                  allowNetwork: subscription.allowNetwork as boolean,
                  allowPatches: subscription.allowPatches as boolean
                }
        },
        runner,
        now
      )
    ) {
      return task;
    }
  }

  return null;
}

export const createTask = mutation({
  args: {
    task: v.any()
  },
  handler: async (ctx, args) => {
    const task = parseTaskRequest(args.task);
    const existing = await uniqueByIndex<StoredDoc>(
      ctx,
      "taskRequests",
      "by_id",
      "id",
      task.id
    );

    if (existing !== null) {
      throw new Error(`Task request already exists: ${task.id}`);
    }

    await ctx.db.insert("taskRequests", task);
    await insertAuditEvent(ctx, {
      eventType: "task.created",
      entityType: "taskRequest",
      entityId: task.id,
      projectId: task.projectId,
      taskRequestId: task.id,
      actorUserId: task.createdByUserId,
      occurredAt: task.createdAt,
      metadata: { status: task.status }
    });

    return task;
  }
});

export const activateTask = mutation({
  args: {
    taskRequestId: v.string(),
    actorUserId: v.string(),
    now: v.string()
  },
  handler: async (ctx, args) => {
    const now = requireIsoNow(args.now);
    const task = await uniqueByIndex<StoredDoc>(
      ctx,
      "taskRequests",
      "by_id",
      "id",
      args.taskRequestId
    );

    if (task === null) {
      throw new Error(`Task request not found: ${args.taskRequestId}`);
    }

    const parsedTask = parseTaskRequest(withoutSystemFields(task));

    if (parsedTask.status === "archived" || parsedTask.status === "expired") {
      throw new Error(`Cannot activate ${parsedTask.status} task`);
    }

    if (parsedTask.expiresAt !== undefined && Date.parse(parsedTask.expiresAt) <= Date.parse(now)) {
      throw new Error("Cannot activate an expired task request");
    }

    await ctx.db.patch(task._id, { status: "active", updatedAt: now });
    await insertAuditEvent(ctx, {
      eventType: "task.activated",
      entityType: "taskRequest",
      entityId: parsedTask.id,
      projectId: parsedTask.projectId,
      taskRequestId: parsedTask.id,
      actorUserId: args.actorUserId,
      occurredAt: now
    });

    return { ...parsedTask, status: "active", updatedAt: now } satisfies TaskRequest;
  }
});

export const registerRunner = mutation({
  args: {
    runner: v.any()
  },
  handler: async (ctx, args) => {
    const runner = parseRunnerCapability(args.runner);
    const existing = await uniqueByIndex<StoredDoc>(
      ctx,
      "runnerRegistrations",
      "by_runner_id",
      "runnerId",
      runner.runnerId
    );

    if (existing === null) {
      await ctx.db.insert("runnerRegistrations", runner);
    } else {
      await ctx.db.replace(existing._id, runner);
    }

    await insertAuditEvent(ctx, {
      eventType: existing === null ? "runner.registered" : "runner.updated",
      entityType: "runnerRegistration",
      entityId: runner.runnerId,
      actorUserId: runner.volunteerUserId,
      runnerId: runner.runnerId,
      occurredAt: runner.lastSeenAt,
      metadata: {
        platform: runner.platform,
        codexAuthMode: runner.codexAuthMode
      }
    });

    return runner;
  }
});

export const leaseTask = mutation({
  args: {
    runnerId: v.string(),
    volunteerUserId: v.string(),
    leaseId: v.string(),
    runId: v.string(),
    taskSnapshotHash: v.string(),
    leaseTokenHash: v.string(),
    now: v.string(),
    expiresAt: v.string(),
    taskRequestId: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    const now = requireIsoNow(args.now);
    requireIsoNow(args.expiresAt);

    if (Date.parse(args.expiresAt) <= Date.parse(now)) {
      throw new Error("Lease expiration must be after now");
    }

    const runnerDoc = await uniqueByIndex<StoredDoc>(
      ctx,
      "runnerRegistrations",
      "by_runner_id",
      "runnerId",
      args.runnerId
    );

    if (runnerDoc === null) {
      throw new Error(`Runner not registered: ${args.runnerId}`);
    }

    const runner = parseRunnerCapability(withoutSystemFields(runnerDoc));

    if (runner.volunteerUserId !== args.volunteerUserId) {
      throw new Error("Runner does not belong to volunteer");
    }

    const existingLease = await uniqueByIndex<StoredDoc>(
      ctx,
      "taskLeases",
      "by_lease_id",
      "leaseId",
      args.leaseId
    );
    const existingRun = await uniqueByIndex<StoredDoc>(
      ctx,
      "runs",
      "by_run_id",
      "runId",
      args.runId
    );

    if (existingLease !== null || existingRun !== null) {
      throw new Error("Lease or run id already exists");
    }

    const task = await findLeaseableTask(ctx, runner, now, args.taskRequestId);

    if (task === null) {
      return null;
    }

    const attempt = (await runCountForTask(ctx, task.id)) + 1;
    const lease = parseTaskLease({
      leaseId: args.leaseId,
      runId: args.runId,
      taskRequestId: task.id,
      projectId: task.projectId,
      runnerId: runner.runnerId,
      volunteerUserId: runner.volunteerUserId,
      status: "active",
      attempt,
      taskSnapshotHash: args.taskSnapshotHash,
      leaseTokenHash: args.leaseTokenHash,
      leasedAt: now,
      expiresAt: args.expiresAt,
      heartbeatAt: now
    } satisfies TaskLease);

    await ctx.db.insert("runs", {
      runId: args.runId,
      taskRequestId: task.id,
      projectId: task.projectId,
      leaseId: args.leaseId,
      runnerId: runner.runnerId,
      volunteerUserId: runner.volunteerUserId,
      status: "leased",
      attempt,
      taskSnapshotHash: args.taskSnapshotHash,
      startedAt: now,
      createdAt: now,
      updatedAt: now
    });
    await ctx.db.insert("taskLeases", lease);
    await insertAuditEvent(ctx, {
      eventType: "task.leased",
      entityType: "taskLease",
      entityId: lease.leaseId,
      projectId: task.projectId,
      taskRequestId: task.id,
      runId: args.runId,
      leaseId: args.leaseId,
      actorUserId: runner.volunteerUserId,
      runnerId: runner.runnerId,
      occurredAt: now,
      metadata: { attempt }
    });

    return { task, lease };
  }
});

export const heartbeatLease = mutation({
  args: {
    leaseId: v.string(),
    runnerId: v.string(),
    now: v.string(),
    expiresAt: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    const now = requireIsoNow(args.now);
    const nextExpiresAt = args.expiresAt ?? undefined;

    if (nextExpiresAt !== undefined) {
      requireIsoNow(nextExpiresAt);
    }

    const leaseDoc = await uniqueByIndex<StoredDoc>(
      ctx,
      "taskLeases",
      "by_lease_id",
      "leaseId",
      args.leaseId
    );

    if (leaseDoc === null) {
      throw new Error(`Lease not found: ${args.leaseId}`);
    }

    const lease = parseTaskLease(withoutSystemFields(leaseDoc));

    if (lease.runnerId !== args.runnerId) {
      throw new Error("Lease does not belong to runner");
    }

    if (lease.status !== "active") {
      throw new Error(`Cannot heartbeat ${lease.status} lease`);
    }

    if (Date.parse(lease.expiresAt) <= Date.parse(now)) {
      throw new Error("Cannot heartbeat an expired lease");
    }

    if (nextExpiresAt !== undefined && Date.parse(nextExpiresAt) <= Date.parse(now)) {
      throw new Error("Heartbeat expiration must be after now");
    }

    const patch = {
      heartbeatAt: now,
      expiresAt: nextExpiresAt ?? lease.expiresAt
    };
    await ctx.db.patch(leaseDoc._id, patch);
    await insertAuditEvent(ctx, {
      eventType: "lease.heartbeat",
      entityType: "taskLease",
      entityId: lease.leaseId,
      projectId: lease.projectId,
      taskRequestId: lease.taskRequestId,
      runId: lease.runId,
      leaseId: lease.leaseId,
      actorUserId: lease.volunteerUserId,
      runnerId: lease.runnerId,
      occurredAt: now
    });

    return { ...lease, ...patch } satisfies TaskLease;
  }
});

async function writeTerminalResult(
  ctx: MutationCtx,
  resultPackage: ResultPackage,
  now: string
): Promise<ResultPackage> {
  const runDoc = await uniqueByIndex<StoredDoc>(
    ctx,
    "runs",
    "by_run_id",
    "runId",
    resultPackage.runId
  );

  if (runDoc === null) {
    throw new Error(`Run not found: ${resultPackage.runId}`);
  }

  if (isTerminalRunStatus(runDoc.status as string)) {
    throw new Error(`Run is already terminal: ${String(runDoc.status)}`);
  }

  const leaseDoc = await uniqueByIndex<StoredDoc>(
    ctx,
    "taskLeases",
    "by_lease_id",
    "leaseId",
    resultPackage.leaseId
  );

  if (leaseDoc === null) {
    throw new Error(`Lease not found: ${resultPackage.leaseId}`);
  }

  const lease = parseTaskLease(withoutSystemFields(leaseDoc));
  assertLeaseCanReceiveTerminalResult(lease, now, resultPackage.completedAt);

  if (
    lease.runId !== resultPackage.runId ||
    lease.taskRequestId !== resultPackage.taskRequestId ||
    lease.projectId !== resultPackage.projectId
  ) {
    throw new Error("Result package does not match lease");
  }

  if (
    (resultPackage.runnerId !== undefined && resultPackage.runnerId !== lease.runnerId) ||
    (resultPackage.volunteerUserId !== undefined &&
      resultPackage.volunteerUserId !== lease.volunteerUserId)
  ) {
    throw new Error("Result package identity does not match lease");
  }

  const existingResultPackage = await uniqueByIndex<StoredDoc>(
    ctx,
    "resultPackages",
    "by_result_package_id",
    "resultPackageId",
    resultPackage.resultPackageId
  );

  if (existingResultPackage !== null) {
    throw new Error(`Result package already exists: ${resultPackage.resultPackageId}`);
  }

  await ctx.db.insert("resultPackages", toConvexDocument(resultPackage));
  await ctx.db.patch(runDoc._id, {
    status: resultPackage.runStatus,
    completedAt: resultPackage.completedAt,
    updatedAt: now
  });
  await ctx.db.patch(leaseDoc._id, {
    status: resultPackage.runStatus === "completed" ? "completed" : "released",
    releasedAt: resultPackage.completedAt
  });
  await insertAuditEvent(ctx, {
    eventType: `run.${resultPackage.runStatus}`,
    entityType: "run",
    entityId: resultPackage.runId,
    projectId: resultPackage.projectId,
    taskRequestId: resultPackage.taskRequestId,
    runId: resultPackage.runId,
    leaseId: resultPackage.leaseId,
    actorUserId: resultPackage.volunteerUserId,
    runnerId: resultPackage.runnerId,
    occurredAt: resultPackage.completedAt,
    metadata: { resultPackageId: resultPackage.resultPackageId }
  });

  return resultPackage;
}

export const completeRun = mutation({
  args: {
    resultPackage: v.any(),
    now: v.string()
  },
  handler: async (ctx, args) => {
    const now = requireIsoNow(args.now);
    const resultPackage = parseResultPackage(args.resultPackage);
    assertTerminalResultPackage(resultPackage, "completed");

    return await writeTerminalResult(ctx, resultPackage, now);
  }
});

export const failRun = mutation({
  args: {
    resultPackage: v.any(),
    now: v.string()
  },
  handler: async (ctx, args) => {
    const now = requireIsoNow(args.now);
    const resultPackage = parseResultPackage(args.resultPackage);
    assertTerminalResultPackage(resultPackage, "failed");

    return await writeTerminalResult(ctx, resultPackage, now);
  }
});

export const expireLease = mutation({
  args: {
    leaseId: v.string(),
    now: v.string()
  },
  handler: async (ctx, args) => {
    const now = requireIsoNow(args.now);
    const leaseDoc = await uniqueByIndex<StoredDoc>(
      ctx,
      "taskLeases",
      "by_lease_id",
      "leaseId",
      args.leaseId
    );

    if (leaseDoc === null) {
      throw new Error(`Lease not found: ${args.leaseId}`);
    }

    const lease = parseTaskLease(withoutSystemFields(leaseDoc));

    if (!shouldExpireLease(lease, now)) {
      return { expired: false, lease };
    }

    const runDoc = await uniqueByIndex<StoredDoc>(
      ctx,
      "runs",
      "by_run_id",
      "runId",
      lease.runId
    );

    await ctx.db.patch(leaseDoc._id, {
      status: "expired",
      releasedAt: now
    });

    if (runDoc !== null && !isTerminalRunStatus(runDoc.status as string)) {
      await ctx.db.patch(runDoc._id, {
        status: "expired",
        completedAt: now,
        updatedAt: now
      });
    }

    await insertAuditEvent(ctx, {
      eventType: "lease.expired",
      entityType: "taskLease",
      entityId: lease.leaseId,
      projectId: lease.projectId,
      taskRequestId: lease.taskRequestId,
      runId: lease.runId,
      leaseId: lease.leaseId,
      actorUserId: lease.volunteerUserId,
      runnerId: lease.runnerId,
      occurredAt: now
    });

    return {
      expired: true,
      lease: { ...lease, status: "expired", releasedAt: now } satisfies TaskLease
    };
  }
});
