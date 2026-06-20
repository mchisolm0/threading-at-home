import { getAuthUserId } from "@convex-dev/auth/server";
import {
  parseResultPackage,
  parseRunnerCapability,
  parseTaskLease,
  parseTaskRequest,
  parseVolunteerPolicy,
  sandboxModes,
  taskTypes,
  type ResultPackage,
  type RunnerCapability,
  type TaskLease,
  type TaskRequest,
  type VolunteerPolicy
} from "@oss-capacity/core";
import {
  type IndexRangeBuilder,
  mutationGeneric,
  queryGeneric,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx
} from "convex/server";
import { v, type GenericId, type Value } from "convex/values";

import {
  assertLeaseCanReceiveTerminalResult,
  assertTerminalResultPackage,
  canLeaseTask,
  isTerminalRunStatus
} from "./lifecycleLogic.js";
import {
  assertRunnerAuthTokenHashMatches,
  assertRunnerSetupTokenCanBeExchanged,
  normalizeRunnerAuthTokenHash,
  normalizeRunnerSetupTokenHash
} from "./volunteerLogic.js";

type QueryCtx = GenericQueryCtx<GenericDataModel>;
type MutationCtx = GenericMutationCtx<GenericDataModel>;
type StoredDoc = {
  readonly _id: GenericId<string>;
  readonly [key: string]: Value;
};
type AuthenticatedUser = StoredDoc & {
  readonly userId: string;
};
type ProjectDoc = StoredDoc & {
  readonly projectId: string;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly fullName: string;
    readonly defaultBranch?: string;
  };
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};
type VolunteerSubscriptionRecord = {
  readonly volunteerUserId: string;
  readonly projectId: string;
  readonly enabled: boolean;
  readonly taskTypeAllowlist: string[];
  readonly maxSandbox: string;
  readonly allowNetwork: boolean;
  readonly allowPatches: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};
type VolunteerSubscriptionDoc = StoredDoc & VolunteerSubscriptionRecord;
type RunnerSetupTokenRecord = {
  readonly tokenId: string;
  readonly volunteerUserId: string;
  readonly tokenHash: string;
  readonly label?: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly lastUsedAt?: string;
};
type RunnerSetupTokenDoc = StoredDoc & RunnerSetupTokenRecord;
type RunnerRegistrationView = {
  readonly runnerId: string;
  readonly displayName?: string;
  readonly platform: string;
  readonly architecture: string;
  readonly codexCliVersion?: string;
  readonly codexAuthMode: string;
  readonly supportedSandboxModes: readonly string[];
  readonly supportsNetwork: boolean;
  readonly supportsPatchCapture: boolean;
  readonly supportedTaskTypes: readonly string[];
  readonly maxOutputBytes: number;
  readonly registeredAt: string;
  readonly lastSeenAt: string;
};
type RunnerConfigurationSubscriptionView = {
  readonly projectId: string;
  readonly repository: ProjectDoc["repository"];
  readonly enabled: boolean;
  readonly taskTypeAllowlist: readonly string[];
  readonly maxSandbox: string;
  readonly allowNetwork: boolean;
  readonly allowPatches: boolean;
  readonly updatedAt: string;
};
type RunnerConfigurationView = {
  readonly runner: RunnerRegistrationView;
  readonly policy: VolunteerPolicy | null;
  readonly subscriptions: readonly RunnerConfigurationSubscriptionView[];
};
type TaskLeaseIndexDocument = Record<"taskRequestId" | "status", string> &
  Record<string, Value>;
type VolunteerProjectSubscriptionIndexDocument = Record<
  "volunteerUserId" | "projectId",
  string
> &
  Record<string, Value>;

const query = queryGeneric;
const mutation = mutationGeneric;

function requireIsoDateTime(value: string, fieldName: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${fieldName} must be an ISO date-time string`);
  }

  return value;
}

function optionalLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
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

async function contentHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "undefined";
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

async function requireAuthenticatedUser(
  ctx: QueryCtx | MutationCtx
): Promise<AuthenticatedUser> {
  const authUserId = await getAuthUserId(ctx);

  if (authUserId === null) {
    throw new Error("Authentication required");
  }

  const user = (await ctx.db.get(authUserId)) as StoredDoc | null;

  if (user === null || typeof user.userId !== "string") {
    throw new Error("Authenticated user record was not found");
  }

  return user as AuthenticatedUser;
}

async function projectById(
  ctx: QueryCtx | MutationCtx,
  projectId: string
): Promise<ProjectDoc | null> {
  return (await ctx.db
    .query("projects")
    .withIndex("by_project_id", (q) => q.eq("projectId", projectId))
    .unique()) as ProjectDoc | null;
}

async function volunteerPolicy(
  ctx: QueryCtx | MutationCtx,
  volunteerUserId: string
): Promise<VolunteerPolicy | null> {
  const doc = (await ctx.db
    .query("volunteerPolicies")
    .withIndex("by_volunteer", (q) => q.eq("volunteerUserId", volunteerUserId))
    .unique()) as StoredDoc | null;

  return doc === null ? null : parseVolunteerPolicy(withoutSystemFields(doc));
}

function projectView(project: ProjectDoc) {
  return {
    projectId: project.projectId,
    repository: project.repository,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

function subscriptionView(subscription: VolunteerSubscriptionRecord) {
  return {
    projectId: subscription.projectId,
    enabled: subscription.enabled,
    taskTypeAllowlist: subscription.taskTypeAllowlist,
    maxSandbox: subscription.maxSandbox,
    allowNetwork: subscription.allowNetwork,
    allowPatches: subscription.allowPatches,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt
  };
}

function runnerView(runner: StoredDoc): RunnerRegistrationView {
  const capability = withoutSystemFields(runner);
  delete capability.runnerAuthTokenHash;
  const parsed = parseRunnerCapability(capability);

  return {
    runnerId: parsed.runnerId,
    displayName: parsed.displayName,
    platform: parsed.platform,
    architecture: parsed.architecture,
    codexCliVersion: parsed.codexCliVersion,
    codexAuthMode: parsed.codexAuthMode,
    supportedSandboxModes: parsed.supportedSandboxModes,
    supportsNetwork: parsed.supportsNetwork,
    supportsPatchCapture: parsed.supportsPatchCapture,
    supportedTaskTypes: parsed.supportedTaskTypes,
    maxOutputBytes: parsed.maxOutputBytes,
    registeredAt: parsed.registeredAt,
    lastSeenAt: parsed.lastSeenAt
  };
}

async function runnerById(
  ctx: QueryCtx | MutationCtx,
  runnerId: string
): Promise<StoredDoc | null> {
  return (await ctx.db
    .query("runnerRegistrations")
    .withIndex("by_runner_id", (q) => q.eq("runnerId", runnerId))
    .unique()) as StoredDoc | null;
}

function requireRunnerAuth(runner: StoredDoc, runnerAuthTokenHash: string): void {
  assertRunnerAuthTokenHashMatches(
    typeof runner.runnerAuthTokenHash === "string"
      ? runner.runnerAuthTokenHash
      : undefined,
    runnerAuthTokenHash
  );
}

async function runnerConfigurationView(
  ctx: QueryCtx | MutationCtx,
  runner: StoredDoc
): Promise<RunnerConfigurationView> {
  const volunteerUserId = runner.volunteerUserId;

  if (typeof volunteerUserId !== "string") {
    throw new Error("Runner registration is missing a volunteer owner");
  }

  const subscriptions = (await ctx.db
    .query("volunteerProjectSubscriptions")
    .withIndex("by_volunteer", (q) => q.eq("volunteerUserId", volunteerUserId))
    .collect()) as VolunteerSubscriptionDoc[];
  const views: RunnerConfigurationSubscriptionView[] = [];

  for (const subscription of subscriptions) {
    const project = await projectById(ctx, subscription.projectId);

    if (project !== null) {
      views.push({
        projectId: subscription.projectId,
        repository: project.repository,
        enabled: subscription.enabled,
        taskTypeAllowlist: subscription.taskTypeAllowlist,
        maxSandbox: subscription.maxSandbox,
        allowNetwork: subscription.allowNetwork,
        allowPatches: subscription.allowPatches,
        updatedAt: subscription.updatedAt
      });
    }
  }

  return {
    runner: runnerView(runner),
    policy: await volunteerPolicy(ctx, volunteerUserId),
    subscriptions: views.sort((left, right) =>
      left.projectId.localeCompare(right.projectId)
    )
  };
}

async function requireRunnerByAuth(
  ctx: QueryCtx | MutationCtx,
  runnerId: string,
  runnerAuthTokenHash: string
): Promise<RunnerCapability> {
  const runnerDoc = await runnerById(ctx, runnerId);

  if (runnerDoc === null) {
    throw new Error(`Runner registration not found: ${runnerId}`);
  }

  requireRunnerAuth(runnerDoc, runnerAuthTokenHash);

  return parseRunnerCapability(withoutSystemFields(runnerDoc));
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

async function activeLeaseCountForTask(
  ctx: QueryCtx | MutationCtx,
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
  ctx: QueryCtx | MutationCtx,
  taskRequestId: string
): Promise<number> {
  const runs = (await ctx.db
    .query("runs")
    .withIndex("by_task", (q) => q.eq("taskRequestId", taskRequestId))
    .collect()) as StoredDoc[];

  return runs.length;
}

async function subscriptionForTask(
  ctx: QueryCtx | MutationCtx,
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

async function findLeaseableTask(
  ctx: QueryCtx | MutationCtx,
  runner: RunnerCapability,
  now: string,
  taskRequestId?: string
): Promise<TaskRequest | null> {
  const policy = await volunteerPolicy(ctx, runner.volunteerUserId);
  const candidates = taskRequestId
    ? [
        (await ctx.db
          .query("taskRequests")
          .withIndex("by_id", (q) => q.eq("id", taskRequestId))
          .unique()) as StoredDoc | null
      ].filter((task): task is StoredDoc => task !== null)
    : ((await ctx.db
        .query("taskRequests")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect()) as StoredDoc[]);

  for (const candidate of candidates) {
    const task = parseTaskRequest(withoutSystemFields(candidate));
    const project = await projectById(ctx, task.projectId);

    if (project === null || project.status !== "verified") {
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
          policy: policy ?? undefined
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

async function writeTerminalResult(
  ctx: MutationCtx,
  resultPackage: ResultPackage,
  now: string,
  runner: RunnerCapability
): Promise<ResultPackage> {
  const runDoc = (await ctx.db
    .query("runs")
    .withIndex("by_run_id", (q) => q.eq("runId", resultPackage.runId))
    .unique()) as StoredDoc | null;

  if (runDoc === null) {
    throw new Error(`Run not found: ${resultPackage.runId}`);
  }

  if (isTerminalRunStatus(runDoc.status as string)) {
    throw new Error(`Run is already terminal: ${String(runDoc.status)}`);
  }

  const leaseDoc = (await ctx.db
    .query("taskLeases")
    .withIndex("by_lease_id", (q) => q.eq("leaseId", resultPackage.leaseId))
    .unique()) as StoredDoc | null;

  if (leaseDoc === null) {
    throw new Error(`Lease not found: ${resultPackage.leaseId}`);
  }

  const lease = parseTaskLease(withoutSystemFields(leaseDoc));
  assertLeaseCanReceiveTerminalResult(lease, now, resultPackage.completedAt);

  if (
    lease.runnerId !== runner.runnerId ||
    lease.volunteerUserId !== runner.volunteerUserId
  ) {
    throw new Error("Lease does not belong to runner");
  }

  if (
    lease.runId !== resultPackage.runId ||
    lease.taskRequestId !== resultPackage.taskRequestId ||
    lease.projectId !== resultPackage.projectId
  ) {
    throw new Error("Result package does not match lease");
  }

  if (
    (resultPackage.runnerId !== undefined &&
      resultPackage.runnerId !== runner.runnerId) ||
    (resultPackage.volunteerUserId !== undefined &&
      resultPackage.volunteerUserId !== runner.volunteerUserId)
  ) {
    throw new Error("Result package identity does not match runner");
  }

  const existingResultPackage = (await ctx.db
    .query("resultPackages")
    .withIndex("by_result_package_id", (q) =>
      q.eq("resultPackageId", resultPackage.resultPackageId)
    )
    .unique()) as StoredDoc | null;

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
    actorUserId: runner.volunteerUserId,
    runnerId: resultPackage.runnerId,
    occurredAt: resultPackage.completedAt,
    metadata: { resultPackageId: resultPackage.resultPackageId }
  });

  return resultPackage;
}

function runnerTokenView(token: RunnerSetupTokenRecord) {
  return {
    tokenId: token.tokenId,
    label: token.label,
    status: token.status,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt
  };
}

export const dashboard = query({
  args: {},
  handler: async (ctx) => {
    const actor = await requireAuthenticatedUser(ctx);
    const projects = (await ctx.db
      .query("projects")
      .withIndex("by_status", (q) => q.eq("status", "verified"))
      .collect()) as ProjectDoc[];
    const subscriptions = (await ctx.db
      .query("volunteerProjectSubscriptions")
      .withIndex("by_volunteer", (q) => q.eq("volunteerUserId", actor.userId))
      .collect()) as VolunteerSubscriptionDoc[];
    const runners = (await ctx.db
      .query("runnerRegistrations")
      .withIndex("by_volunteer", (q) => q.eq("volunteerUserId", actor.userId))
      .collect()) as StoredDoc[];
    const runnerTokens = (await ctx.db
      .query("runnerSetupTokens")
      .withIndex("by_volunteer", (q) => q.eq("volunteerUserId", actor.userId))
      .collect()) as RunnerSetupTokenDoc[];

    return {
      projects: projects
        .map(projectView)
        .sort((left, right) =>
          left.repository.fullName.localeCompare(right.repository.fullName)
        ),
      subscriptions: subscriptions
        .map(subscriptionView)
        .sort((left, right) => left.projectId.localeCompare(right.projectId)),
      policy: await volunteerPolicy(ctx, actor.userId),
      runners: runners
        .map(runnerView)
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)),
      runnerTokens: runnerTokens
        .map(runnerTokenView)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    };
  }
});

export const savePolicy = mutation({
  args: {
    policy: v.any()
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
    const parsedPolicy = parseVolunteerPolicy({
      ...args.policy,
      volunteerUserId: actor.userId
    });
    const existing = (await ctx.db
      .query("volunteerPolicies")
      .withIndex("by_volunteer", (q) => q.eq("volunteerUserId", actor.userId))
      .unique()) as StoredDoc | null;

    if (existing === null) {
      await ctx.db.insert("volunteerPolicies", toConvexDocument(parsedPolicy));
    } else {
      await ctx.db.replace(existing._id, toConvexDocument(parsedPolicy));
    }

    return parsedPolicy;
  }
});

export const saveSubscription = mutation({
  args: {
    projectId: v.string(),
    enabled: v.boolean(),
    taskTypeAllowlist: v.array(v.string()),
    maxSandbox: v.string(),
    allowNetwork: v.boolean(),
    allowPatches: v.boolean(),
    now: v.string()
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
    const now = requireIsoDateTime(args.now, "now");
    const project = await projectById(ctx, args.projectId);

    if (project === null || project.status !== "verified") {
      throw new Error("Volunteers can only subscribe to verified projects");
    }

    const allowedTaskTypes = new Set<string>(taskTypes);
    const allowedSandboxModes = new Set<string>(sandboxModes);

    if (args.taskTypeAllowlist.length === 0) {
      throw new Error("Subscription must allow at least one task type");
    }

    if (!args.taskTypeAllowlist.every((taskType) => allowedTaskTypes.has(taskType))) {
      throw new Error("Subscription task type allowlist contains an unsupported value");
    }

    if (!allowedSandboxModes.has(args.maxSandbox)) {
      throw new Error("Subscription sandbox mode is unsupported");
    }

    const existingSubscriptions = (await ctx.db
      .query("volunteerProjectSubscriptions")
      .withIndex("by_volunteer", (q) => q.eq("volunteerUserId", actor.userId))
      .collect()) as VolunteerSubscriptionDoc[];
    const existing =
      existingSubscriptions.find(
        (subscription) => subscription.projectId === args.projectId
      ) ?? null;
    const subscription = {
      volunteerUserId: actor.userId,
      projectId: args.projectId,
      enabled: args.enabled,
      taskTypeAllowlist: args.taskTypeAllowlist,
      maxSandbox: args.maxSandbox,
      allowNetwork: args.allowNetwork,
      allowPatches: args.allowPatches,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    if (existing === null) {
      await ctx.db.insert("volunteerProjectSubscriptions", subscription);
    } else {
      await ctx.db.replace(existing._id, subscription);
    }

    return subscriptionView(subscription);
  }
});

export const createRunnerSetupToken = mutation({
  args: {
    tokenId: v.string(),
    tokenHash: v.string(),
    label: v.optional(v.string()),
    now: v.string(),
    expiresAt: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
    const now = requireIsoDateTime(args.now, "now");
    const expiresAt =
      args.expiresAt === undefined
        ? undefined
        : requireIsoDateTime(args.expiresAt, "expiresAt");

    const tokenHash = normalizeRunnerSetupTokenHash(args.tokenHash);

    if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(now)) {
      throw new Error("Runner setup token expiration must be after now");
    }

    const existing = (await ctx.db
      .query("runnerSetupTokens")
      .withIndex("by_token_id", (q) => q.eq("tokenId", args.tokenId))
      .unique()) as RunnerSetupTokenDoc | null;
    const existingHash = (await ctx.db
      .query("runnerSetupTokens")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique()) as RunnerSetupTokenDoc | null;

    if (existing !== null) {
      throw new Error(`Runner setup token already exists: ${args.tokenId}`);
    }

    if (existingHash !== null) {
      throw new Error("Runner setup token hash already exists");
    }

    const token = {
      tokenId: args.tokenId,
      volunteerUserId: actor.userId,
      tokenHash,
      label: optionalLabel(args.label),
      status: "active",
      createdAt: now,
      expiresAt
    };

    await ctx.db.insert("runnerSetupTokens", token);

    return runnerTokenView(token);
  }
});

export const revokeRunnerSetupToken = mutation({
  args: {
    tokenId: v.string(),
    now: v.string()
  },
  handler: async (ctx, args) => {
    const actor = await requireAuthenticatedUser(ctx);
    const now = requireIsoDateTime(args.now, "now");
    const token = (await ctx.db
      .query("runnerSetupTokens")
      .withIndex("by_token_id", (q) => q.eq("tokenId", args.tokenId))
      .unique()) as RunnerSetupTokenDoc | null;

    if (token === null) {
      throw new Error(`Runner setup token not found: ${args.tokenId}`);
    }

    if (token.volunteerUserId !== actor.userId) {
      throw new Error("Runner setup token does not belong to authenticated user");
    }

    if (token.status === "revoked") {
      return runnerTokenView(token);
    }

    const revoked = {
      ...token,
      status: "revoked",
      revokedAt: now
    };

    await ctx.db.patch(token._id, {
      status: revoked.status,
      revokedAt: revoked.revokedAt
    });

    return runnerTokenView(revoked);
  }
});

export const exchangeRunnerSetupToken = mutation({
  args: {
    tokenHash: v.string(),
    runnerAuthTokenHash: v.string(),
    runner: v.any(),
    now: v.string()
  },
  handler: async (ctx, args): Promise<RunnerRegistrationView> => {
    const now = requireIsoDateTime(args.now, "now");
    const tokenHash = normalizeRunnerSetupTokenHash(args.tokenHash);
    const runnerAuthTokenHash = normalizeRunnerAuthTokenHash(args.runnerAuthTokenHash);
    const token = (await ctx.db
      .query("runnerSetupTokens")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique()) as RunnerSetupTokenDoc | null;

    if (token === null) {
      throw new Error("Runner setup token was not found");
    }

    assertRunnerSetupTokenCanBeExchanged(token, now);

    const runner = parseRunnerCapability({
      ...args.runner,
      volunteerUserId: token.volunteerUserId
    });
    const existingRunner = (await ctx.db
      .query("runnerRegistrations")
      .withIndex("by_runner_id", (q) => q.eq("runnerId", runner.runnerId))
      .unique()) as StoredDoc | null;

    if (
      existingRunner !== null &&
      existingRunner.volunteerUserId !== token.volunteerUserId
    ) {
      throw new Error("Runner is already registered to another volunteer");
    }

    if (existingRunner === null) {
      await ctx.db.insert("runnerRegistrations", {
        ...toConvexDocument(runner),
        runnerAuthTokenHash
      });
    } else {
      await ctx.db.replace(existingRunner._id, {
        ...toConvexDocument(runner),
        runnerAuthTokenHash
      });
    }

    await ctx.db.patch(token._id, {
      status: "used",
      lastUsedAt: now
    });

    return runnerView({
      ...toConvexDocument(runner),
      runnerAuthTokenHash,
      _id: existingRunner?._id ?? token._id
    } as StoredDoc);
  }
});

export const heartbeatRunner = mutation({
  args: {
    runnerId: v.string(),
    runnerAuthTokenHash: v.string(),
    runner: v.any(),
    now: v.string()
  },
  handler: async (ctx, args): Promise<RunnerRegistrationView> => {
    const now = requireIsoDateTime(args.now, "now");
    const existingRunner = await runnerById(ctx, args.runnerId);

    if (existingRunner === null) {
      throw new Error(`Runner registration not found: ${args.runnerId}`);
    }

    requireRunnerAuth(existingRunner, args.runnerAuthTokenHash);

    if (typeof existingRunner.volunteerUserId !== "string") {
      throw new Error("Runner registration is missing a volunteer owner");
    }

    const runner = parseRunnerCapability({
      ...args.runner,
      runnerId: existingRunner.runnerId,
      volunteerUserId: existingRunner.volunteerUserId,
      registeredAt: existingRunner.registeredAt,
      lastSeenAt: now
    });
    const runnerAuthTokenHash = normalizeRunnerAuthTokenHash(
      args.runnerAuthTokenHash
    );

    await ctx.db.replace(existingRunner._id, {
      ...toConvexDocument(runner),
      runnerAuthTokenHash
    });

    return runnerView({
      ...toConvexDocument(runner),
      runnerAuthTokenHash,
      _id: existingRunner._id
    } as StoredDoc);
  }
});

export const runnerConfiguration = query({
  args: {
    runnerId: v.string(),
    runnerAuthTokenHash: v.string()
  },
  handler: async (ctx, args): Promise<RunnerConfigurationView> => {
    const runner = await runnerById(ctx, args.runnerId);

    if (runner === null) {
      throw new Error(`Runner registration not found: ${args.runnerId}`);
    }

    requireRunnerAuth(runner, args.runnerAuthTokenHash);

    return await runnerConfigurationView(ctx, runner);
  }
});

export const eligibleTask = query({
  args: {
    runnerId: v.string(),
    runnerAuthTokenHash: v.string(),
    now: v.string(),
    taskRequestId: v.optional(v.string())
  },
  handler: async (ctx, args): Promise<TaskRequest | null> => {
    const now = requireIsoDateTime(args.now, "now");
    const runner = await requireRunnerByAuth(
      ctx,
      args.runnerId,
      args.runnerAuthTokenHash
    );

    return await findLeaseableTask(ctx, runner, now, args.taskRequestId);
  }
});

export const leaseEligibleTask = mutation({
  args: {
    runnerId: v.string(),
    runnerAuthTokenHash: v.string(),
    leaseId: v.string(),
    runId: v.string(),
    leaseTokenHash: v.string(),
    now: v.string(),
    expiresAt: v.string(),
    taskRequestId: v.optional(v.string())
  },
  handler: async (ctx, args): Promise<{
    readonly task: TaskRequest;
    readonly lease: TaskLease;
  } | null> => {
    const now = requireIsoDateTime(args.now, "now");
    requireIsoDateTime(args.expiresAt, "expiresAt");

    if (Date.parse(args.expiresAt) <= Date.parse(now)) {
      throw new Error("Lease expiration must be after now");
    }

    const runner = await requireRunnerByAuth(
      ctx,
      args.runnerId,
      args.runnerAuthTokenHash
    );
    const existingLease = (await ctx.db
      .query("taskLeases")
      .withIndex("by_lease_id", (q) => q.eq("leaseId", args.leaseId))
      .unique()) as StoredDoc | null;
    const existingRun = (await ctx.db
      .query("runs")
      .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
      .unique()) as StoredDoc | null;

    if (existingLease !== null || existingRun !== null) {
      throw new Error("Lease or run id already exists");
    }

    const task = await findLeaseableTask(ctx, runner, now, args.taskRequestId);

    if (task === null) {
      return null;
    }

    const attempt = (await runCountForTask(ctx, task.id)) + 1;
    const taskSnapshotHash = await contentHash(stableStringify(task));
    const lease = parseTaskLease({
      leaseId: args.leaseId,
      runId: args.runId,
      taskRequestId: task.id,
      projectId: task.projectId,
      runnerId: runner.runnerId,
      volunteerUserId: runner.volunteerUserId,
      status: "active",
      attempt,
      taskSnapshotHash,
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
      taskSnapshotHash,
      startedAt: now,
      createdAt: now,
      updatedAt: now
    });
    await ctx.db.insert("taskLeases", toConvexDocument(lease));
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

export const completeRun = mutation({
  args: {
    runnerId: v.string(),
    runnerAuthTokenHash: v.string(),
    resultPackage: v.any(),
    now: v.string()
  },
  handler: async (ctx, args): Promise<ResultPackage> => {
    const now = requireIsoDateTime(args.now, "now");
    const runner = await requireRunnerByAuth(
      ctx,
      args.runnerId,
      args.runnerAuthTokenHash
    );
    const resultPackage = parseResultPackage(args.resultPackage);
    assertTerminalResultPackage(resultPackage, "completed");

    return await writeTerminalResult(ctx, resultPackage, now, runner);
  }
});

export const failRun = mutation({
  args: {
    runnerId: v.string(),
    runnerAuthTokenHash: v.string(),
    resultPackage: v.any(),
    now: v.string()
  },
  handler: async (ctx, args): Promise<ResultPackage> => {
    const now = requireIsoDateTime(args.now, "now");
    const runner = await requireRunnerByAuth(
      ctx,
      args.runnerId,
      args.runnerAuthTokenHash
    );
    const resultPackage = parseResultPackage(args.resultPackage);
    assertTerminalResultPackage(resultPackage, "failed");

    return await writeTerminalResult(ctx, resultPackage, now, runner);
  }
});
