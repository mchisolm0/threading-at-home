import { makeFunctionReference } from "convex/server";

import type { RunnerCapability, VolunteerPolicy } from "@oss-capacity/core";

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

export type RunnerSubscriptionView = {
  readonly projectId: string;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly fullName: string;
    readonly defaultBranch?: string;
  };
  readonly enabled: boolean;
  readonly taskTypeAllowlist: readonly string[];
  readonly maxSandbox: string;
  readonly allowNetwork: boolean;
  readonly allowPatches: boolean;
  readonly updatedAt: string;
};

export type RunnerConfigurationView = {
  readonly runner: RunnerRegistrationView;
  readonly policy: VolunteerPolicy | null;
  readonly subscriptions: readonly RunnerSubscriptionView[];
};

export const runnerConvexApi = {
  exchangeRunnerSetupToken: makeFunctionReference<
    "mutation",
    {
      tokenHash: string;
      runnerAuthTokenHash: string;
      runner: Omit<RunnerCapability, "volunteerUserId">;
      now: string;
    },
    RunnerRegistrationView
  >("volunteer:exchangeRunnerSetupToken"),
  heartbeatRunner: makeFunctionReference<
    "mutation",
    {
      runnerId: string;
      runnerAuthTokenHash: string;
      runner: Omit<RunnerCapability, "volunteerUserId">;
      now: string;
    },
    RunnerRegistrationView
  >("volunteer:heartbeatRunner"),
  runnerConfiguration: makeFunctionReference<
    "query",
    {
      runnerId: string;
      runnerAuthTokenHash: string;
    },
    RunnerConfigurationView
  >("volunteer:runnerConfiguration")
};
