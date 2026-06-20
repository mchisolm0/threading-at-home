import { makeFunctionReference } from "convex/server";
import type { TaskRequest, VolunteerPolicy } from "@oss-capacity/core";

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

export type VolunteerProjectView = {
  readonly projectId: string;
  readonly repository: ProjectView["repository"];
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type VolunteerSubscriptionView = {
  readonly projectId: string;
  readonly enabled: boolean;
  readonly taskTypeAllowlist: readonly string[];
  readonly maxSandbox: string;
  readonly allowNetwork: boolean;
  readonly allowPatches: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type RunnerRegistrationView = {
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

export type RunnerSetupTokenView = {
  readonly tokenId: string;
  readonly label?: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly lastUsedAt?: string;
};

export type VolunteerDashboard = {
  readonly projects: readonly VolunteerProjectView[];
  readonly subscriptions: readonly VolunteerSubscriptionView[];
  readonly policy: VolunteerPolicy | null;
  readonly runners: readonly RunnerRegistrationView[];
  readonly runnerTokens: readonly RunnerSetupTokenView[];
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
  },
  lifecycle: {
    myTasks: makeFunctionReference<
      "query",
      { projectId?: string },
      TaskRequest[]
    >("lifecycle:myTasks"),
    taskDetail: makeFunctionReference<
      "query",
      { taskRequestId: string },
      TaskRequest | null
    >("lifecycle:taskDetail"),
    createTask: makeFunctionReference<
      "mutation",
      { task: TaskRequest },
      TaskRequest
    >("lifecycle:createTask"),
    activateTask: makeFunctionReference<
      "mutation",
      { taskRequestId: string; actorUserId?: string; now: string },
      TaskRequest
    >("lifecycle:activateTask"),
    archiveTask: makeFunctionReference<
      "mutation",
      { taskRequestId: string; now: string },
      TaskRequest
    >("lifecycle:archiveTask")
  },
  volunteer: {
    dashboard: makeFunctionReference<
      "query",
      Record<string, never>,
      VolunteerDashboard
    >("volunteer:dashboard"),
    savePolicy: makeFunctionReference<
      "mutation",
      { policy: VolunteerPolicy },
      VolunteerPolicy
    >("volunteer:savePolicy"),
    saveSubscription: makeFunctionReference<
      "mutation",
      {
        projectId: string;
        enabled: boolean;
        taskTypeAllowlist: string[];
        maxSandbox: string;
        allowNetwork: boolean;
        allowPatches: boolean;
        now: string;
      },
      VolunteerSubscriptionView
    >("volunteer:saveSubscription"),
    createRunnerSetupToken: makeFunctionReference<
      "mutation",
      {
        tokenId: string;
        tokenHash: string;
        label?: string;
        now: string;
        expiresAt?: string;
      },
      RunnerSetupTokenView
    >("volunteer:createRunnerSetupToken"),
    revokeRunnerSetupToken: makeFunctionReference<
      "mutation",
      { tokenId: string; now: string },
      RunnerSetupTokenView
    >("volunteer:revokeRunnerSetupToken"),
    exchangeRunnerSetupToken: makeFunctionReference<
      "mutation",
      {
        tokenHash: string;
        runner: unknown;
        now: string;
      },
      RunnerRegistrationView
    >("volunteer:exchangeRunnerSetupToken")
  }
};
