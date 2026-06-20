import { ConvexHttpClient } from "convex/browser";

import { runnerConvexApi, type RunnerConfigurationView, type RunnerRegistrationView } from "./convexApi.js";
import type { RunnerCapability } from "@oss-capacity/core";

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
};

export function createBrokerClient(brokerUrl: string): BrokerClient {
  const client = new ConvexHttpClient(brokerUrl);

  return {
    exchangeRunnerSetupToken: async (input) =>
      await client.mutation(runnerConvexApi.exchangeRunnerSetupToken, input),
    heartbeatRunner: async (input) =>
      await client.mutation(runnerConvexApi.heartbeatRunner, input),
    runnerConfiguration: async (input) =>
      await client.query(runnerConvexApi.runnerConfiguration, input)
  };
}
