import { getAuthUserId } from "@convex-dev/auth/server";
import {
  parseRunnerCapability,
  parseVolunteerPolicy,
  sandboxModes,
  taskTypes,
  type VolunteerPolicy
} from "@oss-capacity/core";
import {
  mutationGeneric,
  queryGeneric,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx
} from "convex/server";
import { v, type GenericId, type Value } from "convex/values";

import {
  assertRunnerSetupTokenCanBeExchanged,
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
  const parsed = parseRunnerCapability(withoutSystemFields(runner));

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
    runner: v.any(),
    now: v.string()
  },
  handler: async (ctx, args): Promise<RunnerRegistrationView> => {
    const now = requireIsoDateTime(args.now, "now");
    const tokenHash = normalizeRunnerSetupTokenHash(args.tokenHash);
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
      await ctx.db.insert("runnerRegistrations", toConvexDocument(runner));
    } else {
      await ctx.db.replace(existingRunner._id, toConvexDocument(runner));
    }

    await ctx.db.patch(token._id, {
      status: "used",
      lastUsedAt: now
    });

    return runnerView({
      ...toConvexDocument(runner),
      _id: existingRunner?._id ?? token._id
    } as StoredDoc);
  }
});
