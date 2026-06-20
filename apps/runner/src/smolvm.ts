import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { ResultPackage, TaskExecution, TaskExecutionArtifact } from "@oss-capacity/core";

import { sanitizeText } from "./sanitize.js";

const execFileAsync = promisify(execFile);

const defaultSmolvmBin = "smolvm";
const defaultImage = "alpine:latest";
const defaultCommandTimeoutMs = 5 * 60 * 1000;
const defaultMaxOutputBytes = 256 * 1024;
const defaultArtifactMaxBytes = 256 * 1024;
const defaultSnapshotMaxBytes = 100 * 1024 * 1024;
const defaultSnapshotMaxFiles = 20_000;
const shellWrapper = "cd /workspace && exec \"$@\"";
const forbiddenExecutables = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "dash",
  "fish",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "zsh"
]);
const excludedSnapshotNames = new Set([
  ".codex",
  ".env",
  ".env.local",
  ".env.production",
  ".git",
  ".npmrc",
  ".ssh",
  ".vercel",
  "coverage",
  "dist",
  "node_modules"
]);

export type SmolvmAvailability =
  | {
      readonly ok: true;
      readonly status: "available";
      readonly command: string;
      readonly version?: string;
      readonly diagnostic: string;
    }
  | {
      readonly ok: false;
      readonly status: "missing" | "unavailable";
      readonly command: string;
      readonly diagnostic: string;
    };

export type ProcessExecutor = (
  file: string,
  args: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  }
) => Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut?: boolean;
}>;

export type SmolvmCommandPlan = {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
};

export type SmolvmCommandResult = {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
};

export type ExtractedArtifact = ResultPackage["artifacts"][number] & {
  readonly relativePath: string;
};

export type IsolatedExecutionResult = {
  readonly availability: SmolvmAvailability;
  readonly snapshotPath: string;
  readonly commandResults: readonly SmolvmCommandResult[];
  readonly commandSummaries: readonly ResultPackage["commandSummaries"][number][];
  readonly artifacts: readonly ExtractedArtifact[];
  readonly warnings: readonly string[];
};

export type SmolvmDependencies = {
  readonly exec?: ProcessExecutor;
  readonly now?: () => number;
};

export async function checkSmolvmAvailability(input: {
  readonly smolvmBin?: string;
  readonly exec?: ProcessExecutor;
} = {}): Promise<SmolvmAvailability> {
  const command = input.smolvmBin ?? defaultSmolvmBin;
  const exec = input.exec ?? defaultProcessExecutor;

  try {
    const result = await exec(command, ["--help"], {
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024
    });
    const output = sanitizeText(`${result.stdout}\n${result.stderr}`.trim());

    if (result.exitCode !== 0) {
      return {
        ok: false,
        status: "unavailable",
        command,
        diagnostic: output || `smolvm --help exited ${result.exitCode}`
      };
    }

    return {
      ok: true,
      status: "available",
      command,
      version: parseSmolvmVersion(output),
      diagnostic: output || "smolvm is available"
    };
  } catch (error) {
    const diagnostic = sanitizeText(error instanceof Error ? error.message : String(error));
    const missing = /\bENOENT\b|not found|no such file/i.test(diagnostic);

    return {
      ok: false,
      status: missing ? "missing" : "unavailable",
      command,
      diagnostic
    };
  }
}

export function buildSmolvmCommandPlan(input: {
  readonly smolvmBin?: string;
  readonly execution: TaskExecution;
  readonly commandIndex: number;
  readonly snapshotPath: string;
}): SmolvmCommandPlan {
  const smolvmBin = input.smolvmBin ?? defaultSmolvmBin;
  const command = input.execution.commands[input.commandIndex];

  if (command === undefined) {
    throw new Error(`Missing isolated command ${input.commandIndex}`);
  }

  validateIsolatedCommand(command.argv);

  const timeoutMs =
    command.timeoutMs ?? input.execution.timeoutMs ?? defaultCommandTimeoutMs;
  const maxOutputBytes = input.execution.maxOutputBytes ?? defaultMaxOutputBytes;
  const args = [
    "machine",
    "run",
    ...(input.execution.network ? ["--net"] : []),
    ...(input.execution.allowHosts ?? []).flatMap((host) => [
      "--allow-host",
      host
    ]),
    "--image",
    input.execution.image || defaultImage,
    "-v",
    `${resolve(input.snapshotPath)}:/workspace`,
    "--",
    "/bin/sh",
    "-c",
    shellWrapper,
    "oss-capacity-command",
    ...command.argv
  ];

  return {
    file: smolvmBin,
    args,
    timeoutMs,
    maxOutputBytes
  };
}

export async function runIsolatedTaskCommands(input: {
  readonly taskExecution: TaskExecution;
  readonly workspacePath: string;
  readonly artifactRoot: string;
  readonly runId: string;
  readonly smolvmBin?: string;
  readonly availability?: SmolvmAvailability;
  readonly dependencies?: SmolvmDependencies;
}): Promise<IsolatedExecutionResult> {
  const exec = input.dependencies?.exec ?? defaultProcessExecutor;
  const now = input.dependencies?.now ?? (() => Date.now());
  const availability =
    input.availability ??
    (await checkSmolvmAvailability({ smolvmBin: input.smolvmBin, exec }));

  if (!availability.ok) {
    throw new Error(
      `smolvm isolation required but ${availability.status}: ${availability.diagnostic}`
    );
  }

  const snapshot = await stageSmolvmWorkspace({
    workspacePath: input.workspacePath
  });
  const warnings: string[] = [...snapshot.warnings];
  const commandResults: SmolvmCommandResult[] = [];

  try {
    for (const [index, command] of input.taskExecution.commands.entries()) {
      const plan = buildSmolvmCommandPlan({
        smolvmBin: input.smolvmBin,
        execution: input.taskExecution,
        commandIndex: index,
        snapshotPath: snapshot.path
      });
      const startedAt = now();
      const result = await exec(plan.file, plan.args, {
        timeoutMs: plan.timeoutMs,
        maxOutputBytes: plan.maxOutputBytes
      });
      const completedAt = now();
      const sanitizedStdout = boundText(result.stdout, plan.maxOutputBytes);
      const sanitizedStderr = boundText(result.stderr, plan.maxOutputBytes);

      commandResults.push({
        name: command.name,
        command: formatCommand(command.argv),
        exitCode: result.timedOut === true ? -1 : result.exitCode,
        durationMs: Math.max(0, completedAt - startedAt),
        stdout: sanitizedStdout.text,
        stderr: sanitizedStderr.text,
        timedOut: result.timedOut === true,
        outputTruncated: sanitizedStdout.truncated || sanitizedStderr.truncated
      });
    }

    const artifacts = await extractSmolvmArtifacts({
      specs: input.taskExecution.artifacts ?? [],
      snapshotPath: snapshot.path,
      artifactRoot: input.artifactRoot,
      runId: input.runId
    });

    return {
      availability,
      snapshotPath: snapshot.path,
      commandResults,
      commandSummaries: commandResults.map(commandResultToSummary),
      artifacts,
      warnings
    };
  } finally {
    await rm(snapshot.path, { recursive: true, force: true });
  }
}

export async function stageSmolvmWorkspace(input: {
  readonly workspacePath: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}): Promise<{
  readonly path: string;
  readonly warnings: readonly string[];
}> {
  const source = resolve(input.workspacePath);
  const target = await mkdtemp(join(tmpdir(), "oss-capacity-smolvm-"));
  const maxBytes = input.maxBytes ?? defaultSnapshotMaxBytes;
  const maxFiles = input.maxFiles ?? defaultSnapshotMaxFiles;
  const warnings: string[] = [];
  let copiedBytes = 0;
  let copiedFiles = 0;

  async function copyTree(from: string, to: string): Promise<boolean> {
    const entries = await readdir(from, { withFileTypes: true });

    await mkdir(to, { recursive: true, mode: 0o700 });

    for (const entry of entries) {
      const name = entry.name;

      if (isExcludedSnapshotName(name)) {
        warnings.push(`Skipped ${sanitizeText(name)} while staging smolvm workspace.`);
        continue;
      }

      const sourcePath = join(from, name);
      const targetPath = join(to, name);

      if (entry.isSymbolicLink()) {
        warnings.push(`Skipped symlink ${sanitizeText(relative(source, sourcePath))}.`);
        continue;
      }

      if (entry.isDirectory()) {
        const shouldContinue = await copyTree(sourcePath, targetPath);

        if (!shouldContinue) {
          return false;
        }

        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileStat = await lstat(sourcePath);

      if (copiedFiles + 1 > maxFiles || copiedBytes + fileStat.size > maxBytes) {
        warnings.push("Workspace snapshot reached its file or byte limit; remaining files were skipped.");
        return false;
      }

      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await copyFile(sourcePath, targetPath);
      copiedFiles += 1;
      copiedBytes += fileStat.size;
    }

    return true;
  }

  try {
    await copyTree(source, target);
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }

  return {
    path: target,
    warnings
  };
}

export async function extractSmolvmArtifacts(input: {
  readonly specs: readonly TaskExecutionArtifact[];
  readonly snapshotPath: string;
  readonly artifactRoot: string;
  readonly runId: string;
}): Promise<readonly ExtractedArtifact[]> {
  const artifacts: ExtractedArtifact[] = [];
  const root = resolve(input.snapshotPath);
  const rootRealPath = await realpath(root);
  const destinationRoot = resolve(input.artifactRoot, input.runId, "smolvm");

  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });

  for (const spec of input.specs.slice(0, 25)) {
    const sourcePath = safeWorkspacePath(root, spec.path);
    const sourceStat = await lstat(sourcePath).catch(() => undefined);

    if (sourceStat === undefined || !sourceStat.isFile()) {
      continue;
    }

    const sourceRealPath = await realpath(sourcePath).catch(() => undefined);

    if (
      sourceRealPath === undefined ||
      !isPathInsideRoot(rootRealPath, sourceRealPath)
    ) {
      continue;
    }

    const maxBytes = spec.maxBytes ?? defaultArtifactMaxBytes;
    const rawContent = (await readFile(sourcePath)).subarray(0, maxBytes);
    const content = Buffer.from(sanitizeText(rawContent.toString("utf8")), "utf8");
    const byteLength = content.length;
    const relativePath = spec.path.replace(/\\/g, "/");
    const destinationPath = safeDestinationPath(destinationRoot, relativePath);
    const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;

    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await writeFile(destinationPath, content, { mode: 0o600 });
    await chmod(destinationPath, 0o600);

    artifacts.push({
      kind: spec.kind,
      storageKey: `results/${input.runId}/smolvm/${relativePath}`,
      sha256,
      byteLength,
      mediaType: spec.mediaType,
      relativePath
    });
  }

  return artifacts;
}

function validateIsolatedCommand(argv: readonly string[]): void {
  if (argv.length === 0) {
    throw new Error("Isolated command argv must not be empty");
  }

  const executable = basename(argv[0] ?? "").toLowerCase();

  if (forbiddenExecutables.has(executable)) {
    throw new Error("Maintainer-provided shell commands are not allowed in smolvm execution");
  }

  for (const arg of argv) {
    if (arg.includes("\0")) {
      throw new Error("Isolated command arguments must not contain NUL bytes");
    }
  }
}

function isExcludedSnapshotName(name: string): boolean {
  return (
    excludedSnapshotNames.has(name) ||
    name.startsWith(".env") ||
    name.endsWith(".pem")
  );
}

function commandResultToSummary(
  result: SmolvmCommandResult
): ResultPackage["commandSummaries"][number] {
  const output = [result.stdout, result.stderr]
    .filter((item) => item.length > 0)
    .join("\n");
  const details = [
    result.timedOut ? "timed out" : undefined,
    result.outputTruncated ? "output truncated" : undefined,
    output.length > 0 ? output.slice(0, 1_500) : undefined
  ]
    .filter((item): item is string => item !== undefined)
    .join("; ");

  return {
    command: `smolvm: ${result.command}`,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    summary:
      details.length > 0
        ? `Isolated command ${result.name} finished: ${details}`
        : `Isolated command ${result.name} finished with no output.`
  };
}

function formatCommand(argv: readonly string[]): string {
  return argv.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

function boundText(value: string, maxBytes: number): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const redacted = sanitizeText(value);
  const buffer = Buffer.from(redacted, "utf8");

  if (buffer.length <= maxBytes) {
    return { text: redacted, truncated: false };
  }

  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true
  };
}

function parseSmolvmVersion(output: string): string | undefined {
  const match = output.match(/\b(?:smolvm\s*)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/i);

  return match?.[1];
}

function safeWorkspacePath(root: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  const candidate = resolve(root, normalized);

  if (candidate !== root && candidate.startsWith(`${root}${sep}`)) {
    return candidate;
  }

  throw new Error("Artifact path escaped the smolvm workspace");
}

function safeDestinationPath(root: string, relativePath: string): string {
  const candidate = resolve(root, relativePath);

  if (candidate !== root && candidate.startsWith(`${root}${sep}`)) {
    return candidate;
  }

  throw new Error("Artifact destination escaped the artifact root");
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function defaultProcessExecutor(
  file: string,
  args: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  }
): ReturnType<ProcessExecutor> {
  try {
    const result = await execFileAsync(file, [...args], {
      cwd: options?.cwd,
      timeout: options?.timeoutMs,
      maxBuffer: options?.maxOutputBytes ?? defaultMaxOutputBytes
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0
    };
  } catch (error) {
    const nodeError = error as Error & {
      readonly stdout?: string | Buffer;
      readonly stderr?: string | Buffer;
      readonly code?: number | string;
      readonly killed?: boolean;
      readonly signal?: string;
    };

    if (nodeError.code === "ENOENT") {
      throw error;
    }

    return {
      stdout: bufferishToString(nodeError.stdout),
      stderr: bufferishToString(nodeError.stderr),
      exitCode: typeof nodeError.code === "number" ? nodeError.code : 1,
      timedOut:
        nodeError.killed === true ||
        nodeError.signal === "SIGTERM" ||
        /timed out|maxBuffer/i.test(nodeError.message)
    };
  }
}

function bufferishToString(value: string | Buffer | undefined): string {
  if (value === undefined) {
    return "";
  }

  return typeof value === "string" ? value : value.toString("utf8");
}
