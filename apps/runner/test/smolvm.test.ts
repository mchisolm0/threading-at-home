import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TaskExecution } from "@oss-capacity/core";
import { describe, expect, it } from "vitest";

import {
  buildSmolvmCommandPlan,
  checkSmolvmAvailability,
  extractSmolvmArtifacts,
  runIsolatedTaskCommands,
  stageSmolvmWorkspace,
  type ProcessExecutor
} from "../src/smolvm.js";

const execution = {
  isolation: "smolvm",
  image: "node:22-alpine",
  network: false,
  commands: [
    {
      name: "unit tests",
      argv: ["pnpm", "test"],
      timeoutMs: 12_000
    }
  ],
  artifacts: [
    {
      path: "reports/result.txt",
      kind: "log",
      mediaType: "text/plain"
    }
  ],
  maxOutputBytes: 64 * 1024
} satisfies TaskExecution;

describe("smolvm runner isolation helpers", () => {
  it("reports availability without reading local credentials", async () => {
    const availability = await checkSmolvmAvailability({
      exec: async (file, args) => {
        expect(file).toBe("smolvm");
        expect(args).toEqual(["--help"]);

        return {
          stdout: "smolvm 1.2.3\n",
          stderr: "",
          exitCode: 0
        };
      }
    });

    expect(availability).toMatchObject({
      ok: true,
      status: "available",
      version: "1.2.3"
    });
  });

  it("turns a missing binary into a diagnostic status", async () => {
    const missing = await checkSmolvmAvailability({
      exec: async () => {
        const error = new Error("spawn smolvm ENOENT") as Error & {
          code: string;
        };
        error.code = "ENOENT";
        throw error;
      }
    });

    expect(missing).toMatchObject({
      ok: false,
      status: "missing"
    });
  });

  it("constructs smolvm machine commands from explicit argv only", () => {
    const plan = buildSmolvmCommandPlan({
      execution,
      commandIndex: 0,
      snapshotPath: "/tmp/snapshot"
    });

    expect(plan.file).toBe("smolvm");
    expect(plan.timeoutMs).toBe(12_000);
    expect(plan.args).toEqual([
      "machine",
      "run",
      "--image",
      "node:22-alpine",
      "-v",
      "/tmp/snapshot:/workspace",
      "--",
      "/bin/sh",
      "-c",
      "cd /workspace && exec \"$@\"",
      "oss-capacity-command",
      "pnpm",
      "test"
    ]);
    expect(() =>
      buildSmolvmCommandPlan({
        execution: {
          ...execution,
          commands: [{ name: "shell", argv: ["sh", "-c", "env"] }]
        },
        commandIndex: 0,
        snapshotPath: "/tmp/snapshot"
      })
    ).toThrow("shell commands are not allowed");
  });

  it("stages a workspace snapshot without secret-shaped local state", async () => {
    const root = await mkdtemp(join(tmpdir(), "smolvm-source-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, ".codex"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "export const ok = true;\n");
    await writeFile(join(root, ".env"), "TOKEN=sk-secret123456789\n");
    await writeFile(join(root, ".env.test"), "TOKEN=sk-secret123456789\n");
    await writeFile(join(root, ".envrc"), "TOKEN=sk-secret123456789\n");
    await writeFile(join(root, ".env-secret"), "TOKEN=sk-secret123456789\n");
    await writeFile(join(root, ".git", "config"), "secret\n");
    await writeFile(join(root, ".codex", "auth.json"), "{}\n");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await symlink("/Users/alice/.ssh/id_rsa", join(root, "src", "secret-link"));

    const snapshot = await stageSmolvmWorkspace({ workspacePath: root });

    await expect(readFile(join(snapshot.path, "src", "index.ts"), "utf8")).resolves.toContain(
      "ok"
    );
    await expect(stat(join(snapshot.path, ".env"))).rejects.toThrow();
    await expect(stat(join(snapshot.path, ".env.test"))).rejects.toThrow();
    await expect(stat(join(snapshot.path, ".envrc"))).rejects.toThrow();
    await expect(stat(join(snapshot.path, ".env-secret"))).rejects.toThrow();
    await expect(stat(join(snapshot.path, ".git"))).rejects.toThrow();
    await expect(stat(join(snapshot.path, ".codex"))).rejects.toThrow();
    await expect(stat(join(snapshot.path, "node_modules"))).rejects.toThrow();
    await expect(stat(join(snapshot.path, "src", "secret-link"))).rejects.toThrow();
    expect(snapshot.warnings.join("\n")).toContain("Skipped");
  });

  it("runs commands with bounded redacted output and extracts redacted artifacts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "smolvm-workspace-"));
    const artifactRoot = await mkdtemp(join(tmpdir(), "smolvm-artifacts-"));
    await mkdir(join(workspace, "reports"), { recursive: true });
    await writeFile(join(workspace, "package.json"), "{}\n");
    const calls: unknown[] = [];
    const exec: ProcessExecutor = async (file, args, options) => {
      calls.push({ file, args, options });
      const volume = args[args.indexOf("-v") + 1];
      const snapshotPath = String(volume).split(":")[0];

      await mkdir(join(snapshotPath, "reports"), { recursive: true });
      await writeFile(
        join(snapshotPath, "reports", "result.txt"),
        "token=sk-secret123456789 and ok\n"
      );

      return {
        stdout: `finished for user@example.com ${"x".repeat(200)}`,
        stderr: "",
        exitCode: 0
      };
    };

    const result = await runIsolatedTaskCommands({
      taskExecution: {
        ...execution,
        maxOutputBytes: 32
      },
      workspacePath: workspace,
      artifactRoot,
      runId: "run-smolvm-test",
      availability: {
        ok: true,
        status: "available",
        command: "smolvm",
        version: "1.2.3",
        diagnostic: "smolvm 1.2.3"
      },
      dependencies: {
        exec,
        now: (() => {
          let value = 0;
          return () => {
            value += 10;
            return value;
          };
        })()
      }
    });

    expect(calls).toHaveLength(1);
    const volume = (calls[0] as { args: readonly string[] }).args[
      (calls[0] as { args: readonly string[] }).args.indexOf("-v") + 1
    ];
    const snapshotPath = String(volume).split(":")[0];

    await expect(stat(snapshotPath)).rejects.toThrow();
    expect(result.commandSummaries[0]?.summary).not.toContain("user@example.com");
    expect(result.commandResults[0]?.outputTruncated).toBe(true);
    expect(result.artifacts).toHaveLength(1);
    const storedArtifact = await readFile(
      join(artifactRoot, "run-smolvm-test", "smolvm", "reports", "result.txt"),
      "utf8"
    );
    expect(storedArtifact).not.toContain("sk-secret123456789");
    expect(storedArtifact).toContain("[redacted]");
  });

  it("declines execution when smolvm isolation is unavailable", async () => {
    await expect(
      runIsolatedTaskCommands({
        taskExecution: execution,
        workspacePath: tmpdir(),
        artifactRoot: tmpdir(),
        runId: "run-no-smolvm",
        availability: {
          ok: false,
          status: "missing",
          command: "smolvm",
          diagnostic: "not installed"
        }
      })
    ).rejects.toThrow("smolvm isolation required");
  });

  it("extracts only bounded expected artifact files", async () => {
    const snapshot = await mkdtemp(join(tmpdir(), "smolvm-snapshot-"));
    const artifactRoot = await mkdtemp(join(tmpdir(), "smolvm-output-"));

    await mkdir(join(snapshot, "logs"), { recursive: true });
    await writeFile(join(snapshot, "logs", "test.log"), "ok\n");

    const artifacts = await extractSmolvmArtifacts({
      specs: [{ path: "logs/test.log", kind: "log", maxBytes: 10 }],
      snapshotPath: snapshot,
      artifactRoot,
      runId: "run-artifacts"
    });

    expect(artifacts).toEqual([
      expect.objectContaining({
        kind: "log",
        storageKey: "results/run-artifacts/smolvm/logs/test.log",
        byteLength: 3,
        relativePath: "logs/test.log"
      })
    ]);
  });

  it("does not follow symlinks when extracting artifacts", async () => {
    const snapshot = await mkdtemp(join(tmpdir(), "smolvm-symlink-snapshot-"));
    const artifactRoot = await mkdtemp(join(tmpdir(), "smolvm-symlink-output-"));
    const secret = join(snapshot, "outside-secret.txt");
    const outside = await mkdtemp(join(tmpdir(), "smolvm-outside-"));

    await mkdir(join(snapshot, "logs"), { recursive: true });
    await writeFile(secret, "token=sk-secret123456789\n");
    await writeFile(join(outside, "test.log"), "token=sk-secret123456789\n");
    await symlink(secret, join(snapshot, "logs", "test.log"));
    await symlink(outside, join(snapshot, "linked-logs"));

    const artifacts = await extractSmolvmArtifacts({
      specs: [
        { path: "logs/test.log", kind: "log", maxBytes: 100 },
        { path: "linked-logs/test.log", kind: "log", maxBytes: 100 }
      ],
      snapshotPath: snapshot,
      artifactRoot,
      runId: "run-symlink"
    });

    expect(artifacts).toEqual([]);
  });
});
