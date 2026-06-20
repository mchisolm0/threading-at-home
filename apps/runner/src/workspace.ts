import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { TaskRequest } from "@oss-capacity/core";

const execFileAsync = promisify(execFile);

export type WorkspaceExec = (
  file: string,
  args: readonly string[],
  options?: { readonly cwd?: string }
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export type WorkspaceDependencies = {
  readonly exec?: WorkspaceExec;
};

export type WorkspaceCheckout = {
  readonly path: string;
  readonly repositoryCommitSha?: string;
};

export async function ensureCleanWorkspace(input: {
  readonly workspaceRoot: string;
  readonly task: TaskRequest;
  readonly dependencies?: WorkspaceDependencies;
}): Promise<WorkspaceCheckout> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const task = input.task;
  const repositoryPath = safeRepositoryPath(workspaceRoot, task.repository.fullName);
  const exec = input.dependencies?.exec ?? defaultExec;
  const repositoryUrl = `https://github.com/${task.repository.fullName}.git`;
  const ref = task.target.ref ?? task.repository.defaultBranch;

  await mkdir(workspaceRoot, { recursive: true });

  if (await hasGitDirectory(repositoryPath)) {
    await exec("git", ["-C", repositoryPath, "remote", "set-url", "origin", repositoryUrl]);
  } else {
    await exec("git", ["clone", "--no-tags", "--depth", "1", repositoryUrl, repositoryPath]);
  }

  if (ref !== undefined) {
    await exec("git", [
      "-C",
      repositoryPath,
      "fetch",
      "--prune",
      "--no-tags",
      "--depth",
      "1",
      "origin",
      ref
    ]);
    await exec("git", ["-C", repositoryPath, "checkout", "--detach", "FETCH_HEAD"]);
  }

  await exec("git", ["-C", repositoryPath, "reset", "--hard", "HEAD"]);
  await exec("git", ["-C", repositoryPath, "clean", "-ffdx"]);

  const revision = await exec("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
  const repositoryCommitSha = revision.stdout.trim();

  return {
    path: repositoryPath,
    repositoryCommitSha: /^[a-f0-9]{40}$/.test(repositoryCommitSha)
      ? repositoryCommitSha
      : undefined
  };
}

export function safeRepositoryPath(workspaceRoot: string, repositoryFullName: string): string {
  const root = resolve(workspaceRoot);
  const digest = createHash("sha256")
    .update(repositoryFullName, "utf8")
    .digest("hex")
    .slice(0, 16);
  const safeName = repositoryFullName.replace(/[^A-Za-z0-9_.-]+/g, "__");
  const candidate = resolve(root, `${safeName}-${digest}`);

  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Workspace path escaped the workspace root");
  }

  return candidate;
}

async function hasGitDirectory(repositoryPath: string): Promise<boolean> {
  try {
    return (await stat(join(repositoryPath, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

async function defaultExec(
  file: string,
  args: readonly string[],
  options?: { readonly cwd?: string }
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync(file, [...args], {
    cwd: options?.cwd,
    maxBuffer: 10 * 1024 * 1024
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}
