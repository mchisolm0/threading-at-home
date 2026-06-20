import { ConvexHttpClient } from "convex/browser";

import {
  runnerConvexApi,
  type RunnerConfigurationView,
  type RunnerLeaseView,
  type RunnerRegistrationView
} from "./convexApi.js";
import type { ResultPackage, RunnerCapability } from "@oss-capacity/core";

export type { RunnerLeaseView } from "./convexApi.js";

export type BrokerClient = {
  readonly exchangeRunnerSetupToken: (input: {
    readonly tokenHash: string;
    readonly runnerAuthTokenHash: string;
    readonly runner: Omit<RunnerCapability, "volunteerUserId">;
    readonly now: string;
  }) => Promise<RunnerRegistrationView>;
  readonly heartbeatRunner: (input: {
    readonly runnerId: string;
    readonly runnerAuthTokenHash: string;
    readonly runner: Omit<RunnerCapability, "volunteerUserId">;
    readonly now: string;
  }) => Promise<RunnerRegistrationView>;
  readonly runnerConfiguration: (input: {
    readonly runnerId: string;
    readonly runnerAuthTokenHash: string;
  }) => Promise<RunnerConfigurationView>;
  readonly eligibleTask: (input: {
    readonly runnerId: string;
    readonly runnerAuthTokenHash: string;
    readonly now: string;
    readonly taskRequestId?: string;
  }) => Promise<RunnerLeaseView["task"] | null>;
  readonly leaseEligibleTask: (input: {
    readonly runnerId: string;
    readonly runnerAuthTokenHash: string;
    readonly leaseId: string;
    readonly runId: string;
    readonly leaseTokenHash: string;
    readonly now: string;
    readonly expiresAt: string;
    readonly taskRequestId?: string;
  }) => Promise<RunnerLeaseView | null>;
  readonly completeRun: (input: {
    readonly runnerId: string;
    readonly runnerAuthTokenHash: string;
    readonly resultPackage: ResultPackage;
    readonly now: string;
  }) => Promise<ResultPackage>;
  readonly failRun: (input: {
    readonly runnerId: string;
    readonly runnerAuthTokenHash: string;
    readonly resultPackage: ResultPackage;
    readonly now: string;
  }) => Promise<ResultPackage>;
};

export function createBrokerClient(brokerUrl: string): BrokerClient {
  const client = new ConvexHttpClient(brokerUrl);

  return {
    exchangeRunnerSetupToken: async (input) =>
      await client.mutation(runnerConvexApi.exchangeRunnerSetupToken, input),
    heartbeatRunner: async (input) =>
      await client.mutation(runnerConvexApi.heartbeatRunner, input),
    runnerConfiguration: async (input) =>
      await client.query(runnerConvexApi.runnerConfiguration, input),
    eligibleTask: async (input) =>
      await client.query(runnerConvexApi.eligibleTask, input),
    leaseEligibleTask: async (input) =>
      await client.mutation(runnerConvexApi.leaseEligibleTask, input),
    completeRun: async (input) =>
      await client.mutation(runnerConvexApi.completeRun, input),
    failRun: async (input) =>
      await client.mutation(runnerConvexApi.failRun, input)
  };
}
