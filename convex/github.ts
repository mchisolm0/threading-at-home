import { getAuthUserId } from "@convex-dev/auth/server";
import {
  buildGitHubIssueCommentRequest,
  buildGitHubIssueRequest,
  createGitHubAppJwt,
  hasRepositoryMaintainerPermission,
  normalizeRepositoryFullName,
  parseGitHubCreatedIssue,
  parseGitHubCreatedIssueComment,
  parseGitHubRepositoryPermission,
  repositoryOwnerAndName,
  type GitHubInstallationSync
} from "@oss-capacity/github";
import {
  buildGitHubPromotionPreview,
  normalizeGitHubPromotionTarget,
  parseResultPackage,
  parseTaskRequest,
  type GitHubPromotionPreview,
  type GitHubPromotionTarget,
  type ResultPackage,
  type TaskRequest
} from "@oss-capacity/core";
import {
  actionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  type IndexRangeBuilder,
  makeFunctionReference,
  queryGeneric,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx
} from "convex/server";
import { v, type GenericId, type Value } from "convex/values";

type QueryCtx = GenericQueryCtx<GenericDataModel>;
type MutationCtx = GenericMutationCtx<GenericDataModel>;
type StoredDoc = {
  readonly _id: GenericId<string>;
  readonly [key: string]: Value;
};
type AuthenticatedGithubUser = StoredDoc & {
  readonly userId: string;
  readonly githubLogin: string;
  readonly githubUserId: string;
};
type GithubInstallationDoc = StoredDoc & {
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly installedByUserId?: string;
  readonly repositoryFullNames: string[];
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};
type GithubInstallationUserStatusIndexDocument = Record<
  "installedByUserId" | "status",
  string
> &
  Record<string, Value>;
type ProjectDoc = StoredDoc & {
  readonly projectId: string;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly fullName: string;
    readonly defaultBranch?: string;
  };
  readonly createdByUserId: string;
  readonly githubInstallationId?: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};
type RegistrationContext = {
  readonly user: {
    readonly userId: string;
    readonly githubLogin: string;
    readonly githubUserId: string;
  };
  readonly installation: {
    readonly installationId: string;
    readonly accountLogin: string;
    readonly accountType: string;
    readonly repositoryFullNames: readonly string[];
    readonly status: string;
  };
};
type GitHubRepositoryApiResponse = {
  readonly full_name?: unknown;
  readonly name?: unknown;
  readonly default_branch?: unknown;
  readonly owner?: {
    readonly login?: unknown;
  };
};
type GitHubInstallationTokenResponse = {
  readonly token?: unknown;
};
type GitHubUserApiResponse = {
  readonly login?: unknown;
};
type PromotionContext = {
  readonly actorUserId: string;
  readonly actorGithubUserId: string;
  readonly project: ProjectView;
  readonly installationId: string;
  readonly task: TaskRequest;
  readonly resultPackage: ResultPackage;
  readonly visibleRunnerId?: string;
};
type PromotionRecordView = {
  readonly promotionId: string;
  readonly resultPackageId: string;
  readonly projectId: string;
  readonly taskRequestId: string;
  readonly runId: string;
  readonly targetKind: string;
  readonly targetRepositoryFullName: string;
  readonly targetIssueNumber?: number;
  readonly targetIssueTitle?: string;
  readonly attributionMode: string;
  readonly previewTitle?: string;
  readonly previewBody: string;
  readonly status: string;
  readonly targetUrl?: string;
  readonly targetGitHubId?: string;
  readonly errorSummary?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly postedAt?: string;
};
type PromotionResult = {
  readonly promotion: PromotionRecordView;
  readonly preview: GitHubPromotionPreview;
};

const query = queryGeneric;
const internalQuery = internalQueryGeneric;
const internalMutation = internalMutationGeneric;

const registrationContextRef = makeFunctionReference<
  "query",
  { repositoryFullName: string },
  RegistrationContext
>("github:registrationContext");
const registerVerifiedProjectRef = makeFunctionReference<
  "mutation",
  {
    repositoryFullName: string;
    canonicalFullName: string;
    defaultBranch?: string;
    actorUserId: string;
    installationId: string;
  },
  ProjectView
>("github:registerVerifiedProject");
const promotionContextRef = makeFunctionReference<
  "query",
  { resultPackageId: string },
  PromotionContext
>("github:promotionContext");
const recordPromotionAttemptRef = makeFunctionReference<
  "mutation",
  {
    preview: GitHubPromotionPreview;
    actorUserId: string;
    attributionMode: string;
    target: GitHubPromotionTarget;
    now: string;
  },
  PromotionRecordView
>("github:recordPromotionAttempt");
const recordPromotionPostedRef = makeFunctionReference<
  "mutation",
  {
    promotionId: string;
    targetUrl: string;
    targetGitHubId: string;
    targetIssueNumber?: number;
    now: string;
  },
  PromotionRecordView
>("github:recordPromotionPosted");
const recordPromotionFailedRef = makeFunctionReference<
  "mutation",
  {
    promotionId: string;
    errorSummary: string;
    now: string;
  },
  PromotionRecordView
>("github:recordPromotionFailed");

type ProjectView = {
  readonly projectId: string;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly fullName: string;
    readonly defaultBranch?: string;
  };
  readonly githubInstallationId?: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

function isoNow(): string {
  return new Date(Date.now()).toISOString();
}

function stringFromEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required Convex environment variable: ${name}`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function repositoryKey(fullName: string): string {
  return normalizeRepositoryFullName(fullName).toLowerCase();
}

function hasRepository(
  installation: Pick<GithubInstallationDoc, "repositoryFullNames">,
  repositoryFullName: string
): boolean {
  const key = repositoryKey(repositoryFullName);

  return installation.repositoryFullNames.some((fullName) => repositoryKey(fullName) === key);
}

function mergeRepositories(
  current: readonly string[],
  added: readonly string[],
  removed: readonly string[]
): string[] {
  const removedKeys = new Set(removed.map(repositoryKey));
  const repositories = new Map<string, string>();

  for (const fullName of [...current, ...added]) {
    const key = repositoryKey(fullName);

    if (!removedKeys.has(key)) {
      repositories.set(key, normalizeRepositoryFullName(fullName));
    }
  }

  return [...repositories.values()].sort((left, right) => left.localeCompare(right));
}

function projectView(project: ProjectDoc): ProjectView {
  return {
    projectId: project.projectId,
    repository: project.repository,
    githubInstallationId: project.githubInstallationId,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
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

function promotionRecordView(record: StoredDoc): PromotionRecordView {
  return {
    promotionId: String(record.promotionId),
    resultPackageId: String(record.resultPackageId),
    projectId: String(record.projectId),
    taskRequestId: String(record.taskRequestId),
    runId: String(record.runId),
    targetKind: String(record.targetKind),
    targetRepositoryFullName: String(record.targetRepositoryFullName),
    targetIssueNumber:
      typeof record.targetIssueNumber === "number"
        ? record.targetIssueNumber
        : undefined,
    targetIssueTitle:
      typeof record.targetIssueTitle === "string"
        ? record.targetIssueTitle
        : undefined,
    attributionMode: String(record.attributionMode),
    previewTitle:
      typeof record.previewTitle === "string" ? record.previewTitle : undefined,
    previewBody: String(record.previewBody),
    status: String(record.status),
    targetUrl: typeof record.targetUrl === "string" ? record.targetUrl : undefined,
    targetGitHubId:
      typeof record.targetGitHubId === "string" ? record.targetGitHubId : undefined,
    errorSummary:
      typeof record.errorSummary === "string" ? record.errorSummary : undefined,
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
    postedAt: typeof record.postedAt === "string" ? record.postedAt : undefined
  };
}

async function requireAuthenticatedGithubUser(
  ctx: QueryCtx | MutationCtx
): Promise<AuthenticatedGithubUser> {
  const authUserId = await getAuthUserId(ctx);

  if (authUserId === null) {
    throw new Error("Authentication required");
  }

  const user = (await ctx.db.get(authUserId)) as StoredDoc | null;

  if (
    user === null ||
    typeof user.userId !== "string" ||
    typeof user.githubLogin !== "string" ||
    typeof user.githubUserId !== "string"
  ) {
    throw new Error("Authenticated GitHub user record was not found");
  }

  return user as AuthenticatedGithubUser;
}

async function userIdForGithubUserId(
  ctx: MutationCtx,
  githubUserId: string | undefined
): Promise<string | undefined> {
  if (githubUserId === undefined) {
    return undefined;
  }

  const user = (await ctx.db
    .query("users")
    .withIndex("by_github_user_id", (q) => q.eq("githubUserId", githubUserId))
    .unique()) as StoredDoc | null;

  return typeof user?.userId === "string" ? user.userId : undefined;
}

async function installationById(
  ctx: QueryCtx | MutationCtx,
  installationId: string
): Promise<GithubInstallationDoc | null> {
  return (await ctx.db
    .query("githubInstallations")
    .withIndex("by_installation_id", (q) =>
      q.eq("installationId", installationId)
    )
    .unique()) as GithubInstallationDoc | null;
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

async function taskById(
  ctx: QueryCtx | MutationCtx,
  taskRequestId: string
): Promise<StoredDoc | null> {
  return (await ctx.db
    .query("taskRequests")
    .withIndex("by_id", (q) => q.eq("id", taskRequestId))
    .unique()) as StoredDoc | null;
}

async function resultPackageById(
  ctx: QueryCtx | MutationCtx,
  resultPackageId: string
): Promise<StoredDoc | null> {
  return (await ctx.db
    .query("resultPackages")
    .withIndex("by_result_package_id", (q) =>
      q.eq("resultPackageId", resultPackageId)
    )
    .unique()) as StoredDoc | null;
}

async function promotionById(
  ctx: QueryCtx | MutationCtx,
  promotionId: string
): Promise<StoredDoc | null> {
  return (await ctx.db
    .query("resultPromotions")
    .withIndex("by_promotion_id", (q) => q.eq("promotionId", promotionId))
    .unique()) as StoredDoc | null;
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
    readonly actorUserId?: string;
    readonly metadata?: unknown;
  }
): Promise<void> {
  await ctx.db.insert("auditEvents", toConvexDocument(event));
}

async function requestGitHubJson<T>(
  url: string,
  init: RequestInit & { readonly token: string }
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${init.token}`,
      "x-github-api-version": "2022-11-28",
      ...init.headers
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API request failed (${response.status} ${response.statusText}): ${body.slice(0, 500)}`
    );
  }

  return (await response.json()) as T;
}

async function createInstallationAccessToken(
  installationId: string
): Promise<string> {
  const appId = stringFromEnv("GITHUB_APP_ID");
  const privateKeyPem = stringFromEnv("GITHUB_APP_PRIVATE_KEY");
  const jwt = await createGitHubAppJwt({ appId, privateKeyPem });
  const response = await requestGitHubJson<GitHubInstallationTokenResponse>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      token: jwt
    }
  );
  const token = optionalString(response.token);

  if (token === undefined) {
    throw new Error("GitHub installation token response did not include a token");
  }

  return token;
}

async function verifyRepositoryPermission(input: {
  readonly repositoryFullName: string;
  readonly viewerGithubUserId: string;
  readonly installationId: string;
}): Promise<{
  readonly canonicalFullName: string;
  readonly defaultBranch?: string;
}> {
  const installationToken = await createInstallationAccessToken(input.installationId);
  const repository = repositoryOwnerAndName(input.repositoryFullName);
  const repositoryResponse = await requestGitHubJson<GitHubRepositoryApiResponse>(
    `https://api.github.com/repos/${repository.owner}/${repository.name}`,
    {
      method: "GET",
      token: installationToken
    }
  );
  const canonicalFullName =
    optionalString(repositoryResponse.full_name) ?? repository.fullName;
  const ownerLogin = optionalString(repositoryResponse.owner?.login) ?? repository.owner;
  const userResponse = await requestGitHubJson<GitHubUserApiResponse>(
    `https://api.github.com/user/${input.viewerGithubUserId}`,
    {
      method: "GET",
      token: installationToken
    }
  );
  const currentViewerLogin = optionalString(userResponse.login);

  if (currentViewerLogin === undefined) {
    throw new Error("GitHub user lookup did not include a login");
  }

  const permissionResponse = await requestGitHubJson<unknown>(
    `https://api.github.com/repos/${repository.owner}/${repository.name}/collaborators/${currentViewerLogin}/permission`,
    {
      method: "GET",
      token: installationToken
    }
  );
  const permission = parseGitHubRepositoryPermission(
    permissionResponse as Parameters<typeof parseGitHubRepositoryPermission>[0]
  );

  if (
    !hasRepositoryMaintainerPermission({
      viewerLogin: currentViewerLogin,
      repositoryOwnerLogin: ownerLogin,
      permission: permission.permission,
      roleName: permission.roleName
    })
  ) {
    throw new Error(
      "GitHub user must be the repository owner or have admin/maintain permission"
    );
  }

  return {
    canonicalFullName: normalizeRepositoryFullName(canonicalFullName),
    defaultBranch: optionalString(repositoryResponse.default_branch)
  };
}

async function requirePromotionContext(
  ctx: QueryCtx,
  resultPackageId: string
): Promise<PromotionContext> {
  const actor = await requireAuthenticatedGithubUser(ctx);
  const resultDoc = await resultPackageById(ctx, resultPackageId);

  if (resultDoc === null) {
    throw new Error(`Result package not found: ${resultPackageId}`);
  }

  const resultPackage = parseResultPackage(withoutSystemFields(resultDoc));
  const [project, taskDoc] = await Promise.all([
    projectById(ctx, resultPackage.projectId),
    taskById(ctx, resultPackage.taskRequestId)
  ]);

  if (
    project === null ||
    project.createdByUserId !== actor.userId ||
    project.status !== "verified"
  ) {
    throw new Error("Only the verified project maintainer can promote this result");
  }

  if (typeof project.githubInstallationId !== "string") {
    throw new Error("Verified project is missing a GitHub App installation");
  }

  const installation = await installationById(ctx, project.githubInstallationId);

  if (
    installation === null ||
    installation.status !== "active" ||
    !hasRepository(installation, project.repository.fullName)
  ) {
    throw new Error("GitHub App installation is not active for this project");
  }

  if (taskDoc === null) {
    throw new Error(`Task request not found: ${resultPackage.taskRequestId}`);
  }

  const task = parseTaskRequest(withoutSystemFields(taskDoc));

  if (
    task.createdByUserId !== actor.userId ||
    task.projectId !== resultPackage.projectId
  ) {
    throw new Error("Only the task maintainer can promote this result");
  }

  return {
    actorUserId: actor.userId,
    actorGithubUserId: actor.githubUserId,
    project: projectView(project),
    installationId: project.githubInstallationId,
    task,
    resultPackage,
    visibleRunnerId:
      resultPackage.volunteerVisibility === "anonymous"
        ? undefined
        : resultPackage.runnerId
  };
}

export const myProjects = query({
  args: {},
  handler: async (ctx) => {
    const actor = await requireAuthenticatedGithubUser(ctx);
    const projects = (await ctx.db
      .query("projects")
      .withIndex("by_created_by", (q) => q.eq("createdByUserId", actor.userId))
      .collect()) as ProjectDoc[];

    return projects
      .map(projectView)
      .sort((left, right) => left.projectId.localeCompare(right.projectId));
  }
});

export const availableInstallations = query({
  args: {},
  handler: async (ctx) => {
    const actor = await requireAuthenticatedGithubUser(ctx);

    const installations = (await ctx.db
      .query("githubInstallations")
      .withIndex("by_installed_user_status", (q) => {
        const range = q as unknown as IndexRangeBuilder<
          GithubInstallationUserStatusIndexDocument,
          ["installedByUserId", "status"]
        >;

        return range.eq("installedByUserId", actor.userId).eq("status", "active");
      })
      .collect()) as GithubInstallationDoc[];

    return installations
      .map((installation) => ({
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositoryFullNames: installation.repositoryFullNames,
        status: installation.status,
        updatedAt: installation.updatedAt
      }))
      .sort((left, right) => left.accountLogin.localeCompare(right.accountLogin));
  }
});

export const registrationContext = internalQuery({
  args: {
    repositoryFullName: v.string()
  },
  handler: async (ctx, args): Promise<RegistrationContext> => {
    const actor = await requireAuthenticatedGithubUser(ctx);
    const repositoryFullName = normalizeRepositoryFullName(args.repositoryFullName);
    const installations = (await ctx.db
      .query("githubInstallations")
      .collect()) as GithubInstallationDoc[];
    const installation = installations.find(
      (candidate) =>
        candidate.status === "active" &&
        hasRepository(candidate, repositoryFullName)
    );

    if (installation === undefined) {
      throw new Error(
        "GitHub App installation for this repository was not found. Install or update the GitHub App first."
      );
    }

    return {
      user: {
        userId: actor.userId,
        githubLogin: actor.githubLogin,
        githubUserId: actor.githubUserId
      },
      installation: {
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositoryFullNames: installation.repositoryFullNames,
        status: installation.status
      }
    };
  }
});

export const registerProject = actionGeneric({
  args: {
    repositoryFullName: v.string()
  },
  handler: async (ctx, args): Promise<ProjectView> => {
    const repositoryFullName = normalizeRepositoryFullName(args.repositoryFullName);
    const context = await ctx.runQuery(registrationContextRef, {
      repositoryFullName
    });
    const verified = await verifyRepositoryPermission({
      repositoryFullName,
      viewerGithubUserId: context.user.githubUserId,
      installationId: context.installation.installationId
    });

    return await ctx.runMutation(registerVerifiedProjectRef, {
      repositoryFullName,
      canonicalFullName: verified.canonicalFullName,
      defaultBranch: verified.defaultBranch,
      actorUserId: context.user.userId,
      installationId: context.installation.installationId
    });
  }
});

export const registerVerifiedProject = internalMutation({
  args: {
    repositoryFullName: v.string(),
    canonicalFullName: v.string(),
    defaultBranch: v.optional(v.string()),
    actorUserId: v.string(),
    installationId: v.string()
  },
  handler: async (ctx, args): Promise<ProjectView> => {
    const now = isoNow();
    const repository = repositoryOwnerAndName(args.canonicalFullName);
    const installation = await installationById(ctx, args.installationId);

    if (
      installation === null ||
      installation.status !== "active" ||
      !hasRepository(installation, args.repositoryFullName)
    ) {
      throw new Error("GitHub App installation is no longer active for this repository");
    }

    const project = await projectById(ctx, repository.fullName);
    const projectDocument = {
      projectId: repository.fullName,
      repository: {
        owner: repository.owner,
        name: repository.name,
        fullName: repository.fullName,
        defaultBranch: args.defaultBranch
      },
      createdByUserId: args.actorUserId,
      githubInstallationId: args.installationId,
      status: "verified",
      updatedAt: now
    };

    if (project === null) {
      await ctx.db.insert("projects", {
        ...projectDocument,
        createdAt: now
      });
    } else {
      if (project.createdByUserId !== args.actorUserId) {
        throw new Error("Project is already registered by another user");
      }

      await ctx.db.patch(project._id, projectDocument);
    }

    await insertAuditEvent(ctx, {
      eventType: project === null ? "project.registered" : "project.verified",
      entityType: "project",
      entityId: repository.fullName,
      projectId: repository.fullName,
      actorUserId: args.actorUserId,
      occurredAt: now,
      metadata: {
        githubInstallationId: args.installationId
      }
    });

    return {
      ...projectDocument,
      createdAt: project?.createdAt ?? now
    };
  }
});

const promotionTargetArg = v.union(
  v.object({
    kind: v.literal("issue_comment"),
    issueNumber: v.number()
  }),
  v.object({
    kind: v.literal("new_issue"),
    title: v.string()
  }),
  v.object({
    kind: v.literal("patch_pull_request"),
    disabledReason: v.string()
  })
);
const promotionAttributionArg = v.union(
  v.literal("app"),
  v.literal("app_with_anonymous_run")
);

export const promotionContext = internalQuery({
  args: {
    resultPackageId: v.string()
  },
  handler: async (ctx, args): Promise<PromotionContext> => {
    return await requirePromotionContext(ctx, args.resultPackageId);
  }
});

export const previewResultPromotion = query({
  args: {
    resultPackageId: v.string(),
    target: promotionTargetArg,
    attributionMode: promotionAttributionArg
  },
  handler: async (ctx, args): Promise<GitHubPromotionPreview> => {
    const context = await requirePromotionContext(ctx, args.resultPackageId);

    return buildGitHubPromotionPreview({
      repositoryFullName: context.project.repository.fullName,
      task: context.task,
      resultPackage: context.resultPackage,
      target: args.target,
      attributionMode: args.attributionMode,
      visibleRunnerId: context.visibleRunnerId
    });
  }
});

export const recordPromotionAttempt = internalMutation({
  args: {
    preview: v.any(),
    actorUserId: v.string(),
    attributionMode: v.string(),
    target: promotionTargetArg,
    now: v.string()
  },
  handler: async (ctx, args): Promise<PromotionRecordView> => {
    const normalizedTarget = normalizeGitHubPromotionTarget(args.target);
    const promotionId = `${args.preview.source.resultPackageId}:${Date.now()}:${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const record = {
      promotionId,
      resultPackageId: args.preview.source.resultPackageId,
      projectId: args.preview.source.projectId,
      taskRequestId: args.preview.source.taskRequestId,
      runId: args.preview.source.runId,
      actorUserId: args.actorUserId,
      targetKind: args.preview.targetKind,
      targetRepositoryFullName: args.preview.targetRepository,
      targetIssueNumber:
        normalizedTarget.kind === "issue_comment"
          ? normalizedTarget.issueNumber
          : undefined,
      targetIssueTitle:
        normalizedTarget.kind === "new_issue" ? normalizedTarget.title : undefined,
      attributionMode: args.attributionMode,
      previewTitle: args.preview.title,
      previewBody: args.preview.body,
      status: "posting",
      createdAt: args.now,
      updatedAt: args.now
    };

    await ctx.db.insert("resultPromotions", toConvexDocument(record));
    await insertAuditEvent(ctx, {
      eventType: "result_promotion.requested",
      entityType: "resultPromotion",
      entityId: promotionId,
      projectId: record.projectId,
      taskRequestId: record.taskRequestId,
      runId: record.runId,
      actorUserId: args.actorUserId,
      occurredAt: args.now,
      metadata: {
        resultPackageId: record.resultPackageId,
        targetKind: record.targetKind,
        targetRepositoryFullName: record.targetRepositoryFullName,
        targetIssueNumber: record.targetIssueNumber,
        targetIssueTitle: record.targetIssueTitle,
        attributionMode: args.attributionMode
      }
    });

    return promotionRecordView(record as unknown as StoredDoc);
  }
});

export const recordPromotionPosted = internalMutation({
  args: {
    promotionId: v.string(),
    targetUrl: v.string(),
    targetGitHubId: v.string(),
    targetIssueNumber: v.optional(v.number()),
    now: v.string()
  },
  handler: async (ctx, args): Promise<PromotionRecordView> => {
    const record = await promotionById(ctx, args.promotionId);

    if (record === null) {
      throw new Error(`Promotion record not found: ${args.promotionId}`);
    }

    await ctx.db.patch(record._id, {
      status: "posted",
      targetUrl: args.targetUrl,
      targetGitHubId: args.targetGitHubId,
      targetIssueNumber: args.targetIssueNumber ?? record.targetIssueNumber,
      updatedAt: args.now,
      postedAt: args.now
    });

    const updated = (await promotionById(ctx, args.promotionId)) as StoredDoc;

    await insertAuditEvent(ctx, {
      eventType: "result_promotion.posted",
      entityType: "resultPromotion",
      entityId: args.promotionId,
      projectId: String(updated.projectId),
      taskRequestId: String(updated.taskRequestId),
      runId: String(updated.runId),
      actorUserId: String(updated.actorUserId),
      occurredAt: args.now,
      metadata: {
        resultPackageId: updated.resultPackageId,
        targetKind: updated.targetKind,
        targetRepositoryFullName: updated.targetRepositoryFullName,
        targetUrl: args.targetUrl,
        targetGitHubId: args.targetGitHubId
      }
    });

    return promotionRecordView(updated);
  }
});

export const recordPromotionFailed = internalMutation({
  args: {
    promotionId: v.string(),
    errorSummary: v.string(),
    now: v.string()
  },
  handler: async (ctx, args): Promise<PromotionRecordView> => {
    const record = await promotionById(ctx, args.promotionId);

    if (record === null) {
      throw new Error(`Promotion record not found: ${args.promotionId}`);
    }

    await ctx.db.patch(record._id, {
      status: "failed",
      errorSummary: args.errorSummary.slice(0, 500),
      updatedAt: args.now
    });

    const updated = (await promotionById(ctx, args.promotionId)) as StoredDoc;

    await insertAuditEvent(ctx, {
      eventType: "result_promotion.failed",
      entityType: "resultPromotion",
      entityId: args.promotionId,
      projectId: String(updated.projectId),
      taskRequestId: String(updated.taskRequestId),
      runId: String(updated.runId),
      actorUserId: String(updated.actorUserId),
      occurredAt: args.now,
      metadata: {
        resultPackageId: updated.resultPackageId,
        targetKind: updated.targetKind,
        targetRepositoryFullName: updated.targetRepositoryFullName,
        errorSummary: args.errorSummary.slice(0, 500)
      }
    });

    return promotionRecordView(updated);
  }
});

export const promoteResultToGitHub = actionGeneric({
  args: {
    resultPackageId: v.string(),
    target: promotionTargetArg,
    attributionMode: promotionAttributionArg,
    confirmedPreviewTitle: v.optional(v.string()),
    confirmedPreviewBody: v.string()
  },
  handler: async (ctx, args): Promise<PromotionResult> => {
    const target = normalizeGitHubPromotionTarget(args.target);

    if (target.kind === "patch_pull_request") {
      throw new Error("Patch pull request promotion is reserved for Task 7.2");
    }

    const context = await ctx.runQuery(promotionContextRef, {
      resultPackageId: args.resultPackageId
    });
    const preview = buildGitHubPromotionPreview({
      repositoryFullName: context.project.repository.fullName,
      task: context.task,
      resultPackage: context.resultPackage,
      target,
      attributionMode: args.attributionMode,
      visibleRunnerId: context.visibleRunnerId
    });

    if (
      preview.body !== args.confirmedPreviewBody ||
      preview.title !== args.confirmedPreviewTitle
    ) {
      throw new Error("Promotion preview changed. Refresh the preview before posting.");
    }

    const now = isoNow();
    const attempt = await ctx.runMutation(recordPromotionAttemptRef, {
      preview,
      actorUserId: context.actorUserId,
      attributionMode: args.attributionMode,
      target,
      now
    });

    try {
      await verifyRepositoryPermission({
        repositoryFullName: context.project.repository.fullName,
        viewerGithubUserId: context.actorGithubUserId,
        installationId: context.installationId
      });
      const token = await createInstallationAccessToken(context.installationId);
      const request =
        target.kind === "issue_comment"
          ? buildGitHubIssueCommentRequest({
              repositoryFullName: context.project.repository.fullName,
              issueNumber: target.issueNumber,
              body: preview.body
            })
          : buildGitHubIssueRequest({
              repositoryFullName: context.project.repository.fullName,
              title: target.title,
              body: preview.body
            });
      const response = await requestGitHubJson<unknown>(request.url, {
        method: request.method,
        token,
        body: request.body,
        headers: {
          "content-type": "application/json"
        }
      });
      const created =
        target.kind === "issue_comment"
          ? {
              ...parseGitHubCreatedIssueComment(
                response as Parameters<typeof parseGitHubCreatedIssueComment>[0]
              ),
              issueNumber: attempt.targetIssueNumber
            }
          : (() => {
              const issue = parseGitHubCreatedIssue(
                response as Parameters<typeof parseGitHubCreatedIssue>[0]
              );

              return {
                ...issue,
                issueNumber: issue.number
              };
            })();
      const posted = await ctx.runMutation(recordPromotionPostedRef, {
        promotionId: attempt.promotionId,
        targetUrl: created.url,
        targetGitHubId: created.githubId,
        targetIssueNumber: created.issueNumber,
        now: isoNow()
      });

      return { promotion: posted, preview };
    } catch (error) {
      const failed = await ctx.runMutation(recordPromotionFailedRef, {
        promotionId: attempt.promotionId,
        errorSummary: error instanceof Error ? error.message : String(error),
        now: isoNow()
      });

      return { promotion: failed, preview };
    }
  }
});

export const syncInstallationFromWebhook = internalMutation({
  args: {
    sync: v.object({
      event: v.union(v.literal("installation"), v.literal("installation_repositories")),
      action: v.string(),
      installationId: v.string(),
      accountLogin: v.string(),
      accountType: v.string(),
      repositoryFullNames: v.array(v.string()),
      addedRepositoryFullNames: v.array(v.string()),
      removedRepositoryFullNames: v.array(v.string()),
      status: v.union(
        v.literal("active"),
        v.literal("suspended"),
        v.literal("deleted")
      ),
      senderGithubUserId: v.optional(v.string())
    })
  },
  handler: async (ctx, args): Promise<GitHubInstallationSync> => {
    const now = isoNow();
    const existing = await installationById(ctx, args.sync.installationId);
    const installedByUserId = await userIdForGithubUserId(
      ctx,
      args.sync.senderGithubUserId
    );
    const repositoryFullNames =
      args.sync.event === "installation_repositories"
        ? mergeRepositories(
            existing?.repositoryFullNames ?? [],
            args.sync.addedRepositoryFullNames,
            args.sync.removedRepositoryFullNames
          )
        : args.sync.status === "deleted"
          ? []
          : mergeRepositories(args.sync.repositoryFullNames, [], []);

    if (existing === null) {
      await ctx.db.insert("githubInstallations", {
        installationId: args.sync.installationId,
        accountLogin: args.sync.accountLogin,
        accountType: args.sync.accountType,
        installedByUserId,
        repositoryFullNames,
        status: args.sync.status,
        createdAt: now,
        updatedAt: now
      });
    } else {
      await ctx.db.patch(existing._id, {
        accountLogin: args.sync.accountLogin,
        accountType: args.sync.accountType,
        installedByUserId: installedByUserId ?? existing.installedByUserId,
        repositoryFullNames,
        status: args.sync.status,
        updatedAt: now
      });
    }

    const installationProjects = (await ctx.db
      .query("projects")
      .withIndex("by_github_installation", (q) =>
        q.eq("githubInstallationId", args.sync.installationId)
      )
      .collect()) as ProjectDoc[];
    const activeRepositoryKeys = new Set(repositoryFullNames.map(repositoryKey));

    for (const project of installationProjects) {
      const projectStillInstalled = activeRepositoryKeys.has(
        repositoryKey(project.projectId)
      );
      const status =
        args.sync.status === "active" && projectStillInstalled
          ? "verified"
          : "installation_removed";

      if (project.status !== status) {
        await ctx.db.patch(project._id, {
          status,
          updatedAt: now
        });
      }
    }

    await insertAuditEvent(ctx, {
      eventType: "github_installation.synced",
      entityType: "githubInstallation",
      entityId: args.sync.installationId,
      actorUserId: installedByUserId,
      occurredAt: now,
      metadata: {
        action: args.sync.action,
        event: args.sync.event,
        repositoryCount: repositoryFullNames.length,
        status: args.sync.status
      }
    });

    return {
      ...args.sync,
      repositoryFullNames
    };
  }
});
