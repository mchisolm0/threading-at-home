import {
  redactResultPackage,
  redactSensitiveText
} from "./safety.js";
import type { ResultPackage, TaskRequest } from "./contracts.js";

export const githubPromotionTargetKinds = [
  "issue_comment",
  "new_issue",
  "patch_pull_request"
] as const;

export const githubPromotionAttributionModes = [
  "app",
  "app_with_anonymous_run"
] as const;

export type GitHubPromotionTargetKind =
  (typeof githubPromotionTargetKinds)[number];

export type GitHubPromotionAttributionMode =
  (typeof githubPromotionAttributionModes)[number];

export type GitHubPromotionTarget =
  | {
      readonly kind: "issue_comment";
      readonly issueNumber: number;
    }
  | {
      readonly kind: "new_issue";
      readonly title: string;
    }
  | {
      readonly kind: "patch_pull_request";
      readonly disabledReason: string;
    };

export type GitHubPromotionSourceMetadata = {
  readonly projectId: string;
  readonly taskRequestId: string;
  readonly runId: string;
  readonly resultPackageId: string;
  readonly completedAt: string;
  readonly repositoryCommitSha?: string;
};

export type GitHubPromotionPreview = {
  readonly targetKind: "issue_comment" | "new_issue" | "patch_pull_request";
  readonly targetRepository: string;
  readonly targetIssueNumber?: number;
  readonly targetIssueTitle?: string;
  readonly title?: string;
  readonly body: string;
  readonly attributionMode: GitHubPromotionAttributionMode;
  readonly attributionText: string;
  readonly source: GitHubPromotionSourceMetadata;
  readonly redaction: {
    readonly applied: true;
    readonly source: "stored_result_package_and_promotion_builder";
  };
  readonly disabledReason?: string;
};

export type BuildGitHubPromotionPreviewInput = {
  readonly repositoryFullName: string;
  readonly task: TaskRequest;
  readonly resultPackage: ResultPackage;
  readonly target: GitHubPromotionTarget;
  readonly attributionMode: GitHubPromotionAttributionMode;
  readonly visibleRunnerId?: string;
};

const maxGitHubBodyLength = 60_000;

function truncateMarkdown(value: string, maxLength = maxGitHubBodyLength): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 80).trimEnd()}\n\n_Result truncated before posting because it exceeded the safe preview size._`;
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function validateAttributionMode(mode: GitHubPromotionAttributionMode): void {
  if (!githubPromotionAttributionModes.includes(mode)) {
    throw new Error("Unsupported GitHub promotion attribution mode");
  }
}

export function normalizeGitHubPromotionTarget(
  target: GitHubPromotionTarget
): GitHubPromotionTarget {
  if (target.kind === "issue_comment") {
    if (
      !Number.isInteger(target.issueNumber) ||
      target.issueNumber < 1 ||
      target.issueNumber > 1_000_000_000
    ) {
      throw new Error("GitHub issue comment promotion requires a positive issue number");
    }

    return target;
  }

  if (target.kind === "new_issue") {
    const title = redactSensitiveText(target.title).trim();

    if (title.length < 1 || title.length > 256) {
      throw new Error("GitHub issue promotion title must be 1-256 characters");
    }

    return {
      kind: "new_issue",
      title
    };
  }

  if (target.kind === "patch_pull_request") {
    return {
      kind: "patch_pull_request",
      disabledReason:
        target.disabledReason ||
        "Patch pull request promotion is reserved for Task 7.2 patch artifacts."
    };
  }

  throw new Error("Unsupported GitHub promotion target");
}

function attributionText(input: {
  readonly mode: GitHubPromotionAttributionMode;
  readonly resultPackage: ResultPackage;
  readonly visibleRunnerId?: string;
}): string {
  validateAttributionMode(input.mode);

  if (input.mode === "app") {
    return "Posted by OSS Capacity on maintainer request.";
  }

  const metadata = [
    `volunteer visibility: ${input.resultPackage.volunteerVisibility}`,
    `run: ${input.resultPackage.runId}`
  ];

  if (
    input.resultPackage.volunteerVisibility !== "anonymous" &&
    input.visibleRunnerId !== undefined
  ) {
    metadata.push(`runner: ${input.visibleRunnerId}`);
  }

  return `Posted by OSS Capacity on maintainer request (${metadata.join("; ")}).`;
}

function markdownBody(input: {
  readonly repositoryFullName: string;
  readonly task: TaskRequest;
  readonly resultPackage: ResultPackage;
  readonly target: Extract<GitHubPromotionTarget, { kind: "issue_comment" | "new_issue" }>;
  readonly attribution: string;
}): string {
  const targetLabel =
    input.target.kind === "issue_comment"
      ? `${input.repositoryFullName}#${input.target.issueNumber}`
      : `${input.repositoryFullName} new issue: ${input.target.title}`;
  const lines = [
    `## OSS Capacity result: ${redactSensitiveText(input.task.title)}`,
    "",
    input.attribution,
    "",
    "### Promotion target",
    "",
    `- Repository: \`${input.repositoryFullName}\``,
    `- Target: \`${targetLabel}\``,
    "",
    "### Summary",
    "",
    input.resultPackage.summary ?? "_No summary returned._"
  ];

  if (input.resultPackage.structuredOutput !== undefined) {
    lines.push("", "### Structured output", "", fencedJson(input.resultPackage.structuredOutput));
  }

  if (input.resultPackage.commandSummaries.length > 0) {
    lines.push("", "### Command summaries", "");

    for (const command of input.resultPackage.commandSummaries) {
      lines.push(
        `- \`${command.command}\` exited ${command.exitCode} in ${command.durationMs}ms: ${command.summary}`
      );
    }
  }

  if (input.resultPackage.warnings.length > 0) {
    lines.push("", "### Warnings", "");

    for (const warning of input.resultPackage.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (input.resultPackage.error !== undefined) {
    lines.push(
      "",
      "### Error",
      "",
      `\`${input.resultPackage.error.code}\`: ${input.resultPackage.error.message}`
    );
  }

  lines.push(
    "",
    "### Source",
    "",
    `- Project: \`${input.resultPackage.projectId}\``,
    `- Task: \`${input.resultPackage.taskRequestId}\``,
    `- Run: \`${input.resultPackage.runId}\``,
    `- Result package: \`${input.resultPackage.resultPackageId}\``,
    `- Completed: \`${input.resultPackage.completedAt}\``
  );

  if (input.resultPackage.repositoryCommitSha !== undefined) {
    lines.push(`- Commit: \`${input.resultPackage.repositoryCommitSha}\``);
  }

  lines.push("", "_Redaction was applied before this preview was generated._");

  return truncateMarkdown(lines.join("\n"));
}

export function buildGitHubPromotionPreview(
  input: BuildGitHubPromotionPreviewInput
): GitHubPromotionPreview {
  const target = normalizeGitHubPromotionTarget(input.target);
  const resultPackage = redactResultPackage(input.resultPackage);
  const attribution = attributionText({
    mode: input.attributionMode,
    resultPackage,
    visibleRunnerId: input.visibleRunnerId
  });
  const source = {
    projectId: resultPackage.projectId,
    taskRequestId: resultPackage.taskRequestId,
    runId: resultPackage.runId,
    resultPackageId: resultPackage.resultPackageId,
    completedAt: resultPackage.completedAt,
    repositoryCommitSha: resultPackage.repositoryCommitSha
  } satisfies GitHubPromotionSourceMetadata;

  if (target.kind === "patch_pull_request") {
    return {
      targetKind: target.kind,
      targetRepository: input.repositoryFullName,
      body: "",
      attributionMode: input.attributionMode,
      attributionText: attribution,
      source,
      redaction: {
        applied: true,
        source: "stored_result_package_and_promotion_builder"
      },
      disabledReason: target.disabledReason
    };
  }

  const body = markdownBody({
    repositoryFullName: input.repositoryFullName,
    task: input.task,
    resultPackage,
    target,
    attribution
  });

  return {
    targetKind: target.kind,
    targetRepository: input.repositoryFullName,
    targetIssueNumber:
      target.kind === "issue_comment" ? target.issueNumber : undefined,
    targetIssueTitle: target.kind === "new_issue" ? target.title : undefined,
    title: target.kind === "new_issue" ? target.title : undefined,
    body,
    attributionMode: input.attributionMode,
    attributionText: attribution,
    source,
    redaction: {
      applied: true,
      source: "stored_result_package_and_promotion_builder"
    }
  };
}
