import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseRunnerConfig,
  redactRunnerConfig,
  writeRunnerConfig
} from "../src/config.js";

const tokenHash = `sha256:${"a".repeat(64)}`;

describe("runner config", () => {
  it("parses and redacts local runner config", () => {
    const config = parseRunnerConfig({
      schemaVersion: 1,
      brokerUrl: "https://example.convex.cloud/",
      runnerId: "runner-local",
      runnerAuthTokenHash: tokenHash,
      displayName: "Kitchen Mac",
      codexBin: "codex",
      maxOutputBytes: 1024,
      createdAt: "2026-06-20T15:00:00.000Z",
      updatedAt: "2026-06-20T15:01:00.000Z",
      lastSeenAt: "2026-06-20T15:02:00.000Z"
    });

    expect(config.brokerUrl).toBe("https://example.convex.cloud");
    expect(redactRunnerConfig(config)).toEqual({
      ...config,
      runnerAuthTokenHash: "[redacted]"
    });
    expect(JSON.stringify(redactRunnerConfig(config))).not.toContain(tokenHash);
  });

  it("rejects malformed auth hashes", () => {
    expect(() =>
      parseRunnerConfig({
        schemaVersion: 1,
        brokerUrl: "https://example.convex.cloud",
        runnerId: "runner-local",
        runnerAuthTokenHash: "raw-secret",
        codexBin: "codex",
        maxOutputBytes: 1024,
        createdAt: "2026-06-20T15:00:00.000Z",
        updatedAt: "2026-06-20T15:01:00.000Z"
      })
    ).toThrow("runnerAuthTokenHash must be a sha256 token hash");
  });

  it("allows http broker URLs only for loopback development", () => {
    expect(
      parseRunnerConfig({
        schemaVersion: 1,
        brokerUrl: "http://localhost:3210/",
        runnerId: "runner-local",
        runnerAuthTokenHash: tokenHash,
        codexBin: "codex",
        maxOutputBytes: 1024,
        createdAt: "2026-06-20T15:00:00.000Z",
        updatedAt: "2026-06-20T15:01:00.000Z"
      }).brokerUrl
    ).toBe("http://localhost:3210");

    expect(() =>
      parseRunnerConfig({
        schemaVersion: 1,
        brokerUrl: "http://example.convex.cloud",
        runnerId: "runner-local",
        runnerAuthTokenHash: tokenHash,
        codexBin: "codex",
        maxOutputBytes: 1024,
        createdAt: "2026-06-20T15:00:00.000Z",
        updatedAt: "2026-06-20T15:01:00.000Z"
      })
    ).toThrow("brokerUrl must be an http(s) URL");
  });

  it("writes local config files with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oss-capacity-runner-"));
    const path = join(directory, "runner.json");

    await writeFile(path, "{}\n", "utf8");
    await chmod(path, 0o644);
    await writeRunnerConfig(path, {
      schemaVersion: 1,
      brokerUrl: "https://example.convex.cloud",
      runnerId: "runner-local",
      runnerAuthTokenHash: tokenHash,
      codexBin: "codex",
      maxOutputBytes: 1024,
      createdAt: "2026-06-20T15:00:00.000Z",
      updatedAt: "2026-06-20T15:01:00.000Z"
    });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
