import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export const taskRequestStatuses = [
  "draft",
  "active",
  "paused",
  "archived",
  "expired"
] as const;

export const taskRunStatuses = [
  "queued",
  "leased",
  "running",
  "completed",
  "failed",
  "canceled",
  "expired"
] as const;

export const taskLeaseStatuses = [
  "active",
  "released",
  "completed",
  "expired",
  "revoked"
] as const;

export const taskTypes = [
  "analysis",
  "triage",
  "patch_proposal",
  "test_investigation",
  "docs_draft",
  "security_review",
  "dependency_review"
] as const;

export const taskPriorities = ["low", "normal", "high", "urgent"] as const;
export const taskSizes = ["small", "medium", "large"] as const;
export const sandboxModes = [
  "read-only",
  "workspace-write",
  "danger-full-access"
] as const;
export const publicPostingModes = [
  "maintainer_only",
  "volunteer_approved",
  "automatic"
] as const;
export const resultDestinations = ["maintainer_inbox"] as const;
export const resultVisibilityModes = [
  "maintainer_only",
  "project_maintainers",
  "public"
] as const;
export const identityVisibilityModes = [
  "anonymous",
  "display_name",
  "github_identity"
] as const;
export const runnerPlatforms = ["darwin", "linux", "win32", "unknown"] as const;
export const runnerArchitectures = ["arm64", "x64", "unknown"] as const;
export const codexAuthModes = ["chatgpt", "api_key", "unknown"] as const;

const utcDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const projectKeyPattern =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const entityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const gitRefPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const contentHashPattern = /^sha256:[a-f0-9]{64}$/;
const gitCommitShaPattern = /^[a-f0-9]{40}$/;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const isoDateTimeSchema = z
  .string()
  .regex(utcDateTimePattern, "Expected an ISO 8601 UTC date-time string");

export const entityIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(entityIdPattern, "Expected a stable non-empty identifier");

export const projectKeySchema = z
  .string()
  .min(3)
  .max(160)
  .regex(projectKeyPattern, "Expected a GitHub repository key like owner/repo");

export const contentHashSchema = z
  .string()
  .regex(contentHashPattern, "Expected a sha256:<64 hex chars> content hash");

export const gitCommitShaSchema = z
  .string()
  .regex(gitCommitShaPattern, "Expected a 40 character git commit SHA");

export const taskRequestStatusSchema = z.enum(taskRequestStatuses);
export const taskRunStatusSchema = z.enum(taskRunStatuses);
export const taskLeaseStatusSchema = z.enum(taskLeaseStatuses);
export const taskTypeSchema = z.enum(taskTypes);
export const taskPrioritySchema = z.enum(taskPriorities);
export const taskSizeSchema = z.enum(taskSizes);
export const sandboxModeSchema = z.enum(sandboxModes);
export const publicPostingModeSchema = z.enum(publicPostingModes);
export const resultDestinationSchema = z.enum(resultDestinations);
export const resultVisibilityModeSchema = z.enum(resultVisibilityModes);
export const identityVisibilityModeSchema = z.enum(identityVisibilityModes);
export const runnerPlatformSchema = z.enum(runnerPlatforms);
export const runnerArchitectureSchema = z.enum(runnerArchitectures);
export const codexAuthModeSchema = z.enum(codexAuthModes);

export const gitRepositorySchema = z
  .object({
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    fullName: projectKeySchema,
    defaultBranch: z.string().min(1).max(255).optional()
  })
  .strict()
  .refine((repo) => repo.fullName === `${repo.owner}/${repo.name}`, {
    message: "fullName must match owner/name",
    path: ["fullName"]
  });

export const taskTargetSchema = z
  .object({
    ref: z.string().regex(gitRefPattern).optional(),
    issueQuery: z.string().min(1).max(500).optional(),
    issueUrls: z.array(z.string().url()).max(50).optional(),
    pullRequestUrls: z.array(z.string().url()).max(50).optional(),
    paths: z.array(z.string().min(1).max(500)).max(200).optional()
  })
  .strict();

export const taskPermissionsSchema = z
  .object({
    sandbox: sandboxModeSchema,
    network: z.boolean(),
    allowPatches: z.boolean(),
    publicPosting: publicPostingModeSchema
  })
  .strict();

export const taskReportingSchema = z
  .object({
    destination: resultDestinationSchema,
    visibility: resultVisibilityModeSchema
  })
  .strict();

export const taskRequestSchema = z
  .object({
    id: entityIdSchema,
    projectId: projectKeySchema,
    createdByUserId: entityIdSchema,
    status: taskRequestStatusSchema,
    title: z.string().min(1).max(160),
    description: z.string().max(2_000).optional(),
    type: taskTypeSchema,
    priority: taskPrioritySchema,
    expectedSize: taskSizeSchema,
    repository: gitRepositorySchema,
    target: taskTargetSchema,
    permissions: taskPermissionsSchema,
    prompt: z.string().min(1).max(40_000),
    outputSchema: jsonObjectSchema.optional(),
    reporting: taskReportingSchema,
    requiredCapabilities: z.array(z.string().min(1).max(80)).max(25),
    maxRuns: z.number().int().min(1).max(100),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema.optional()
  })
  .strict()
  .refine((task) => task.projectId === task.repository.fullName, {
    message: "projectId must match repository.fullName",
    path: ["projectId"]
  });

export const volunteerCapacityPolicySchema = z
  .object({
    maxUsedPercent: z.number().int().min(0).max(100),
    onlyIfResetsWithinMinutes: z.number().int().min(1).max(30 * 24 * 60),
    maxRunsPerDay: z.number().int().min(0).max(1_000),
    maxEstimatedSize: taskSizeSchema
  })
  .strict();

export const volunteerPermissionsPolicySchema = z
  .object({
    maxSandbox: sandboxModeSchema,
    allowNetwork: z.boolean(),
    allowPatches: z.boolean()
  })
  .strict();

export const volunteerReviewPolicySchema = z
  .object({
    requireBeforeUpload: z.boolean(),
    requireBeforePublicPosting: z.boolean()
  })
  .strict();

export const volunteerPrivacyPolicySchema = z
  .object({
    identityVisibility: identityVisibilityModeSchema,
    shareCodexVersion: z.boolean(),
    shareRunnerPlatform: z.boolean()
  })
  .strict();

export const volunteerPolicySchema = z
  .object({
    volunteerUserId: entityIdSchema,
    enabled: z.boolean(),
    projectAllowlist: z.array(projectKeySchema).max(500),
    taskTypeAllowlist: z.array(taskTypeSchema).max(taskTypes.length),
    capacity: volunteerCapacityPolicySchema,
    permissions: volunteerPermissionsPolicySchema,
    review: volunteerReviewPolicySchema,
    privacy: volunteerPrivacyPolicySchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();

export const runnerCapabilitySchema = z
  .object({
    runnerId: entityIdSchema,
    volunteerUserId: entityIdSchema,
    displayName: z.string().min(1).max(120).optional(),
    platform: runnerPlatformSchema,
    architecture: runnerArchitectureSchema,
    codexCliVersion: z.string().min(1).max(120).optional(),
    codexAuthMode: codexAuthModeSchema,
    supportedSandboxModes: z.array(sandboxModeSchema).min(1).max(sandboxModes.length),
    supportsNetwork: z.boolean(),
    supportsPatchCapture: z.boolean(),
    supportedTaskTypes: z.array(taskTypeSchema).min(1).max(taskTypes.length),
    maxOutputBytes: z.number().int().min(1).max(100 * 1024 * 1024),
    registeredAt: isoDateTimeSchema,
    lastSeenAt: isoDateTimeSchema
  })
  .strict();

export const taskLeaseSchema = z
  .object({
    leaseId: entityIdSchema,
    runId: entityIdSchema,
    taskRequestId: entityIdSchema,
    projectId: projectKeySchema,
    runnerId: entityIdSchema,
    volunteerUserId: entityIdSchema,
    status: taskLeaseStatusSchema,
    attempt: z.number().int().min(1).max(100),
    taskSnapshotHash: contentHashSchema,
    leaseTokenHash: contentHashSchema,
    leasedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    heartbeatAt: isoDateTimeSchema.optional(),
    releasedAt: isoDateTimeSchema.optional()
  })
  .strict();

export const codexUsageSchema = z
  .object({
    inputTokens: z.number().int().min(0).optional(),
    cachedInputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    reasoningOutputTokens: z.number().int().min(0).optional(),
    totalTokens: z.number().int().min(0).optional()
  })
  .strict();

export const resultArtifactSchema = z
  .object({
    kind: z.enum([
      "structured_output",
      "log",
      "patch",
      "diff",
      "transcript",
      "command_summary"
    ]),
    storageKey: z.string().min(1).max(500),
    sha256: contentHashSchema,
    byteLength: z.number().int().min(0),
    mediaType: z.string().min(1).max(120).optional()
  })
  .strict();

export const resultCommandSummarySchema = z
  .object({
    command: z.string().min(1).max(1_000),
    exitCode: z.number().int(),
    durationMs: z.number().int().min(0),
    summary: z.string().min(1).max(4_000)
  })
  .strict();

export const resultErrorSchema = z
  .object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(4_000),
    retryable: z.boolean()
  })
  .strict();

export const resultPackageSchema = z
  .object({
    resultPackageId: entityIdSchema,
    runId: entityIdSchema,
    taskRequestId: entityIdSchema,
    leaseId: entityIdSchema,
    projectId: projectKeySchema,
    runnerId: entityIdSchema.optional(),
    volunteerUserId: entityIdSchema.optional(),
    runStatus: taskRunStatusSchema,
    taskSnapshotHash: contentHashSchema,
    promptHash: contentHashSchema,
    repositoryCommitSha: gitCommitShaSchema.optional(),
    codexCliVersion: z.string().min(1).max(120).optional(),
    sandbox: sandboxModeSchema,
    startedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.optional(),
    usage: codexUsageSchema.optional(),
    summary: z.string().min(1).max(8_000).optional(),
    structuredOutput: jsonObjectSchema.optional(),
    commandSummaries: z.array(resultCommandSummarySchema).max(100),
    artifacts: z.array(resultArtifactSchema).max(100),
    warnings: z.array(z.string().min(1).max(2_000)).max(100),
    error: resultErrorSchema.optional(),
    resultVisibility: resultVisibilityModeSchema,
    volunteerVisibility: identityVisibilityModeSchema
  })
  .strict();

export type IsoDateTimeString = z.infer<typeof isoDateTimeSchema>;
export type ProjectKey = z.infer<typeof projectKeySchema>;
export type ContentHash = z.infer<typeof contentHashSchema>;
export type GitRepository = z.infer<typeof gitRepositorySchema>;
export type TaskRequestStatus = z.infer<typeof taskRequestStatusSchema>;
export type TaskRunStatus = z.infer<typeof taskRunStatusSchema>;
export type TaskLeaseStatus = z.infer<typeof taskLeaseStatusSchema>;
export type TaskType = z.infer<typeof taskTypeSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskSize = z.infer<typeof taskSizeSchema>;
export type SandboxMode = z.infer<typeof sandboxModeSchema>;
export type PublicPostingMode = z.infer<typeof publicPostingModeSchema>;
export type ResultVisibilityMode = z.infer<typeof resultVisibilityModeSchema>;
export type IdentityVisibilityMode = z.infer<typeof identityVisibilityModeSchema>;
export type TaskRequest = z.infer<typeof taskRequestSchema>;
export type VolunteerPolicy = z.infer<typeof volunteerPolicySchema>;
export type RunnerCapability = z.infer<typeof runnerCapabilitySchema>;
export type TaskLease = z.infer<typeof taskLeaseSchema>;
export type ResultPackage = z.infer<typeof resultPackageSchema>;

export type ValidationIssue = {
  readonly path: string;
  readonly code: string;
  readonly message: string;
};

export type ValidationResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly issues: readonly ValidationIssue[] };

export function validateWithSchema<T>(
  schema: z.ZodType<T>,
  value: unknown
): ValidationResult<T> {
  const result = schema.safeParse(value);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: issue.code,
      message: issue.message
    }))
  };
}

export function parseTaskRequest(value: unknown): TaskRequest {
  return taskRequestSchema.parse(value);
}

export function validateTaskRequest(value: unknown): ValidationResult<TaskRequest> {
  return validateWithSchema(taskRequestSchema, value);
}

export function parseVolunteerPolicy(value: unknown): VolunteerPolicy {
  return volunteerPolicySchema.parse(value);
}

export function validateVolunteerPolicy(
  value: unknown
): ValidationResult<VolunteerPolicy> {
  return validateWithSchema(volunteerPolicySchema, value);
}

export function parseRunnerCapability(value: unknown): RunnerCapability {
  return runnerCapabilitySchema.parse(value);
}

export function validateRunnerCapability(
  value: unknown
): ValidationResult<RunnerCapability> {
  return validateWithSchema(runnerCapabilitySchema, value);
}

export function parseTaskLease(value: unknown): TaskLease {
  return taskLeaseSchema.parse(value);
}

export function validateTaskLease(value: unknown): ValidationResult<TaskLease> {
  return validateWithSchema(taskLeaseSchema, value);
}

export function parseResultPackage(value: unknown): ResultPackage {
  return resultPackageSchema.parse(value);
}

export function validateResultPackage(value: unknown): ValidationResult<ResultPackage> {
  return validateWithSchema(resultPackageSchema, value);
}
