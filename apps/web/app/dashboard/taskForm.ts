import {
  type GitRepository,
  type JsonObject,
  type PublicPostingMode,
  type ResultVisibilityMode,
  type RunnerCapabilityKey,
  type SandboxMode,
  type TaskPriority,
  type TaskRequest,
  type TaskSize,
  type TaskType,
  validatePrivateBetaTaskRequest,
  validateTaskRequest
} from "@oss-capacity/core";

import type { ProjectView, Viewer } from "../convexApi";

export type TaskFormState = {
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly type: TaskType;
  readonly priority: TaskPriority;
  readonly expectedSize: TaskSize;
  readonly targetRef: string;
  readonly issueQuery: string;
  readonly paths: string;
  readonly sandbox: SandboxMode;
  readonly network: boolean;
  readonly allowPatches: boolean;
  readonly publicPosting: PublicPostingMode;
  readonly resultVisibility: ResultVisibilityMode;
  readonly prompt: string;
  readonly outputSchema: string;
  readonly maxRuns: string;
  readonly expiresAtLocal: string;
};

export type FieldIssue = {
  readonly field: string;
  readonly message: string;
};

export type BuildTaskResult =
  | {
      readonly success: true;
      readonly task: TaskRequest;
    }
  | {
      readonly success: false;
      readonly issues: readonly FieldIssue[];
    };

export const defaultOutputSchema = JSON.stringify(
  {
    type: "object",
    required: ["summary", "risks"],
    properties: {
      summary: { type: "string" },
      risks: { type: "array", items: { type: "string" } }
    }
  },
  null,
  2
);

export function initialTaskForm(projectId = ""): TaskFormState {
  return {
    projectId,
    title: "",
    description: "",
    type: "analysis",
    priority: "normal",
    expectedSize: "small",
    targetRef: "",
    issueQuery: "",
    paths: "",
    sandbox: "read-only",
    network: false,
    allowPatches: false,
    publicPosting: "maintainer_only",
    resultVisibility: "maintainer_only",
    prompt: "",
    outputSchema: defaultOutputSchema,
    maxRuns: "3",
    expiresAtLocal: ""
  };
}

export function datetimeLocalToUtc(value: string): string | undefined {
  if (value.trim().length === 0) {
    return undefined;
  }

  const timestamp = Date.parse(value);

  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

export function utcToDatetimeLocal(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const offsetMs = date.getTimezoneOffset() * 60_000;

  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function splitLines(value: string): string[] | undefined {
  const items = value
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : undefined;
}

function taskId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "").slice(0, 10)
      : Math.random().toString(36).slice(2, 12);

  return `task-${Date.now().toString(36)}-${random}`;
}

function parseOutputSchema(value: string): {
  readonly outputSchema?: JsonObject;
  readonly issue?: FieldIssue;
} {
  if (value.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        issue: {
          field: "outputSchema",
          message: "Output schema must be a JSON object."
        }
      };
    }

    return { outputSchema: parsed as JsonObject };
  } catch {
    return {
      issue: {
        field: "outputSchema",
        message: "Output schema must be valid JSON."
      }
    };
  }
}

function requiredCapabilities(input: {
  readonly sandbox: SandboxMode;
  readonly network: boolean;
  readonly allowPatches: boolean;
  readonly hasOutputSchema: boolean;
}): RunnerCapabilityKey[] {
  const capabilities = new Set<RunnerCapabilityKey>(["codex.exec.json"]);

  if (input.hasOutputSchema) {
    capabilities.add("codex.exec.output_schema");
  }

  if (input.sandbox === "read-only") {
    capabilities.add("sandbox.read_only");
  }

  if (input.sandbox === "workspace-write") {
    capabilities.add("sandbox.workspace_write");
  }

  if (!input.network) {
    capabilities.add("network.disabled");
  }

  if (input.allowPatches) {
    capabilities.add("patch.capture");
  }

  return [...capabilities];
}

function issuePathToField(path: string): string {
  if (path === "permissions.sandbox") {
    return "sandbox";
  }

  if (path === "permissions.network") {
    return "network";
  }

  if (path === "permissions.allowPatches") {
    return "allowPatches";
  }

  if (path === "permissions.publicPosting") {
    return "publicPosting";
  }

  if (path === "reporting.visibility") {
    return "resultVisibility";
  }

  if (path === "reporting.destination" || path === "requiredCapabilities") {
    return "form";
  }

  const [head] = path.split(".");

  return head.length > 0 ? head : "form";
}

export function buildTaskRequest(input: {
  readonly form: TaskFormState;
  readonly viewer: Viewer;
  readonly projects: readonly ProjectView[];
  readonly now?: Date;
  readonly id?: string;
}): BuildTaskResult {
  const issues: FieldIssue[] = [];
  const project = input.projects.find(
    (candidate) => candidate.projectId === input.form.projectId
  );

  if (project === undefined) {
    issues.push({
      field: "projectId",
      message: "Choose a verified project."
    });
  } else if (project.status !== "verified") {
    issues.push({
      field: "projectId",
      message: "Project must be verified."
    });
  }

  const parsedMaxRuns = Number.parseInt(input.form.maxRuns, 10);

  if (!Number.isInteger(parsedMaxRuns)) {
    issues.push({
      field: "maxRuns",
      message: "Max runs must be a whole number."
    });
  }

  const schema = parseOutputSchema(input.form.outputSchema);

  if (schema.issue !== undefined) {
    issues.push(schema.issue);
  }

  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = datetimeLocalToUtc(input.form.expiresAtLocal);

  if (input.form.expiresAtLocal.trim().length > 0 && expiresAt === undefined) {
    issues.push({
      field: "expiresAtLocal",
      message: "Expiration must be a valid date and time."
    });
  }

  if (project === undefined || issues.length > 0) {
    return { success: false, issues };
  }

  const repository: GitRepository = project.repository;
  const task = {
    id: input.id ?? taskId(),
    projectId: project.projectId,
    createdByUserId: input.viewer.userId,
    status: "draft",
    title: input.form.title.trim(),
    description:
      input.form.description.trim().length > 0
        ? input.form.description.trim()
        : undefined,
    type: input.form.type,
    priority: input.form.priority,
    expectedSize: input.form.expectedSize,
    repository,
    target: {
      ref:
        input.form.targetRef.trim().length > 0
          ? input.form.targetRef.trim()
          : repository.defaultBranch,
      issueQuery:
        input.form.issueQuery.trim().length > 0
          ? input.form.issueQuery.trim()
          : undefined,
      paths: splitLines(input.form.paths)
    },
    permissions: {
      sandbox: input.form.sandbox,
      network: input.form.network,
      allowPatches: input.form.allowPatches,
      publicPosting: input.form.publicPosting
    },
    prompt: input.form.prompt.trim(),
    outputSchema: schema.outputSchema,
    reporting: {
      destination: "maintainer_inbox",
      visibility: input.form.resultVisibility
    },
    requiredCapabilities: requiredCapabilities({
      sandbox: input.form.sandbox,
      network: input.form.network,
      allowPatches: input.form.allowPatches,
      hasOutputSchema: schema.outputSchema !== undefined
    }),
    maxRuns: parsedMaxRuns,
    createdAt,
    updatedAt: createdAt,
    expiresAt
  } satisfies TaskRequest;
  const validation = validateTaskRequest(task);

  if (!validation.success) {
    return {
      success: false,
      issues: validation.issues.map((issue) => ({
        field: issuePathToField(issue.path),
        message: issue.message
      }))
    };
  }

  const safetyIssues = validatePrivateBetaTaskRequest(validation.data);

  if (safetyIssues.length > 0) {
    return {
      success: false,
      issues: safetyIssues.map((issue) => ({
        field: issuePathToField(issue.path),
        message: issue.message
      }))
    };
  }

  return { success: true, task: validation.data };
}
