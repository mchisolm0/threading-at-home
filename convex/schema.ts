import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const jsonValue = v.any();

const repository = v.object({
  owner: v.string(),
  name: v.string(),
  fullName: v.string(),
  defaultBranch: v.optional(v.string())
});

const taskTarget = v.object({
  ref: v.optional(v.string()),
  issueQuery: v.optional(v.string()),
  issueUrls: v.optional(v.array(v.string())),
  pullRequestUrls: v.optional(v.array(v.string())),
  paths: v.optional(v.array(v.string()))
});

const taskPermissions = v.object({
  sandbox: v.string(),
  network: v.boolean(),
  allowPatches: v.boolean(),
  publicPosting: v.string()
});

const taskReporting = v.object({
  destination: v.string(),
  visibility: v.string()
});

const codexUsage = v.object({
  inputTokens: v.optional(v.number()),
  cachedInputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  reasoningOutputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number())
});

const resultCommandSummary = v.object({
  command: v.string(),
  exitCode: v.number(),
  durationMs: v.number(),
  summary: v.string()
});

const resultArtifact = v.object({
  kind: v.string(),
  storageKey: v.string(),
  sha256: v.string(),
  byteLength: v.number(),
  mediaType: v.optional(v.string())
});

const resultError = v.object({
  code: v.string(),
  message: v.string(),
  retryable: v.boolean()
});

export default defineSchema({
  users: defineTable({
    userId: v.string(),
    githubUserId: v.optional(v.string()),
    githubLogin: v.optional(v.string()),
    displayName: v.optional(v.string()),
    email: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string()
  })
    .index("by_user_id", ["userId"])
    .index("by_github_user_id", ["githubUserId"])
    .index("by_github_login", ["githubLogin"]),

  projects: defineTable({
    projectId: v.string(),
    repository,
    createdByUserId: v.string(),
    githubInstallationId: v.optional(v.string()),
    status: v.string(),
    createdAt: v.string(),
    updatedAt: v.string()
  })
    .index("by_project_id", ["projectId"])
    .index("by_created_by", ["createdByUserId"])
    .index("by_github_installation", ["githubInstallationId"]),

  githubInstallations: defineTable({
    installationId: v.string(),
    accountLogin: v.string(),
    accountType: v.string(),
    installedByUserId: v.optional(v.string()),
    repositoryFullNames: v.array(v.string()),
    status: v.string(),
    createdAt: v.string(),
    updatedAt: v.string()
  })
    .index("by_installation_id", ["installationId"])
    .index("by_account_login", ["accountLogin"]),

  taskRequests: defineTable({
    id: v.string(),
    projectId: v.string(),
    createdByUserId: v.string(),
    status: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    type: v.string(),
    priority: v.string(),
    expectedSize: v.string(),
    repository,
    target: taskTarget,
    permissions: taskPermissions,
    prompt: v.string(),
    outputSchema: v.optional(jsonValue),
    reporting: taskReporting,
    requiredCapabilities: v.array(v.string()),
    maxRuns: v.number(),
    createdAt: v.string(),
    updatedAt: v.string(),
    expiresAt: v.optional(v.string())
  })
    .index("by_id", ["id"])
    .index("by_project_status", ["projectId", "status"])
    .index("by_status", ["status"])
    .index("by_created_by", ["createdByUserId"]),

  runnerRegistrations: defineTable({
    runnerId: v.string(),
    volunteerUserId: v.string(),
    displayName: v.optional(v.string()),
    platform: v.string(),
    architecture: v.string(),
    codexCliVersion: v.optional(v.string()),
    codexAuthMode: v.string(),
    supportedSandboxModes: v.array(v.string()),
    supportsNetwork: v.boolean(),
    supportsPatchCapture: v.boolean(),
    supportedTaskTypes: v.array(v.string()),
    supportedCapabilities: v.array(v.string()),
    maxOutputBytes: v.number(),
    registeredAt: v.string(),
    lastSeenAt: v.string()
  })
    .index("by_runner_id", ["runnerId"])
    .index("by_volunteer", ["volunteerUserId"]),

  volunteerProjectSubscriptions: defineTable({
    volunteerUserId: v.string(),
    projectId: v.string(),
    enabled: v.boolean(),
    taskTypeAllowlist: v.array(v.string()),
    maxSandbox: v.string(),
    allowNetwork: v.boolean(),
    allowPatches: v.boolean(),
    createdAt: v.string(),
    updatedAt: v.string()
  })
    .index("by_volunteer_project", ["volunteerUserId", "projectId"])
    .index("by_project_enabled", ["projectId", "enabled"])
    .index("by_volunteer_enabled", ["volunteerUserId", "enabled"]),

  taskLeases: defineTable({
    leaseId: v.string(),
    runId: v.string(),
    taskRequestId: v.string(),
    projectId: v.string(),
    runnerId: v.string(),
    volunteerUserId: v.string(),
    status: v.string(),
    attempt: v.number(),
    taskSnapshotHash: v.string(),
    leaseTokenHash: v.string(),
    leasedAt: v.string(),
    expiresAt: v.string(),
    heartbeatAt: v.optional(v.string()),
    releasedAt: v.optional(v.string())
  })
    .index("by_lease_id", ["leaseId"])
    .index("by_run_id", ["runId"])
    .index("by_task_status", ["taskRequestId", "status"])
    .index("by_runner_status", ["runnerId", "status"])
    .index("by_status_expires_at", ["status", "expiresAt"]),

  runs: defineTable({
    runId: v.string(),
    taskRequestId: v.string(),
    projectId: v.string(),
    leaseId: v.optional(v.string()),
    runnerId: v.optional(v.string()),
    volunteerUserId: v.optional(v.string()),
    status: v.string(),
    attempt: v.number(),
    taskSnapshotHash: v.optional(v.string()),
    startedAt: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string()
  })
    .index("by_run_id", ["runId"])
    .index("by_task", ["taskRequestId"])
    .index("by_task_status", ["taskRequestId", "status"])
    .index("by_lease_id", ["leaseId"])
    .index("by_runner_status", ["runnerId", "status"])
    .index("by_status_updated_at", ["status", "updatedAt"]),

  resultPackages: defineTable({
    resultPackageId: v.string(),
    runId: v.string(),
    taskRequestId: v.string(),
    leaseId: v.string(),
    projectId: v.string(),
    runnerId: v.optional(v.string()),
    volunteerUserId: v.optional(v.string()),
    runStatus: v.string(),
    taskSnapshotHash: v.string(),
    promptHash: v.string(),
    repositoryCommitSha: v.optional(v.string()),
    codexCliVersion: v.optional(v.string()),
    sandbox: v.string(),
    startedAt: v.string(),
    completedAt: v.string(),
    usage: v.optional(codexUsage),
    summary: v.optional(v.string()),
    structuredOutput: v.optional(jsonValue),
    commandSummaries: v.array(resultCommandSummary),
    artifacts: v.array(resultArtifact),
    warnings: v.array(v.string()),
    error: v.optional(resultError),
    resultVisibility: v.string(),
    volunteerVisibility: v.string()
  })
    .index("by_result_package_id", ["resultPackageId"])
    .index("by_run_id", ["runId"])
    .index("by_task", ["taskRequestId"])
    .index("by_project", ["projectId"]),

  auditEvents: defineTable({
    eventType: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    projectId: v.optional(v.string()),
    taskRequestId: v.optional(v.string()),
    runId: v.optional(v.string()),
    leaseId: v.optional(v.string()),
    actorUserId: v.optional(v.string()),
    runnerId: v.optional(v.string()),
    occurredAt: v.string(),
    metadata: v.optional(jsonValue)
  })
    .index("by_entity", ["entityType", "entityId"])
    .index("by_task", ["taskRequestId"])
    .index("by_project", ["projectId"])
    .index("by_occurred_at", ["occurredAt"])
});
