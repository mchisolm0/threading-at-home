import { describe, expect, it } from "vitest";

import { runCli, type CliDependencies, type CliIO } from "../src/cli.js";
import type { BrokerClient } from "../src/broker.js";
import type { RunnerConfig } from "../src/config.js";

const authHash = `sha256:${"b".repeat(64)}`;
const now = new Date("2026-06-20T15:30:00.000Z");

function createIo(env: NodeJS.ProcessEnv = {}): {
  readonly io: CliIO;
  readonly stdout: { value: string };
  readonly stderr: { value: string };
} {
  const stdout = { value: "" };
  const stderr = { value: "" };

  return {
    io: {
      env,
      stdout: {
        write: (chunk: string | Uint8Array) => {
          stdout.value += chunk.toString();
          return true;
        }
      },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          stderr.value += chunk.toString();
          return true;
        }
      }
    },
    stdout,
    stderr
  };
}

function createBroker(calls: unknown[]): BrokerClient {
  return {
    exchangeRunnerSetupToken: async (input) => {
      calls.push({ method: "exchangeRunnerSetupToken", input });

      return {
        runnerId: input.runner.runnerId,
        displayName: input.runner.displayName,
        platform: input.runner.platform,
        architecture: input.runner.architecture,
        codexCliVersion: input.runner.codexCliVersion,
        codexAuthMode: input.runner.codexAuthMode,
        supportedSandboxModes: input.runner.supportedSandboxModes,
        supportsNetwork: input.runner.supportsNetwork,
        supportsPatchCapture: input.runner.supportsPatchCapture,
        supportedTaskTypes: input.runner.supportedTaskTypes,
        maxOutputBytes: input.runner.maxOutputBytes,
        registeredAt: input.runner.registeredAt,
        lastSeenAt: input.now
      };
    },
    heartbeatRunner: async (input) => {
      calls.push({ method: "heartbeatRunner", input });

      return {
        runnerId: input.runnerId,
        platform: input.runner.platform,
        architecture: input.runner.architecture,
        codexAuthMode: input.runner.codexAuthMode,
        supportedSandboxModes: input.runner.supportedSandboxModes,
        supportsNetwork: input.runner.supportsNetwork,
        supportsPatchCapture: input.runner.supportsPatchCapture,
        supportedTaskTypes: input.runner.supportedTaskTypes,
        maxOutputBytes: input.runner.maxOutputBytes,
        registeredAt: input.runner.registeredAt,
        lastSeenAt: input.now
      };
    },
    runnerConfiguration: async (input) => {
      calls.push({ method: "runnerConfiguration", input });

      return {
        runner: {
          runnerId: input.runnerId,
          platform: "darwin",
          architecture: "arm64",
          codexAuthMode: "chatgpt",
          supportedSandboxModes: ["read-only"],
          supportsNetwork: false,
          supportsPatchCapture: false,
          supportedTaskTypes: ["analysis"],
          maxOutputBytes: 1024,
          registeredAt: now.toISOString(),
          lastSeenAt: now.toISOString()
        },
        policy: null,
        subscriptions: []
      };
    }
  };
}

describe("runner CLI", () => {
  it("logs in with a locally hashed setup token and writes redacted output", async () => {
    const { io, stdout, stderr } = createIo();
    const calls: unknown[] = [];
    const writes: { path: string; config: RunnerConfig }[] = [];
    const dependencies: CliDependencies = {
      now: () => now,
      createRunnerId: () => "runner-test",
      createLocalRunnerAuthHash: () => authHash,
      createBrokerClient: () => createBroker(calls),
      readCodexAccountState: async () => ({
        codexCliVersion: "0.140.0",
        authenticated: true,
        authMode: "chatgpt",
        requiresOpenaiAuth: false,
        account: {
          type: "chatgpt",
          planType: "pro"
        }
      }),
      writeConfig: async (path, config) => {
        writes.push({ path, config });
      }
    };
    const exitCode = await runCli(
      [
        "login",
        "--config",
        "/tmp/runner.json",
        "--broker-url",
        "https://example.convex.cloud",
        "--token",
        "ocr_local-token",
        "--name",
        "Local Runner"
      ],
      io,
      dependencies
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.config.runnerAuthTokenHash).toBe(authHash);
    expect(JSON.stringify(calls)).toContain("exchangeRunnerSetupToken");
    expect(JSON.stringify(calls)).toContain("sha256:");
    expect(JSON.stringify(calls)).not.toContain("ocr_local-token");
    expect(stdout.value).not.toContain(authHash);
    expect(stdout.value).not.toContain("ocr_local-token");
  });

  it("diagnoses config, broker, and Codex without printing local auth material", async () => {
    const { io, stdout } = createIo();
    const calls: unknown[] = [];
    const config: RunnerConfig = {
      schemaVersion: 1,
      brokerUrl: "https://example.convex.cloud",
      runnerId: "runner-test",
      runnerAuthTokenHash: authHash,
      codexBin: "codex",
      maxOutputBytes: 1024,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    const exitCode = await runCli(["diagnose", "--config", "/tmp/runner.json"], io, {
      readConfig: async () => config,
      createBrokerClient: () => createBroker(calls),
      readCodexAccountState: async () => ({
        codexCliVersion: "0.140.0",
        authenticated: true,
        authMode: "chatgpt",
        account: {
          type: "chatgpt",
          planType: "user@example.com"
        } as { type: string; planType: string; email: string }
      }),
      readCodexRateLimits: async () => ({
        codexCliVersion: "0.140.0",
        account: {
          authenticated: true,
          authMode: "chatgpt"
        },
        rateLimits: [
          {
            type: "primary",
            usedPercent: 7
          }
        ]
      })
    });
    const output = JSON.parse(stdout.value) as { ok: boolean };

    expect(exitCode).toBe(0);
    expect(output.ok).toBe(true);
    expect(stdout.value).not.toContain(authHash);
    expect(stdout.value).not.toContain("/tmp/runner.json");
    expect(stdout.value).not.toContain("user@example.com");
    expect(stdout.value).toContain("[redacted]");
  });

  it("redacts local paths from diagnostic errors", async () => {
    const { io, stdout } = createIo();
    const exitCode = await runCli(["diagnose", "--config", "/tmp/runner.json"], io, {
      readConfig: async () => {
        throw new Error(
          "ENOENT: no such file or directory, open '/tmp/runner.json'"
        );
      }
    });
    const output = JSON.parse(stdout.value) as { ok: boolean };

    expect(exitCode).toBe(0);
    expect(output.ok).toBe(false);
    expect(stdout.value).not.toContain("/tmp/runner.json");
    expect(stdout.value).toContain("[redacted-path]");
  });
});
