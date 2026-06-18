import { makeFunctionReference } from "convex/server";

export type Viewer = {
  readonly userId: string;
  readonly githubUserId?: string;
  readonly githubLogin?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly image?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ProjectView = {
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

export type GitHubInstallationView = {
  readonly installationId: string;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly repositoryFullNames: readonly string[];
  readonly status: string;
  readonly updatedAt: string;
};

export const convexApi = {
  users: {
    viewer: makeFunctionReference<"query", Record<string, never>, Viewer | null>(
      "users:viewer"
    ),
    touchSession: makeFunctionReference<
      "mutation",
      Record<string, never>,
      Viewer
    >("users:touchSession")
  },
  github: {
    myProjects: makeFunctionReference<
      "query",
      Record<string, never>,
      ProjectView[]
    >("github:myProjects"),
    availableInstallations: makeFunctionReference<
      "query",
      Record<string, never>,
      GitHubInstallationView[]
    >("github:availableInstallations"),
    registerProject: makeFunctionReference<
      "action",
      { repositoryFullName: string },
      ProjectView
    >("github:registerProject")
  }
};
