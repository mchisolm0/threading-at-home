import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

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

const taskExecutionCommand = v.object({
  name: v.string(),
  argv: v.array(v.string()),
  timeoutMs: v.optional(v.number())
});

const taskExecutionArtifact = v.object({
  path: v.string(),
  kind: v.string(),
  maxBytes: v.optional(v.number()),
  mediaType: v.optional(v.string())
});

const taskExecution = v.object({
  isolation: v.string(),
  image: v.string(),
  network: v.boolean(),
  allowHosts: v.optional(v.array(v.string())),
  commands: v.array(taskExecutionCommand),
  artifacts: v.optional(v.array(taskExecutionArtifact)),
  timeoutMs: v.optional(v.number()),
  maxOutputBytes: v.optional(v.number())
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

const patchChangedFile = v.object({
  path: v.string(),
  oldPath: v.optional(v.string()),
  status: v.string(),
  additions: v.optional(v.number()),
  deletions: v.optional(v.number())
});

const patchArtifact = v.object({
  kind: v.string(),
  baseCommitSha: v.optional(v.string()),
  sha256: v.string(),
  byteLength: v.number(),
  truncated: v.boolean(),
  fileCount: v.number(),
  changedFiles: v.array(patchChangedFile),
  diff: v.string(),
  approvalStatus: v.string()
});

const resultError = v.object({
  code: v.string(),
  message: v.string(),
  retryable: v.boolean()
});

export default defineSchema({
  ...authTables,

  users: defineTable({
    userId: v.string(),
    githubUserId: v.optional(v.string()),
    githubLogin: v.optional(v.string()),
    displayName: v.optional(v.string()),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    createdAt: v.string(),
    updatedAt: v.string()
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
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
    .index("by_status", ["status"])
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
    .index("by_account_login", ["accountLogin"])
    .index("by_installed_user_status", ["installedByUserId", "status"]),

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
    execution: v.optional(taskExecution),
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
    runnerAuthTokenHash: v.optional(v.string()),
    status: v.optional(v.string()),
    revokedAt: v.optional(v.string()),
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
    .index("by_volunteer", ["volunteerUserId"])
    .index("by_volunteer_project", ["volunteerUserId", "projectId"])
    .index("by_project_enabled", ["projectId", "enabled"])
    .index("by_volunteer_enabled", ["volunteerUserId", "enabled"]),

  volunteerPolicies: defineTable({
    volunteerUserId: v.string(),
    enabled: v.boolean(),
    projectAllowlist: v.array(v.string()),
    taskTypeAllowlist: v.array(v.string()),
    capacity: v.object({
      maxUsedPercent: v.number(),
      onlyIfResetsWithinMinutes: v.number(),
      maxRunsPerDay: v.number(),
      maxEstimatedSize: v.string()
    }),
    permissions: v.object({
      maxSandbox: v.string(),
      allowNetwork: v.boolean(),
      allowPatches: v.boolean()
    }),
    review: v.object({
      requireBeforeUpload: v.boolean(),
      requireBeforePublicPosting: v.boolean()
    }),
    privacy: v.object({
      identityVisibility: v.string(),
      shareCodexVersion: v.boolean(),
      shareRunnerPlatform: v.boolean()
    }),
    createdAt: v.string(),
    updatedAt: v.string()
  }).index("by_volunteer", ["volunteerUserId"]),

  runnerSetupTokens: defineTable({
    tokenId: v.string(),
    volunteerUserId: v.string(),
    tokenHash: v.string(),
    label: v.optional(v.string()),
    status: v.string(),
    createdAt: v.string(),
    expiresAt: v.optional(v.string()),
    revokedAt: v.optional(v.string()),
    lastUsedAt: v.optional(v.string())
  })
    .index("by_token_id", ["tokenId"])
    .index("by_token_hash", ["tokenHash"])
    .index("by_volunteer", ["volunteerUserId"])
    .index("by_volunteer_status", ["volunteerUserId", "status"]),

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
    patchArtifact: v.optional(patchArtifact),
    warnings: v.array(v.string()),
    error: v.optional(resultError),
    resultVisibility: v.string(),
    volunteerVisibility: v.string()
  })
    .index("by_result_package_id", ["resultPackageId"])
    .index("by_run_id", ["runId"])
    .index("by_task", ["taskRequestId"])
    .index("by_project", ["projectId"])
    .index("by_project_completed_at", ["projectId", "completedAt"]),

  resultPromotions: defineTable({
    promotionId: v.string(),
    resultPackageId: v.string(),
    projectId: v.string(),
    taskRequestId: v.string(),
    runId: v.string(),
    actorUserId: v.string(),
    targetKind: v.string(),
    targetRepositoryFullName: v.string(),
    targetIssueNumber: v.optional(v.number()),
    targetIssueTitle: v.optional(v.string()),
    attributionMode: v.string(),
    previewTitle: v.optional(v.string()),
    previewBody: v.string(),
    status: v.string(),
    targetUrl: v.optional(v.string()),
    targetGitHubId: v.optional(v.string()),
    errorSummary: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
    postedAt: v.optional(v.string())
  })
    .index("by_promotion_id", ["promotionId"])
    .index("by_result_package", ["resultPackageId"])
    .index("by_project", ["projectId"])
    .index("by_actor", ["actorUserId"]),

  patchApprovals: defineTable({
    approvalId: v.string(),
    resultPackageId: v.string(),
    projectId: v.string(),
    taskRequestId: v.string(),
    runId: v.string(),
    actorUserId: v.string(),
    decision: v.string(),
    note: v.optional(v.string()),
    createdAt: v.string()
  })
    .index("by_approval_id", ["approvalId"])
    .index("by_result_package", ["resultPackageId"])
    .index("by_project", ["projectId"])
    .index("by_actor", ["actorUserId"]),

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
