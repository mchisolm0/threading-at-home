import type {
  JsonObject,
  JsonValue,
  ResultPackage,
  RunnerCapabilityKey,
  TaskRequest,
  TaskSize
} from "./contracts.js";

export type SafetyIssue = {
  readonly path: string;
  readonly code: string;
  readonly message: string;
};

export type TaskSizeCap = {
  readonly promptMaxChars: number;
  readonly outputSchemaMaxChars: number;
  readonly maxRuns: number;
};

export type RateLimitSnapshot = {
  readonly projectActiveTaskCount?: number;
  readonly projectTasksCreatedToday?: number;
  readonly projectRunsLeasedToday?: number;
  readonly volunteerRunsLeasedToday?: number;
  readonly volunteerMaxRunsPerDay?: number;
};

export const privateBetaTaskSizeCaps = {
  small: {
    promptMaxChars: 4_000,
    outputSchemaMaxChars: 6_000,
    maxRuns: 3
  },
  medium: {
    promptMaxChars: 8_000,
    outputSchemaMaxChars: 9_000,
    maxRuns: 2
  },
  large: {
    promptMaxChars: 12_000,
    outputSchemaMaxChars: 12_000,
    maxRuns: 1
  }
} satisfies Record<TaskSize, TaskSizeCap>;

export const privateBetaRateLimits = {
  projectActiveTasks: 20,
  projectTasksCreatedPerDay: 25,
  projectRunsLeasedPerDay: 50,
  volunteerRunsLeasedPerDay: 25
} as const;

export const privateBetaAllowedCapabilities = [
  "codex.exec.json",
  "codex.exec.output_schema",
  "codex.app_server.rate_limits",
  "codex.version_detection",
  "sandbox.read_only",
  "sandbox.workspace_write",
  "network.disabled",
  "patch.capture",
  "command.summary"
] as const satisfies readonly RunnerCapabilityKey[];

const allowedCapabilitySet = new Set<RunnerCapabilityKey>(
  privateBetaAllowedCapabilities
);

const unsafePromptRules = [
  {
    code: "public_posting_request",
    pattern:
      /\b(?:post|publish|comment|reply|announce|send)\b.{0,48}\b(?:github|issue|pr|pull request|discussion|slack|discord|twitter|x\.com|public)\b/i,
    message: "Private beta tasks cannot ask Codex to post publicly."
  },
  {
    code: "patch_or_write_request",
    pattern:
      /\b(?:edit|modify|write|rewrite|change|patch|diff|commit|branch|push|merge|open a pr|pull request|create files?|delete files?)\b/i,
    message: "Private beta tasks must be read-only and cannot ask for writes or patches."
  },
  {
    code: "repository_publish_request",
    pattern:
      /\b(?:commit|branch|push|merge|open a pr|open pull request|create pull request|pull request)\b/i,
    message: "Patch proposal tasks cannot ask Codex to publish, push, branch, merge, or open pull requests."
  },
  {
    code: "credential_request",
    pattern:
      /\b(?:credential|secret|token|api key|apikey|password|ssh key|private key|oauth|cookie|session)\b/i,
    message: "Tasks cannot request credentials, tokens, cookies, or secrets."
  },
  {
    code: "shell_execution_request",
    pattern:
      /\b(?:run|execute|spawn|invoke)\b.{0,32}\b(?:shell|script|command|bash|zsh|sh|python|node|npm|pnpm|curl|wget|docker)\b|```(?:sh|bash|zsh|python|js|ts|javascript|typescript)/i,
    message: "Private beta tasks cannot ask Codex to run shell commands or scripts."
  },
  {
    code: "network_request",
    pattern:
      /\b(?:fetch|download|upload|call|request|scrape|crawl|open)\b.{0,40}\b(?:http|https|url|website|endpoint|api|internet|network)\b/i,
    message: "Private beta tasks cannot require network access."
  },
  {
    code: "local_secret_path_request",
    pattern:
      /(?:\/Users\/|\/home\/|~\/|\\Users\\).{0,80}\b(?:\.codex|\.ssh|\.config|key|token|secret|credential|auth)\b/i,
    message: "Tasks cannot ask for volunteer-local secrets or auth paths."
  }
] as const;

const redactionRules = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\bsha256:[a-f0-9]{64}\b/gi,
  /\b(?:setup[-_ ]?token|runner[-_ ]?auth[-_ ]?hash|runner[-_ ]?auth[-_ ]?token)\s*[:=]\s*[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:access|refresh|id|api|session)?[-_ ]?token\s*[:=]\s*[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:sk|rk|pk|ocr)_[A-Za-z0-9._-]{12,}\b/g,
  /\bsk-[A-Za-z0-9._-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /(^|[\s'"])(\/(?:Users|home|tmp|var|private)\/[^ "'\n]*(?:\.codex|\.ssh|\.config|key|token|secret|credential|auth)[^ "'\n]*)/gi,
  /\\Users\\[^ "'\n]*(?:\.codex|\.ssh|key|token|secret|credential|auth)[^ "'\n]*/gi,
  /(^|[\s'"])(\/(?:Users|home|tmp|var|private)\/[^ "'\n]+)/gi,
  /\\Users\\[^ "'\n]+/gi
] as const;

function issue(path: string, code: string, message: string): SafetyIssue {
  return { path, code, message };
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

export function lintTaskPrompt(prompt: string): readonly SafetyIssue[] {
  const issues: SafetyIssue[] = [];
  const lintablePrompt = prompt.replace(
    /\b(?:do not|don't|must not|never|without)\b[^.!\n]*(?:edit|modify|write|patch|commit|branch|push|post|publish|comment|run|execute|credential|secret|token|network)[^.!\n]*/gi,
    ""
  );

  for (const rule of unsafePromptRules) {
    if (rule.pattern.test(lintablePrompt)) {
      issues.push(issue("prompt", rule.code, rule.message));
    }
  }

  return issues;
}

export function validatePrivateBetaTaskRequest(
  task: TaskRequest
): readonly SafetyIssue[] {
  const issues: SafetyIssue[] = [];
  const sizeCap = privateBetaTaskSizeCaps[task.expectedSize];
  const isPatchProposal =
    task.type === "patch_proposal" &&
    task.permissions.sandbox === "workspace-write" &&
    task.permissions.allowPatches;

  issues.push(
    ...lintTaskPrompt(task.prompt).filter(
      (promptIssue) =>
        promptIssue.code !== "patch_or_write_request" || !isPatchProposal
    )
  );

  if (
    (task.type === "patch_proposal" &&
      task.permissions.sandbox !== "workspace-write") ||
    (task.type !== "patch_proposal" && task.permissions.sandbox !== "read-only")
  ) {
    issues.push(
      issue(
        "permissions.sandbox",
        "unsupported_sandbox",
        task.type === "patch_proposal"
          ? "Patch proposal tasks must use workspace-write sandbox."
          : "Only read-only sandbox is enabled for non-patch private beta tasks."
      )
    );
  }

  if (task.permissions.network) {
    issues.push(
      issue("permissions.network", "network_not_allowed", "Network-enabled tasks are not enabled for private beta.")
    );
  }

  if (
    (task.type === "patch_proposal" && !task.permissions.allowPatches) ||
    (task.type !== "patch_proposal" && task.permissions.allowPatches)
  ) {
    issues.push(
      issue(
        "permissions.allowPatches",
        "patch_permission_mismatch",
        task.type === "patch_proposal"
          ? "Patch proposal tasks must request patch capture."
          : "Only patch proposal tasks can request patch capture."
      )
    );
  }

  if (task.permissions.publicPosting !== "maintainer_only") {
    issues.push(
      issue("permissions.publicPosting", "public_posting_not_allowed", "Public posting must stay maintainer-only.")
    );
  }

  if (task.reporting.destination !== "maintainer_inbox") {
    issues.push(
      issue("reporting.destination", "unsupported_destination", "Results must go to the maintainer inbox.")
    );
  }

  if (task.reporting.visibility !== "maintainer_only") {
    issues.push(
      issue("reporting.visibility", "unsupported_visibility", "Private beta results must be maintainer-only.")
    );
  }

  if (task.type === "patch_proposal") {
    if (!task.requiredCapabilities.includes("sandbox.workspace_write")) {
      issues.push(
        issue(
          "requiredCapabilities",
          "missing_workspace_write_capability",
          "Patch proposal tasks must require workspace-write sandbox capability."
        )
      );
    }

    if (!task.requiredCapabilities.includes("patch.capture")) {
      issues.push(
        issue(
          "requiredCapabilities",
          "missing_patch_capture_capability",
          "Patch proposal tasks must require patch capture capability."
        )
      );
    }
  } else if (task.requiredCapabilities.includes("patch.capture")) {
    issues.push(
      issue(
        "requiredCapabilities",
        "patch_capture_without_patch_task",
        "Patch capture capability is limited to patch proposal tasks."
      )
    );
  }

  if (!task.requiredCapabilities.includes("codex.exec.json")) {
    issues.push(
      issue("requiredCapabilities", "missing_codex_exec", "Tasks must require Codex JSON execution.")
    );
  }

  if (
    task.outputSchema !== undefined &&
    !task.requiredCapabilities.includes("codex.exec.output_schema")
  ) {
    issues.push(
      issue("requiredCapabilities", "missing_output_schema_capability", "Tasks with output schemas must require the output-schema capability.")
    );
  }

  for (const capability of task.requiredCapabilities) {
    if (!allowedCapabilitySet.has(capability)) {
      issues.push(
        issue(
          "requiredCapabilities",
          "unsupported_capability",
          `Capability ${capability} is not enabled for private beta.`
        )
      );
    }
  }

  if (task.prompt.length > sizeCap.promptMaxChars) {
    issues.push(
      issue(
        "prompt",
        "prompt_too_large",
        `Prompt exceeds the ${task.expectedSize} task cap of ${sizeCap.promptMaxChars} characters.`
      )
    );
  }

  if (
    task.outputSchema !== undefined &&
    serializedLength(task.outputSchema) > sizeCap.outputSchemaMaxChars
  ) {
    issues.push(
      issue(
        "outputSchema",
        "output_schema_too_large",
        `Output schema exceeds the ${task.expectedSize} task cap of ${sizeCap.outputSchemaMaxChars} serialized characters.`
      )
    );
  }

  if (task.maxRuns > sizeCap.maxRuns) {
    issues.push(
      issue(
        "maxRuns",
        "max_runs_too_large",
        `${task.expectedSize} private beta tasks can request at most ${sizeCap.maxRuns} run(s).`
      )
    );
  }

  return issues;
}

export function validatePrivateBetaRateLimits(
  snapshot: RateLimitSnapshot
): readonly SafetyIssue[] {
  const issues: SafetyIssue[] = [];

  if (
    snapshot.projectActiveTaskCount !== undefined &&
    snapshot.projectActiveTaskCount >= privateBetaRateLimits.projectActiveTasks
  ) {
    issues.push(
      issue("projectId", "project_active_task_limit", "Project active task limit reached.")
    );
  }

  if (
    snapshot.projectTasksCreatedToday !== undefined &&
    snapshot.projectTasksCreatedToday >= privateBetaRateLimits.projectTasksCreatedPerDay
  ) {
    issues.push(
      issue("projectId", "project_task_create_limit", "Project daily task creation limit reached.")
    );
  }

  if (
    snapshot.projectRunsLeasedToday !== undefined &&
    snapshot.projectRunsLeasedToday >= privateBetaRateLimits.projectRunsLeasedPerDay
  ) {
    issues.push(
      issue("projectId", "project_run_limit", "Project daily runner lease limit reached.")
    );
  }

  const volunteerCap = Math.min(
    snapshot.volunteerMaxRunsPerDay ?? privateBetaRateLimits.volunteerRunsLeasedPerDay,
    privateBetaRateLimits.volunteerRunsLeasedPerDay
  );

  if (
    snapshot.volunteerRunsLeasedToday !== undefined &&
    snapshot.volunteerRunsLeasedToday >= volunteerCap
  ) {
    issues.push(
      issue("volunteerUserId", "volunteer_run_limit", "Volunteer daily runner lease limit reached.")
    );
  }

  return issues;
}

export function assertNoSafetyIssues(issues: readonly SafetyIssue[]): void {
  if (issues.length === 0) {
    return;
  }

  throw new Error(issues.map((item) => item.message).join(" "));
}

export function redactSensitiveText(value: string): string {
  return redactionRules.reduce(
    (current, pattern) =>
      current.replace(pattern, (match, ...args: unknown[]) => {
        const firstCapture =
          typeof args[0] === "string" ? (args[0] as string) : undefined;
        const replacement =
          /(?:^|[\s'"])\/(?:Users|home|tmp|var|private)\//i.test(match) ||
          /\\Users\\/i.test(match)
            ? "[redacted-path]"
            : "[redacted]";

        return firstCapture === undefined
          ? replacement
          : `${firstCapture}${replacement}`;
      }),
    value
  );
}

export function redactSensitiveJson(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveJson(item));
  }

  if (value !== null && typeof value === "object") {
    const redacted: Record<string, JsonValue> = {};

    for (const [key, item] of Object.entries(value)) {
      redacted[redactSensitiveText(key)] = redactSensitiveJson(item);
    }

    return redacted;
  }

  return value;
}

export function redactResultPackage(resultPackage: ResultPackage): ResultPackage {
  return {
    ...resultPackage,
    summary:
      resultPackage.summary === undefined
        ? undefined
        : redactSensitiveText(resultPackage.summary),
    structuredOutput:
      resultPackage.structuredOutput === undefined
        ? undefined
        : (redactSensitiveJson(resultPackage.structuredOutput) as JsonObject),
    commandSummaries: resultPackage.commandSummaries.map((command) => ({
      ...command,
      command: redactSensitiveText(command.command),
      summary: redactSensitiveText(command.summary)
    })),
    patchArtifact:
      resultPackage.patchArtifact === undefined
        ? undefined
        : {
            ...resultPackage.patchArtifact,
            changedFiles: resultPackage.patchArtifact.changedFiles.map((file) => ({
              ...file,
              path: redactSensitiveText(file.path),
              oldPath:
                file.oldPath === undefined
                  ? undefined
                  : redactSensitiveText(file.oldPath)
            })),
            diff: redactSensitiveText(resultPackage.patchArtifact.diff)
          },
    warnings: resultPackage.warnings.map((warning) => redactSensitiveText(warning)),
    error:
      resultPackage.error === undefined
        ? undefined
        : {
            ...resultPackage.error,
            message: redactSensitiveText(resultPackage.error.message)
          }
  };
}
