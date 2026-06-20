import {
  parseResultPackage,
  parseRunnerCapability,
  parseTaskLease,
  parseTaskRequest,
  parseVolunteerPolicy,
  assertNoSafetyIssues,
  redactResultPackage,
  validatePrivateBetaRateLimits,
  validatePrivateBetaTaskRequest,
  type ResultPackage,
  type RunnerCapability,
  type TaskLease,
  type TaskRequest,
  type VolunteerPolicy
} from "@oss-capacity/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  type IndexRangeBuilder,
  internalMutationGeneric,
  mutationGeneric,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  queryGeneric
} from "convex/server";
import { v, type GenericId, type Value } from "convex/values";

import {
  assertLeaseCanReceiveTerminalResult,
  assertTerminalResultPackage,
  canLeaseTask,
  isTerminalRunStatus,
  shouldExpireLease,
  shouldExpireStaleRun
} from "./lifecycleLogic.js";
import {
  maintainerResultListPackageView,
  maintainerResultPackageView,
  maintainerRunView,
  type MaintainerResultListPackage,
  type MaintainerResultPackage,
  type MaintainerRunInput,
  type MaintainerRunView
} from "./maintainerResultViews.js";

type MutationCtx = GenericMutationCtx<GenericDataModel>;
type QueryCtx = GenericQueryCtx<GenericDataModel>;
type StoredDoc = {
  readonly _id: GenericId<string>;
  readonly [key: string]: Value;
};
type TaskLeaseIndexDocument = Record<"taskRequestId" | "status", string> &
  Record<string, Value>;
type TaskLeaseExpiryIndexDocument = Record<"status" | "expiresAt", string> &
  Record<string, Value>;
type RunCleanupIndexDocument = Record<"status" | "updatedAt", string> &
  Record<string, Value>;
type VolunteerProjectSubscriptionIndexDocument = Record<
  "volunteerUserId" | "projectId",
  string
> &
  Record<string, Value>;
type ProjectRepositoryView = {
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch?: string;
};
type MaintainerResultTaskSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly status: string;
  readonly title: string;
  readonly type: string;
  readonly priority: string;
  readonly updatedAt: string;
};
type MaintainerResultProjectView = {
  readonly projectId: string;
  readonly repository: ProjectRepositoryView;
  readonly status: string;
};
type MaintainerResultListItem = {
  readonly resultPackage: MaintainerResultListPackage;
  readonly run: MaintainerRunView | null;
  readonly task: MaintainerResultTaskSummary;
  readonly project: MaintainerResultProjectView;
};
type MaintainerResultDetail = {
  readonly resultPackage: MaintainerResultPackage;
  readonly run: MaintainerRunView | null;
  readonly task: TaskRequest;
  readonly project: MaintainerResultProjectView;
};
type AuditEventView = {
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly projectId?: string;
  readonly taskRequestId?: string;
  readonly runId?: string;
  readonly leaseId?: string;
  readonly runnerId?: string;
  readonly occurredAt: string;
  readonly actorScope: "maintainer" | "volunteer" | "runner" | "system";
  readonly metadata?: Value;
};

const mutation = mutationGeneric;
const internalMutation = internalMutationGeneric;
const query = queryGeneric;
const defaultCleanupBatchSize = 100;
const maximumCleanupBatchSize = 500;
const defaultMaintainerResultLimit = 50;
const maximumMaintainerResultLimit = 100;
const defaultAuditEventLimit = 50;
const maximumAuditEventLimit = 100;
const defaultStaleRunAgeMs = 60 * 60 * 1000;
const nonTerminalCleanupStatuses = ["queued", "leased", "running"] as const;

async function requireAuthenticatedUser(
  ctx: MutationCtx | QueryCtx
): Promise<StoredDoc & { readonly userId: string }> {
  const authUserId = await getAuthUserId(ctx);

  if (authUserId === null) {
    throw new Error("Authentication required");
  }

  const user = (await ctx.db.get(authUserId)) as StoredDoc | null;

  if (user === null || typeof user.userId !== "string") {
    throw new Error("Authenticated user record was not found");
  }

  return user as StoredDoc & { readonly userId: string };
}

async function requireMaintainerProject(
  ctx: MutationCtx | QueryCtx,
  projectId: string,
  actorUserId: string
): Promise<StoredDoc> {
  const project = await uniqueByIndex<StoredDoc>(
    ctx,
    "projects",
    "by_project_id",
    "projectId",
    projectId
  );

  if (project === null) {
    throw new Error(`Project not found: ${projectId}`);
  }

  if (project.createdByUserId !== actorUserId) {
    throw new Error("Only the project maintainer can manage its tasks");
  }

  if (project.status !== "verified") {
    throw new Error("Project must be verified before tasks can be managed");
  }

  return project;
}

async function verifiedProject(
  ctx: MutationCtx | QueryCtx,
  projectId: string
): Promise<StoredDoc | null> {
  const project = await uniqueByIndex<StoredDoc>(
    ctx,
    "projects",
    "by_project_id",
    "projectId",
    projectId
  );

  return project?.status === "verified" ? project : null;
}

async function isVerifiedMaintainerProject(
  ctx: MutationCtx | QueryCtx,
  projectId: string,
  actorUserId: string
): Promise<boolean> {
  const project = await verifiedProject(ctx, projectId);

  return project?.createdByUserId === actorUserId;
}

async function uniqueByIndex<T extends StoredDoc>(
  ctx: MutationCtx | QueryCtx,
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
  ctx: MutationCtx | QueryCtx,
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

function isoNow(): string {
  return new Date(Date.now()).toISOString();
}

function isoBefore(now: string, ageMs: number): string {
  return new Date(Date.parse(now) - ageMs).toISOString();
}

function indexTimestampUpperBound(now: string): string {
  return new Date(Date.parse(now)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function cleanupBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) {
    return defaultCleanupBatchSize;
  }

  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > maximumCleanupBatchSize
  ) {
    throw new Error(
      `Cleanup batch size must be an integer between 1 and ${maximumCleanupBatchSize}`
    );
  }

  return batchSize;
}

function maintainerResultLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return defaultMaintainerResultLimit;
  }

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > maximumMaintainerResultLimit
  ) {
    throw new Error(
      `Result inbox limit must be an integer between 1 and ${maximumMaintainerResultLimit}`
    );
  }

  return limit;
}

function queryLimit(
  value: number | undefined,
  label: string,
  defaultLimit: number,
  maximumLimit: number
): number {
  if (value === undefined) {
    return defaultLimit;
  }

  if (!Number.isInteger(value) || value < 1 || value > maximumLimit) {
    throw new Error(`${label} must be an integer between 1 and ${maximumLimit}`);
  }

  return value;
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

function runnerCapabilityFields(doc: StoredDoc): Record<string, Value> {
  const capability = withoutSystemFields(doc);
  delete capability.runnerAuthTokenHash;
  delete capability.status;
  delete capability.revokedAt;

  return capability;
}

function dayStart(value: string): string {
  return `${new Date(Date.parse(value)).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function occurredToday(value: Value, now: string): boolean {
  return (
    typeof value === "string" &&
    Date.parse(value) >= Date.parse(dayStart(now)) &&
    Date.parse(value) <= Date.parse(now)
  );
}

function auditEventView(event: StoredDoc, actorUserId: string): AuditEventView {
  const actorScope =
    event.actorUserId === actorUserId
      ? "maintainer"
      : event.runnerId !== undefined
        ? "runner"
        : event.actorUserId !== undefined
          ? "volunteer"
          : "system";

  return {
    eventType: String(event.eventType),
    entityType: String(event.entityType),
    entityId: String(event.entityId),
    projectId: typeof event.projectId === "string" ? event.projectId : undefined,
    taskRequestId:
      typeof event.taskRequestId === "string" ? event.taskRequestId : undefined,
    runId: typeof event.runId === "string" ? event.runId : undefined,
    leaseId: typeof event.leaseId === "string" ? event.leaseId : undefined,
    runnerId: typeof event.runnerId === "string" ? event.runnerId : undefined,
    occurredAt: String(event.occurredAt),
    actorScope,
    metadata: event.metadata
  };
}

function taskSummaryView(task: TaskRequest): MaintainerResultTaskSummary {
  return {
    id: task.id,
    projectId: task.projectId,
    status: task.status,
    title: task.title,
    type: task.type,
    priority: task.priority,
    updatedAt: task.updatedAt
  };
}

function runView(
  run: StoredDoc | null,
  resultPackage: ResultPackage
): MaintainerRunView | null {
  if (run === null) {
    return null;
  }

  const runInput = {
    runId: String(run.runId),
    taskRequestId: String(run.taskRequestId),
    projectId: String(run.projectId),
    leaseId: typeof run.leaseId === "string" ? run.leaseId : undefined,
    runnerId: typeof run.runnerId === "string" ? run.runnerId : undefined,
    status: String(run.status),
    attempt: Number(run.attempt),
    taskSnapshotHash:
      typeof run.taskSnapshotHash === "string" ? run.taskSnapshotHash : undefined,
    startedAt: typeof run.startedAt === "string" ? run.startedAt : undefined,
    completedAt: typeof run.completedAt === "string" ? run.completedAt : undefined,
    createdAt: String(run.createdAt),
    updatedAt: String(run.updatedAt)
  } satisfies MaintainerRunInput;

  return maintainerRunView(runInput, resultPackage);
}

function repositoryView(value: Value): ProjectRepositoryView {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value instanceof ArrayBuffer
  ) {
    throw new Error("Project repository is malformed");
  }

  const repository = value as Record<string, Value>;

  return {
    owner: String(repository.owner),
    name: String(repository.name),
    fullName: String(repository.fullName),
    defaultBranch:
      typeof repository.defaultBranch === "string" ? repository.defaultBranch : undefined
  };
}

async function maintainerResultItem(
  ctx: QueryCtx,
  resultDoc: StoredDoc,
  actorUserId: string
): Promise<MaintainerResultDetail | null> {
  const resultPackage = parseResultPackage(withoutSystemFields(resultDoc));
  const [taskDoc, projectDoc, runDoc] = await Promise.all([
    uniqueByIndex<StoredDoc>(
      ctx,
      "taskRequests",
      "by_id",
      "id",
      resultPackage.taskRequestId
    ),
    uniqueByIndex<StoredDoc>(
      ctx,
      "projects",
      "by_project_id",
      "projectId",
      resultPackage.projectId
    ),
    uniqueByIndex<StoredDoc>(
      ctx,
      "runs",
      "by_run_id",
      "runId",
      resultPackage.runId
    )
  ]);

  if (
    taskDoc === null ||
    projectDoc === null ||
    projectDoc.createdByUserId !== actorUserId ||
    projectDoc.status !== "verified"
  ) {
    return null;
  }

  const task = parseTaskRequest(withoutSystemFields(taskDoc));

  if (task.createdByUserId !== actorUserId || task.projectId !== resultPackage.projectId) {
    return null;
  }

  return {
    resultPackage: maintainerResultPackageView(resultPackage),
    run: runView(runDoc, resultPackage),
    task,
    project: {
      projectId: String(projectDoc.projectId),
      repository: repositoryView(projectDoc.repository),
      status: String(projectDoc.status)
    }
  };
}

async function maintainerResultListItem(
  ctx: QueryCtx,
  resultDoc: StoredDoc,
  actorUserId: string
): Promise<MaintainerResultListItem | null> {
  const item = await maintainerResultItem(ctx, resultDoc, actorUserId);

  if (item === null) {
    return null;
  }

  return {
    resultPackage: maintainerResultListPackageView(item.resultPackage),
    run: item.run,
    task: taskSummaryView(item.task),
    project: item.project
  };
}

async function activeLeaseCountForTask(
  ctx: MutationCtx,
  taskRequestId: string,
  now: string
): Promise<number> {
  const leases = (await ctx.db
    .query("taskLeases")
    .withIndex("by_task_status", (q) => {
      const range = q as unknown as IndexRangeBuilder<
        TaskLeaseIndexDocument,
        ["taskRequestId", "status"]
      >;

      return range.eq("taskRequestId", taskRequestId).eq("status", "active");
    })
    .collect()) as StoredDoc[];

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

async function projectActiveTaskCount(
  ctx: MutationCtx,
  projectId: string
): Promise<number> {
  const tasks = (await ctx.db
    .query("taskRequests")
    .withIndex("by_project_status", (q) => {
      const range = q as unknown as IndexRangeBuilder<
        Record<"projectId" | "status", string> & Record<string, Value>,
        ["projectId", "status"]
      >;

      return range.eq("projectId", projectId).eq("status", "active");
    })
    .collect()) as StoredDoc[];

  return tasks.length;
}

async function projectTasksCreatedToday(
  ctx: MutationCtx,
  projectId: string,
  now: string
): Promise<number> {
  const tasks = (await ctx.db
    .query("taskRequests")
    .withIndex("by_project_status", (q) => q.eq("projectId", projectId))
    .collect()) as StoredDoc[];

  return tasks.filter((task) => occurredToday(task.createdAt, now)).length;
}

async function runsLeasedTodayFor(
  ctx: MutationCtx,
  field: "projectId" | "volunteerUserId",
  value: string,
  now: string
): Promise<number> {
  const runs = (await ctx.db.query("runs").collect()) as StoredDoc[];

  return runs.filter(
    (run) => run[field] === value && occurredToday(run.createdAt, now)
  ).length;
}

async function subscriptionForTask(
  ctx: MutationCtx,
  volunteerUserId: string,
  projectId: string
): Promise<StoredDoc | null> {
  return (await ctx.db
    .query("volunteerProjectSubscriptions")
    .withIndex("by_volunteer_project", (q) => {
      const range = q as unknown as IndexRangeBuilder<
        VolunteerProjectSubscriptionIndexDocument,
        ["volunteerUserId", "projectId"]
      >;

      return range.eq("volunteerUserId", volunteerUserId).eq("projectId", projectId);
    })
    .unique()) as StoredDoc | null;
}

async function policyForVolunteer(
  ctx: MutationCtx,
  volunteerUserId: string
): Promise<VolunteerPolicy | null> {
  const policy = (await ctx.db
    .query("volunteerPolicies")
    .withIndex("by_volunteer", (q) => q.eq("volunteerUserId", volunteerUserId))
    .unique()) as StoredDoc | null;

  return policy === null ? null : parseVolunteerPolicy(withoutSystemFields(policy));
}

async function findLeaseableTask(
  ctx: MutationCtx,
  runner: RunnerCapability,
  now: string,
  taskRequestId?: string
): Promise<TaskRequest | null> {
  const policy = await policyForVolunteer(ctx, runner.volunteerUserId);
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
    const project = await verifiedProject(ctx, task.projectId);

    if (project === null) {
      continue;
    }

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
                },
          policy: policy ?? undefined,
          rateLimits: {
            projectRunsLeasedToday: await runsLeasedTodayFor(
              ctx,
              "projectId",
              task.projectId,
              now
            ),
            volunteerRunsLeasedToday: await runsLeasedTodayFor(
              ctx,
              "volunteerUserId",
              runner.volunteerUserId,
              now
            )
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

async function collectExpiredActiveLeases(
  ctx: MutationCtx,
  now: string,
  batchSize: number
): Promise<StoredDoc[]> {
  const activeLeases = (await ctx.db
    .query("taskLeases")
    .withIndex("by_status_expires_at", (q) => {
      const range = q as unknown as IndexRangeBuilder<
        TaskLeaseExpiryIndexDocument,
        ["status", "expiresAt"]
      >;

      return range
        .eq("status", "active")
        .lte("expiresAt", indexTimestampUpperBound(now));
    })
    .take(batchSize)) as StoredDoc[];

  return activeLeases
    .filter(
      (lease) =>
        typeof lease.expiresAt === "string" &&
        Date.parse(lease.expiresAt) <= Date.parse(now)
    )
    .slice(0, batchSize);
}

async function collectStaleRunCandidates(
  ctx: MutationCtx,
  status: string,
  staleBefore: string,
  batchSize: number
): Promise<StoredDoc[]> {
  const runsWithStatus = (await ctx.db
    .query("runs")
    .withIndex("by_status_updated_at", (q) => {
      const range = q as unknown as IndexRangeBuilder<
        RunCleanupIndexDocument,
        ["status", "updatedAt"]
      >;

      return range
        .eq("status", status)
        .lte("updatedAt", indexTimestampUpperBound(staleBefore));
    })
    .take(batchSize)) as StoredDoc[];

  return runsWithStatus
    .filter(
      (run) =>
        typeof run.updatedAt === "string" &&
        Date.parse(run.updatedAt) <= Date.parse(staleBefore)
    )
    .slice(0, batchSize);
}

async function expireLeaseDocument(
  ctx: MutationCtx,
  leaseDoc: StoredDoc,
  now: string,
  metadata?: Record<string, Value>
): Promise<{ readonly expired: boolean; readonly lease: TaskLease }> {
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
    occurredAt: now,
    metadata
  });

  return {
    expired: true,
    lease: { ...lease, status: "expired", releasedAt: now } satisfies TaskLease
  };
}

export const createTask = mutation({
  args: {
    task: v.any()
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
    const parsedTask = parseTaskRequest(args.task);
    const now = isoNow();
    const task = {
      ...parsedTask,
      createdByUserId: actor.userId,
      status: "draft",
      createdAt: now,
      updatedAt: now
    } satisfies TaskRequest;
    const project = await requireMaintainerProject(
      ctx,
      task.projectId,
      actor.userId
    );
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

    if (parsedTask.status !== "draft") {
      throw new Error("Task requests must be created as drafts before activation");
    }

    if (
      project.repository !== undefined &&
      JSON.stringify(project.repository) !== JSON.stringify(task.repository)
    ) {
      throw new Error("Task repository must match the verified project");
    }

    assertNoSafetyIssues(validatePrivateBetaTaskRequest(task));
    assertNoSafetyIssues(
      validatePrivateBetaRateLimits({
        projectTasksCreatedToday: await projectTasksCreatedToday(
          ctx,
          task.projectId,
          now
        )
      })
    );

    await ctx.db.insert("taskRequests", task);
    await insertAuditEvent(ctx, {
      eventType: "task.created",
      entityType: "taskRequest",
      entityId: task.id,
      projectId: task.projectId,
      taskRequestId: task.id,
      actorUserId: actor.userId,
      occurredAt: task.createdAt,
      metadata: { status: task.status }
    });

    return task;
  }
});

export const myTasks = query({
  args: {
    projectId: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
    const taskDocs = await collectByIndex<StoredDoc>(
      ctx,
      "taskRequests",
      "by_created_by",
      "createdByUserId",
      actor.userId
    );
    const verifiedTasks: TaskRequest[] = [];

    for (const taskDoc of taskDocs) {
      const task = parseTaskRequest(withoutSystemFields(taskDoc));

      if (
        await isVerifiedMaintainerProject(ctx, task.projectId, actor.userId)
      ) {
        verifiedTasks.push(task);
      }
    }

    return verifiedTasks
      .filter((task) => args.projectId === undefined || task.projectId === args.projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
});

export const taskDetail = query({
  args: {
    taskRequestId: v.string()
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
    const task = await uniqueByIndex<StoredDoc>(
      ctx,
      "taskRequests",
      "by_id",
      "id",
      args.taskRequestId
    );

    if (task === null) {
      return null;
    }

    const parsedTask = parseTaskRequest(withoutSystemFields(task));

    if (parsedTask.createdByUserId !== actor.userId) {
      throw new Error("Only the task creator can view this task");
    }

    await requireMaintainerProject(ctx, parsedTask.projectId, actor.userId);

    return parsedTask;
  }
});

export const maintainerResults = query({
  args: {
    projectId: v.optional(v.string()),
    limit: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
    const limit = maintainerResultLimit(args.limit);
    const projectDocs = await collectByIndex<StoredDoc>(
      ctx,
      "projects",
      "by_created_by",
      "createdByUserId",
      actor.userId
    );
    const verifiedProjectIds = projectDocs
      .filter(
        (project) =>
          project.status === "verified" &&
          (args.projectId === undefined || project.projectId === args.projectId)
      )
      .map((project) => String(project.projectId));
    const items: MaintainerResultListItem[] = [];

    for (const projectId of verifiedProjectIds) {
      const resultDocs = (await ctx.db
        .query("resultPackages")
        .withIndex("by_project_completed_at", (q) => q.eq("projectId", projectId))
        .order("desc")
        .take(limit)) as StoredDoc[];

      for (const resultDoc of resultDocs) {
        const item = await maintainerResultListItem(ctx, resultDoc, actor.userId);

        if (item !== null) {
          items.push(item);
        }
      }
    }

    return items.sort((left, right) =>
      right.resultPackage.completedAt.localeCompare(left.resultPackage.completedAt)
    ).slice(0, limit);
  }
});

export const resultDetail = query({
  args: {
    resultPackageId: v.string()
  },
  handler: async (ctx, args): Promise<MaintainerResultDetail | null> => {
    const actor = await requireAuthenticatedUser(ctx);
    const resultDoc = await uniqueByIndex<StoredDoc>(
      ctx,
      "resultPackages",
      "by_result_package_id",
      "resultPackageId",
      args.resultPackageId
    );

    if (resultDoc === null) {
      return null;
    }

    return await maintainerResultItem(ctx, resultDoc, actor.userId);
  }
});

export const auditEvents = query({
  args: {
    projectId: v.optional(v.string()),
    taskRequestId: v.optional(v.string()),
    limit: v.optional(v.number())
  },
  handler: async (ctx, args): Promise<AuditEventView[]> => {
    const actor = await requireAuthenticatedUser(ctx);
    const limit = queryLimit(
      args.limit,
      "Audit event limit",
      defaultAuditEventLimit,
      maximumAuditEventLimit
    );
    const projectDocs = await collectByIndex<StoredDoc>(
      ctx,
      "projects",
      "by_created_by",
      "createdByUserId",
      actor.userId
    );
    const projectIds = new Set(
      projectDocs
        .filter(
          (project) =>
            project.status === "verified" &&
            (args.projectId === undefined || project.projectId === args.projectId)
        )
        .map((project) => String(project.projectId))
    );

    if (args.projectId !== undefined && !projectIds.has(args.projectId)) {
      throw new Error("Only the project maintainer can view project audit events");
    }

    const events: StoredDoc[] = [];

    for (const projectId of projectIds) {
      events.push(
        ...(await collectByIndex<StoredDoc>(
          ctx,
          "auditEvents",
          "by_project",
          "projectId",
          projectId
        ))
      );
    }

    return events
      .filter(
        (event) =>
          args.taskRequestId === undefined ||
          event.taskRequestId === args.taskRequestId
      )
      .sort((left, right) =>
        String(right.occurredAt).localeCompare(String(left.occurredAt))
      )
      .slice(0, limit)
      .map((event) => auditEventView(event, actor.userId));
  }
});

export const activateTask = mutation({
  args: {
    taskRequestId: v.string(),
    actorUserId: v.optional(v.string()),
    now: v.string()
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
    requireIsoNow(args.now);
    const now = isoNow();

    if (
      args.actorUserId !== undefined &&
      args.actorUserId !== actor.userId
    ) {
      throw new Error("Actor does not match authenticated user");
    }

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

    if (parsedTask.createdByUserId !== actor.userId) {
      throw new Error("Only the task creator can activate this task");
    }

    await requireMaintainerProject(ctx, parsedTask.projectId, actor.userId);

    if (parsedTask.expiresAt !== undefined && Date.parse(parsedTask.expiresAt) <= Date.parse(now)) {
      throw new Error("Cannot activate an expired task request");
    }

    assertNoSafetyIssues(validatePrivateBetaTaskRequest(parsedTask));
    assertNoSafetyIssues(
      validatePrivateBetaRateLimits({
        projectActiveTaskCount: await projectActiveTaskCount(ctx, parsedTask.projectId)
      })
    );

    await ctx.db.patch(task._id, { status: "active", updatedAt: now });
    await insertAuditEvent(ctx, {
      eventType: "task.activated",
      entityType: "taskRequest",
      entityId: parsedTask.id,
      projectId: parsedTask.projectId,
      taskRequestId: parsedTask.id,
      actorUserId: actor.userId,
      occurredAt: now
    });

    return { ...parsedTask, status: "active", updatedAt: now } satisfies TaskRequest;
  }
});

export const archiveTask = mutation({
  args: {
    taskRequestId: v.string(),
    now: v.string()
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
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

    if (parsedTask.createdByUserId !== actor.userId) {
      throw new Error("Only the task creator can archive this task");
    }

    await requireMaintainerProject(ctx, parsedTask.projectId, actor.userId);

    if (parsedTask.status === "archived") {
      return parsedTask;
    }

    await ctx.db.patch(task._id, { status: "archived", updatedAt: now });
    await insertAuditEvent(ctx, {
      eventType: "task.archived",
      entityType: "taskRequest",
      entityId: parsedTask.id,
      projectId: parsedTask.projectId,
      taskRequestId: parsedTask.id,
      actorUserId: actor.userId,
      occurredAt: now,
      metadata: { previousStatus: parsedTask.status }
    });

    return { ...parsedTask, status: "archived", updatedAt: now } satisfies TaskRequest;
  }
});

export const registerRunner = mutation({
  args: {
    runner: v.any()
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
    const parsedRunner = parseRunnerCapability(args.runner);
    const runner = {
      ...parsedRunner,
      volunteerUserId: actor.userId
    } satisfies RunnerCapability;
    const existing = await uniqueByIndex<StoredDoc>(
      ctx,
      "runnerRegistrations",
      "by_runner_id",
      "runnerId",
      runner.runnerId
    );

    if (
      existing !== null &&
      existing.volunteerUserId !== actor.userId
    ) {
      throw new Error("Runner does not belong to authenticated user");
    }

    if (existing === null) {
      await ctx.db.insert("runnerRegistrations", runner);
    } else {
      if (existing.status === "revoked") {
        throw new Error(
          "Runner registration was revoked. Use a new setup token to reactivate it."
        );
      }

      await ctx.db.replace(existing._id, runner);
    }

    await insertAuditEvent(ctx, {
      eventType: existing === null ? "runner.registered" : "runner.updated",
      entityType: "runnerRegistration",
      entityId: runner.runnerId,
      actorUserId: actor.userId,
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
    const actor = await requireAuthenticatedUser(ctx);
    requireIsoNow(args.now);
    const now = isoNow();
    requireIsoNow(args.expiresAt);

    if (args.volunteerUserId !== actor.userId) {
      throw new Error("Volunteer does not match authenticated user");
    }

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

    if (runnerDoc.status === "revoked") {
      throw new Error("Runner registration was revoked");
    }

    const runner = parseRunnerCapability(runnerCapabilityFields(runnerDoc));

    if (runner.volunteerUserId !== actor.userId) {
      throw new Error("Runner does not belong to authenticated user");
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
    const actor = await requireAuthenticatedUser(ctx);
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

    if (lease.volunteerUserId !== actor.userId) {
      throw new Error("Lease does not belong to authenticated user");
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
  now: string,
  actorUserId: string
): Promise<ResultPackage> {
  const safeResultPackage = redactResultPackage(resultPackage);
  const runDoc = await uniqueByIndex<StoredDoc>(
    ctx,
    "runs",
    "by_run_id",
    "runId",
    safeResultPackage.runId
  );

  if (runDoc === null) {
    throw new Error(`Run not found: ${safeResultPackage.runId}`);
  }

  if (isTerminalRunStatus(runDoc.status as string)) {
    throw new Error(`Run is already terminal: ${String(runDoc.status)}`);
  }

  const leaseDoc = await uniqueByIndex<StoredDoc>(
    ctx,
    "taskLeases",
    "by_lease_id",
    "leaseId",
    safeResultPackage.leaseId
  );

  if (leaseDoc === null) {
    throw new Error(`Lease not found: ${safeResultPackage.leaseId}`);
  }

  const lease = parseTaskLease(withoutSystemFields(leaseDoc));
  assertLeaseCanReceiveTerminalResult(lease, now, safeResultPackage.completedAt);

  if (lease.volunteerUserId !== actorUserId) {
    throw new Error("Lease does not belong to authenticated user");
  }

  if (
    lease.runId !== safeResultPackage.runId ||
    lease.taskRequestId !== safeResultPackage.taskRequestId ||
    lease.projectId !== safeResultPackage.projectId
  ) {
    throw new Error("Result package does not match lease");
  }

  if (
    (safeResultPackage.runnerId !== undefined &&
      safeResultPackage.runnerId !== lease.runnerId) ||
    (safeResultPackage.volunteerUserId !== undefined &&
      safeResultPackage.volunteerUserId !== lease.volunteerUserId)
  ) {
    throw new Error("Result package identity does not match lease");
  }

  const existingResultPackage = await uniqueByIndex<StoredDoc>(
    ctx,
    "resultPackages",
    "by_result_package_id",
    "resultPackageId",
    safeResultPackage.resultPackageId
  );

  if (existingResultPackage !== null) {
    throw new Error(`Result package already exists: ${safeResultPackage.resultPackageId}`);
  }

  await ctx.db.insert("resultPackages", toConvexDocument(safeResultPackage));
  await ctx.db.patch(runDoc._id, {
    status: safeResultPackage.runStatus,
    completedAt: safeResultPackage.completedAt,
    updatedAt: now
  });
  await ctx.db.patch(leaseDoc._id, {
    status: safeResultPackage.runStatus === "completed" ? "completed" : "released",
    releasedAt: safeResultPackage.completedAt
  });
  await insertAuditEvent(ctx, {
    eventType: `run.${safeResultPackage.runStatus}`,
    entityType: "run",
    entityId: safeResultPackage.runId,
    projectId: safeResultPackage.projectId,
    taskRequestId: safeResultPackage.taskRequestId,
    runId: safeResultPackage.runId,
    leaseId: safeResultPackage.leaseId,
    actorUserId,
    runnerId: safeResultPackage.runnerId,
    occurredAt: safeResultPackage.completedAt,
    metadata: { resultPackageId: safeResultPackage.resultPackageId }
  });

  return safeResultPackage;
}

export const completeRun = mutation({
  args: {
    resultPackage: v.any(),
    now: v.string()
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
    requireIsoNow(args.now);
    const now = isoNow();
    const resultPackage = parseResultPackage(args.resultPackage);
    assertTerminalResultPackage(resultPackage, "completed");

    return await writeTerminalResult(ctx, resultPackage, now, actor.userId);
  }
});

export const failRun = mutation({
  args: {
    resultPackage: v.any(),
    now: v.string()
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
    requireIsoNow(args.now);
    const now = isoNow();
    const resultPackage = parseResultPackage(args.resultPackage);
    assertTerminalResultPackage(resultPackage, "failed");

    return await writeTerminalResult(ctx, resultPackage, now, actor.userId);
  }
});

export const expireLease = mutation({
  args: {
    leaseId: v.string(),
    now: v.string()
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
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

    if (lease.volunteerUserId !== actor.userId) {
      throw new Error("Lease does not belong to authenticated user");
    }

    if (!shouldExpireLease(lease, now)) {
      return { expired: false, lease };
    }

    return await expireLeaseDocument(ctx, leaseDoc, now);
  }
});

export const expireStaleLeases = internalMutation({
  args: {
    now: v.optional(v.string()),
    batchSize: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    const now = requireIsoNow(args.now ?? isoNow());
    const batchSize = cleanupBatchSize(args.batchSize);
    const leaseDocs = await collectExpiredActiveLeases(ctx, now, batchSize);
    let expiredCount = 0;

    for (const leaseDoc of leaseDocs) {
      const result = await expireLeaseDocument(ctx, leaseDoc, now, {
        cleanup: true,
        reason: "lease_deadline"
      });

      if (result.expired) {
        expiredCount += 1;
      }
    }

    return {
      checked: leaseDocs.length,
      expired: expiredCount,
      hasMore: leaseDocs.length === batchSize
    };
  }
});

export const cleanupStaleRuns = internalMutation({
  args: {
    now: v.optional(v.string()),
    staleBefore: v.optional(v.string()),
    batchSize: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    const now = requireIsoNow(args.now ?? isoNow());
    const staleBefore = requireIsoNow(
      args.staleBefore ?? isoBefore(now, defaultStaleRunAgeMs)
    );
    const batchSize = cleanupBatchSize(args.batchSize);
    let checkedCount = 0;
    let expiredRunCount = 0;
    let expiredLeaseCount = 0;

    for (const status of nonTerminalCleanupStatuses) {
      const remaining = batchSize - checkedCount;

      if (remaining <= 0) {
        break;
      }

      const runDocs = await collectStaleRunCandidates(
        ctx,
        status,
        staleBefore,
        remaining
      );
      checkedCount += runDocs.length;

      for (const runDoc of runDocs) {
        const runStatus = String(runDoc.status);

        if (isTerminalRunStatus(runStatus)) {
          continue;
        }

        const leaseId =
          typeof runDoc.leaseId === "string" ? runDoc.leaseId : undefined;
        const leaseDoc =
          leaseId === undefined
            ? null
            : await uniqueByIndex<StoredDoc>(
                ctx,
                "taskLeases",
                "by_lease_id",
                "leaseId",
                leaseId
              );
        const lease =
          leaseDoc === null ? null : parseTaskLease(withoutSystemFields(leaseDoc));
        const decision = shouldExpireStaleRun(
          { status: runStatus, leaseId },
          lease,
          now
        );

        if (!decision.shouldExpire) {
          continue;
        }

        if (leaseDoc !== null && lease !== null && shouldExpireLease(lease, now)) {
          const result = await expireLeaseDocument(ctx, leaseDoc, now, {
            cleanup: true,
            reason: "stale_run_cleanup"
          });

          if (result.expired) {
            expiredLeaseCount += 1;
          }
        }

        await ctx.db.patch(runDoc._id, {
          status: "expired",
          completedAt: now,
          updatedAt: now
        });
        await insertAuditEvent(ctx, {
          eventType: "run.expired",
          entityType: "run",
          entityId: String(runDoc.runId),
          projectId:
            typeof runDoc.projectId === "string" ? runDoc.projectId : undefined,
          taskRequestId:
            typeof runDoc.taskRequestId === "string"
              ? runDoc.taskRequestId
              : undefined,
          runId: typeof runDoc.runId === "string" ? runDoc.runId : undefined,
          leaseId,
          actorUserId:
            typeof runDoc.volunteerUserId === "string"
              ? runDoc.volunteerUserId
              : undefined,
          runnerId: typeof runDoc.runnerId === "string" ? runDoc.runnerId : undefined,
          occurredAt: now,
          metadata: {
            cleanup: true,
            reason: decision.reason,
            leaseStatus: lease?.status
          }
        });
        expiredRunCount += 1;
      }
    }

    return {
      checked: checkedCount,
      expiredRuns: expiredRunCount,
      expiredLeases: expiredLeaseCount,
      hasMore: checkedCount === batchSize
    };
  }
});
