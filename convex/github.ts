import { getAuthUserId } from "@convex-dev/auth/server";
import {
  createGitHubAppJwt,
  hasRepositoryMaintainerPermission,
  normalizeRepositoryFullName,
  parseGitHubRepositoryPermission,
  repositoryOwnerAndName,
  type GitHubInstallationSync
} from "@oss-capacity/github";
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

async function insertAuditEvent(
  ctx: MutationCtx,
  event: {
    readonly eventType: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly occurredAt: string;
    readonly projectId?: string;
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
