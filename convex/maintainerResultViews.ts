import type { ResultPackage } from "@oss-capacity/core";

export type MaintainerRunInput = {
  readonly runId: string;
  readonly taskRequestId: string;
  readonly projectId: string;
  readonly leaseId?: string;
  readonly runnerId?: string;
  readonly status: string;
  readonly attempt: number;
  readonly taskSnapshotHash?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type MaintainerRunView = MaintainerRunInput;

export type MaintainerResultPackage = Omit<
  ResultPackage,
  "runnerId" | "volunteerUserId"
> & {
  readonly runnerId?: string;
};

export type MaintainerResultListPackage = Pick<
  MaintainerResultPackage,
  | "resultPackageId"
  | "runId"
  | "taskRequestId"
  | "projectId"
  | "runnerId"
  | "runStatus"
  | "startedAt"
  | "completedAt"
  | "summary"
  | "volunteerVisibility"
> & {
  readonly commandCount: number;
  readonly commandDurationMs: number;
  readonly artifactCount: number;
  readonly warningCount: number;
};

export function maintainerResultPackageView(
  resultPackage: ResultPackage
): MaintainerResultPackage {
  const { runnerId, volunteerUserId: _volunteerUserId, ...packageView } = resultPackage;
  void _volunteerUserId;

  return {
    ...packageView,
    runnerId: resultPackage.volunteerVisibility === "anonymous" ? undefined : runnerId
  };
}

export function maintainerResultListPackageView(
  resultPackage: MaintainerResultPackage
): MaintainerResultListPackage {
  return {
    resultPackageId: resultPackage.resultPackageId,
    runId: resultPackage.runId,
    taskRequestId: resultPackage.taskRequestId,
    projectId: resultPackage.projectId,
    runnerId: resultPackage.runnerId,
    runStatus: resultPackage.runStatus,
    startedAt: resultPackage.startedAt,
    completedAt: resultPackage.completedAt,
    summary: resultPackage.summary,
    volunteerVisibility: resultPackage.volunteerVisibility,
    commandCount: resultPackage.commandSummaries.length,
    commandDurationMs: resultPackage.commandSummaries.reduce(
      (total, command) => total + command.durationMs,
      0
    ),
    artifactCount: resultPackage.artifacts.length,
    warningCount: resultPackage.warnings.length
  };
}

export function maintainerRunView(
  run: MaintainerRunInput,
  resultPackage: ResultPackage
): MaintainerRunView {
  return {
    ...run,
    runnerId: resultPackage.volunteerVisibility === "anonymous" ? undefined : run.runnerId
  };
}
