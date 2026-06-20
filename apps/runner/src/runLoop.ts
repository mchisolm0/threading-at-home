import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import {
  CodexClientError,
  CodexExecError,
  readCodexAccountState,
  readCodexRateLimits,
  runCodexExec,
  type CodexAccountState,
  type CodexExecResult,
  type CodexRateLimitState
} from "@oss-capacity/codex";
import {
  parseResultPackage,
  type JsonObject,
  type ResultPackage,
  type TaskRequest,
  type VolunteerPolicy
} from "@oss-capacity/core";

import type { BrokerClient, RunnerLeaseView } from "./broker.js";
import type { RunnerConfig } from "./config.js";
import { sanitizeError, sanitizeText } from "./sanitize.js";
import {
  ensureCleanWorkspace,
  type WorkspaceCheckout,
  type WorkspaceDependencies
} from "./workspace.js";

const defaultLeaseMinutes = 30;
const defaultCodexTimeoutMs = 10 * 60 * 1000;

export type RunLoopDependencies = WorkspaceDependencies & {
  readonly now?: () => Date;
  readonly readCodexAccountState?: typeof readCodexAccountState;
  readonly readCodexRateLimits?: typeof readCodexRateLimits;
  readonly runCodexExec?: typeof runCodexExec;
};

export type CapacityDecision = {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly codexCliVersion?: string;
};

export type RunOnceResult = {
  readonly ok: boolean;
  readonly command: "run-once";
  readonly status: "completed" | "failed" | "idle" | "skipped";
  readonly capacity: CapacityDecision;
  readonly lease?: {
    readonly leaseId: string;
    readonly runId: string;
    readonly taskRequestId: string;
    readonly projectId: string;
  };
  readonly log: {
    readonly written: boolean;
    readonly id?: string;
  };
  readonly error?: string;
};

export async function runOnce(input: {
  readonly config: RunnerConfig;
  readonly broker: BrokerClient;
  readonly workspaceRoot: string;
  readonly logRoot: string;
  readonly taskRequestId?: string;
  readonly leaseMinutes?: number;
  readonly codexTimeoutMs?: number;
  readonly dependencies?: RunLoopDependencies;
}): Promise<RunOnceResult> {
  const dependencies = input.dependencies ?? {};
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const configuration = await input.broker.runnerConfiguration({
    runnerId: input.config.runnerId,
    runnerAuthTokenHash: input.config.runnerAuthTokenHash
  });
  const capacity = await checkCapacity({
    config: input.config,
    policy: configuration.policy,
    dependencies
  });

  if (!capacity.ok) {
    const log = await writeRunLog(input.logRoot, {
      type: "run-once",
      status: "skipped",
      startedAt,
      completedAt: now().toISOString(),
      runnerId: input.config.runnerId,
      capacity
    });

    return {
      ok: true,
      command: "run-once",
      status: "skipped",
      capacity,
      log
    };
  }

  const eligibleTask = await input.broker.eligibleTask({
    runnerId: input.config.runnerId,
    runnerAuthTokenHash: input.config.runnerAuthTokenHash,
    now: startedAt,
    taskRequestId: input.taskRequestId
  });

  if (eligibleTask === null) {
    const log = await writeRunLog(input.logRoot, {
      type: "run-once",
      status: "idle",
      startedAt,
      completedAt: now().toISOString(),
      runnerId: input.config.runnerId,
      capacity
    });

    return {
      ok: true,
      command: "run-once",
      status: "idle",
      capacity,
      log
    };
  }

  const lease = await input.broker.leaseEligibleTask({
    runnerId: input.config.runnerId,
    runnerAuthTokenHash: input.config.runnerAuthTokenHash,
    leaseId: createEntityId("lease"),
    runId: createEntityId("run"),
    leaseTokenHash: contentHash(randomUUID()),
    now: startedAt,
    expiresAt: new Date(
      Date.parse(startedAt) + (input.leaseMinutes ?? defaultLeaseMinutes) * 60_000
    ).toISOString(),
    taskRequestId: eligibleTask.id
  });

  if (lease === null) {
    const log = await writeRunLog(input.logRoot, {
      type: "run-once",
      status: "idle",
      startedAt,
      completedAt: now().toISOString(),
      runnerId: input.config.runnerId,
      capacity
    });

    return {
      ok: true,
      command: "run-once",
      status: "idle",
      capacity,
      log
    };
  }

  const leaseSummary = leaseSummaryView(lease);

  try {
    const workspace = await ensureCleanWorkspace({
      workspaceRoot: input.workspaceRoot,
      task: lease.task,
      dependencies
    });
    const codexStartedAt = now().toISOString();
    const structuredOutputPath = join(
      input.logRoot,
      "structured-output",
      `${lease.lease.runId}.json`
    );

    await mkdir(dirname(structuredOutputPath), { recursive: true });

    const codex = await (dependencies.runCodexExec ?? runCodexExec)({
      codexBin: input.config.codexBin,
      prompt: buildCodexPrompt(lease.task),
      cwd: workspace.path,
      timeoutMs: input.codexTimeoutMs ?? defaultCodexTimeoutMs,
      outputSchema:
        lease.task.outputSchema === undefined
          ? undefined
          : { schema: lease.task.outputSchema },
      structuredOutputPath,
      sandbox: "read-only",
      config: {
        "shell_environment_policy.inherit": "none"
      }
    });
    const completedAt = now().toISOString();
    const resultPackage = completedResultPackage({
      lease,
      codex,
      workspace,
      startedAt: codexStartedAt,
      completedAt,
      identityVisibility: configuration.policy?.privacy.identityVisibility ?? "anonymous",
      shareCodexVersion: configuration.policy?.privacy.shareCodexVersion ?? false
    });

    await input.broker.completeRun({
      runnerId: input.config.runnerId,
      runnerAuthTokenHash: input.config.runnerAuthTokenHash,
      resultPackage,
      now: completedAt
    });

    const log = await writeRunLog(input.logRoot, {
      type: "run-once",
      status: "completed",
      startedAt,
      completedAt,
      runnerId: input.config.runnerId,
      lease: leaseSummary,
      capacity,
      codex: {
        codexCliVersion: codex.codexCliVersion,
        usage: codex.usage,
        eventCount: codex.events.length,
        exitCode: codex.exitCode
      },
      resultPackageId: resultPackage.resultPackageId
    });

    return {
      ok: true,
      command: "run-once",
      status: "completed",
      capacity,
      lease: leaseSummary,
      log
    };
  } catch (error) {
    const completedAt = now().toISOString();
    const resultPackage = failedResultPackage({
      lease,
      error,
      startedAt,
      completedAt,
      identityVisibility: configuration.policy?.privacy.identityVisibility ?? "anonymous"
    });
    let uploadError: string | undefined;

    try {
      await input.broker.failRun({
        runnerId: input.config.runnerId,
        runnerAuthTokenHash: input.config.runnerAuthTokenHash,
        resultPackage,
        now: completedAt
      });
    } catch (failureUploadError) {
      uploadError = sanitizeError(failureUploadError);
    }

    const sanitizedError = sanitizeError(error);
    const log = await writeRunLog(input.logRoot, {
      type: "run-once",
      status: "failed",
      startedAt,
      completedAt,
      runnerId: input.config.runnerId,
      lease: leaseSummary,
      capacity,
      error: sanitizedError,
      failureUploadError: uploadError,
      resultPackageId: resultPackage.resultPackageId
    });

    return {
      ok: uploadError === undefined,
      command: "run-once",
      status: "failed",
      capacity,
      lease: leaseSummary,
      log,
      error: uploadError ?? sanitizedError
    };
  }
}

export async function checkCapacity(input: {
  readonly config: Pick<RunnerConfig, "codexBin">;
  readonly policy: VolunteerPolicy | null;
  readonly dependencies?: Pick<
    RunLoopDependencies,
    "readCodexAccountState" | "readCodexRateLimits"
  >;
}): Promise<CapacityDecision> {
  const reasons: string[] = [];
  const policy = input.policy;
  let account: CodexAccountState | undefined;
  let rateLimits: CodexRateLimitState | undefined;

  if (policy === null) {
    reasons.push("policy_missing");
  } else if (!policy.enabled) {
    reasons.push("policy_disabled");
  } else if (policy.review.requireBeforeUpload) {
    reasons.push("upload_review_required");
  } else if (policy.capacity.maxRunsPerDay <= 0) {
    reasons.push("daily_capacity_exhausted");
  }

  try {
    account = await (input.dependencies?.readCodexAccountState ?? readCodexAccountState)({
      codexBin: input.config.codexBin
    });
  } catch {
    reasons.push("codex_account_unavailable");
  }

  if (account !== undefined) {
    if (!account.authenticated || account.requiresOpenaiAuth === true) {
      reasons.push("codex_not_authenticated");
    }
  }

  try {
    rateLimits = await (input.dependencies?.readCodexRateLimits ?? readCodexRateLimits)({
      codexBin: input.config.codexBin
    });
  } catch {
    reasons.push("codex_rate_limits_unavailable");
  }

  if (policy !== null && rateLimits !== undefined) {
    for (const limit of rateLimits.rateLimits) {
      if (
        limit.usedPercent >= policy.capacity.maxUsedPercent &&
        !resetsSoon(limit.resetsAt, policy.capacity.onlyIfResetsWithinMinutes)
      ) {
        reasons.push("codex_rate_limit_exceeded");
        break;
      }
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    codexCliVersion: account?.codexCliVersion ?? rateLimits?.codexCliVersion
  };
}

export function defaultRunnerStatePath(
  kind: "workspaces" | "logs",
  env: NodeJS.ProcessEnv = process.env
): string {
  const base =
    env.OSS_CAPACITY_RUNNER_STATE_HOME ??
    env.XDG_STATE_HOME ??
    (platform() === "win32" && env.LOCALAPPDATA
      ? join(env.LOCALAPPDATA, "oss-capacity")
      : join(homedir(), ".local", "state", "oss-capacity"));

  return join(base, kind);
}

async function writeRunLog(
  logRoot: string,
  value: Record<string, unknown>
): Promise<{ readonly written: boolean; readonly id?: string }> {
  const id = `${new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "-")}-${randomUUID()}`;
  const path = join(logRoot, `${id}.json`);
  const sanitized = JSON.parse(sanitizeText(JSON.stringify(value))) as unknown;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(sanitized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(path, 0o600);

  return { written: true, id };
}

function completedResultPackage(input: {
  readonly lease: RunnerLeaseView;
  readonly codex: CodexExecResult;
  readonly workspace: WorkspaceCheckout;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly identityVisibility: ResultPackage["volunteerVisibility"];
  readonly shareCodexVersion: boolean;
}): ResultPackage {
  const structuredOutput =
    input.codex.structuredOutput?.json !== undefined &&
    isJsonObject(input.codex.structuredOutput.json)
      ? input.codex.structuredOutput.json
      : undefined;
  const summary =
    summaryFromStructuredOutput(structuredOutput) ??
    input.codex.finalMessage?.slice(0, 8_000) ??
    "Codex completed the read-only task.";

  return parseResultPackage({
    ...baseResultPackage(input),
    runStatus: "completed",
    repositoryCommitSha: input.workspace.repositoryCommitSha,
    codexCliVersion: input.shareCodexVersion
      ? input.codex.codexCliVersion
      : undefined,
    usage: input.codex.usage,
    summary,
    structuredOutput,
    commandSummaries: [
      {
        command: "codex exec --json --ephemeral --sandbox read-only",
        exitCode: input.codex.exitCode,
        durationMs: Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt)),
        summary: `Codex emitted ${input.codex.events.length} JSON event(s).`
      }
    ],
    artifacts: [],
    warnings:
      input.codex.structuredOutput?.json !== undefined && structuredOutput === undefined
        ? ["Structured output was not a JSON object and was omitted."]
        : []
  });
}

function failedResultPackage(input: {
  readonly lease: RunnerLeaseView;
  readonly error: unknown;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly identityVisibility: ResultPackage["volunteerVisibility"];
}): ResultPackage {
  return parseResultPackage({
    ...baseResultPackage(input),
    runStatus: "failed",
    commandSummaries: [],
    artifacts: [],
    warnings: [],
    error: errorResult(input.error)
  });
}

function baseResultPackage(input: {
  readonly lease: RunnerLeaseView;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly identityVisibility: ResultPackage["volunteerVisibility"];
}) {
  return {
    resultPackageId: createEntityId("result"),
    runId: input.lease.lease.runId,
    taskRequestId: input.lease.task.id,
    leaseId: input.lease.lease.leaseId,
    projectId: input.lease.task.projectId,
    runnerId: input.lease.lease.runnerId,
    runStatus: "failed",
    taskSnapshotHash: input.lease.lease.taskSnapshotHash,
    promptHash: contentHash(input.lease.task.prompt),
    sandbox: "read-only",
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    resultVisibility: input.lease.task.reporting.visibility,
    volunteerVisibility: input.identityVisibility
  };
}

function errorResult(error: unknown): ResultPackage["error"] {
  if (error instanceof CodexClientError || error instanceof CodexExecError) {
    const codexError = error as CodexClientError | CodexExecError;

    return {
      code: codexError.code,
      message: sanitizeError(codexError),
      retryable: codexError.retryable
    };
  }

  return {
    code: "runner_error",
    message: sanitizeError(error),
    retryable: false
  };
}

function buildCodexPrompt(task: TaskRequest): string {
  return [
    "You are running a read-only OSS Capacity task.",
    "Do not edit files, create commits, push branches, open pull requests, or post publicly.",
    "",
    `Task: ${task.title}`,
    task.description === undefined ? undefined : `Description: ${task.description}`,
    `Repository: ${task.repository.fullName}`,
    task.target.ref === undefined ? undefined : `Target ref: ${task.target.ref}`,
    "",
    task.prompt
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function leaseSummaryView(lease: RunnerLeaseView) {
  return {
    leaseId: lease.lease.leaseId,
    runId: lease.lease.runId,
    taskRequestId: lease.task.id,
    projectId: lease.task.projectId
  };
}

function contentHash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function createEntityId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function resetsSoon(resetsAt: string | undefined, minutes: number): boolean {
  if (resetsAt === undefined) {
    return false;
  }

  const resetAtMs = Date.parse(resetsAt);

  return (
    !Number.isNaN(resetAtMs) &&
    resetAtMs <= Date.now() + minutes * 60_000
  );
}

function summaryFromStructuredOutput(output: JsonObject | undefined): string | undefined {
  const summary = output?.summary;

  return typeof summary === "string" && summary.trim().length > 0
    ? summary.slice(0, 8_000)
    : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
