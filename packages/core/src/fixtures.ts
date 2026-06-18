import type {
  ResultPackage,
  RunnerCapability,
  TaskLease,
  TaskRequest,
  VolunteerPolicy
} from "./contracts.js";

const now = "2026-06-18T12:00:00Z";
const later = "2026-06-18T12:30:00Z";
const tomorrow = "2026-06-19T12:00:00Z";
const taskSnapshotHash =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const promptHash =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const leaseTokenHash =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const artifactHash =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

export const exampleTaskRequest = {
  id: "weekly-issue-triage",
  projectId: "open-source/widgets",
  createdByUserId: "user-maintainer-1",
  status: "active",
  title: "Triage stale issues",
  description: "Group stale issues and suggest maintainer follow-up.",
  type: "triage",
  priority: "normal",
  expectedSize: "small",
  repository: {
    owner: "open-source",
    name: "widgets",
    fullName: "open-source/widgets",
    defaultBranch: "main"
  },
  target: {
    ref: "main",
    issueQuery: "is:open label:needs-triage"
  },
  permissions: {
    sandbox: "read-only",
    network: false,
    allowPatches: false,
    publicPosting: "maintainer_only"
  },
  prompt:
    "Review open issues labeled needs-triage, group them by subsystem, and suggest next maintainer actions. Do not edit files.",
  outputSchema: {
    type: "object",
    required: ["summary", "groups", "risks"],
    properties: {
      summary: { type: "string" },
      groups: {
        type: "array",
        items: {
          type: "object",
          required: ["label", "issues", "recommendation"],
          properties: {
            label: { type: "string" },
            issues: { type: "array", items: { type: "string" } },
            recommendation: { type: "string" }
          }
        }
      },
      risks: { type: "array", items: { type: "string" } }
    }
  },
  reporting: {
    destination: "maintainer_inbox",
    visibility: "maintainer_only"
  },
  requiredCapabilities: ["codex.exec.json", "codex.exec.output_schema"],
  maxRuns: 3,
  createdAt: now,
  updatedAt: now,
  expiresAt: tomorrow
} satisfies TaskRequest;

export const exampleVolunteerPolicy = {
  volunteerUserId: "user-volunteer-1",
  enabled: true,
  projectAllowlist: ["open-source/widgets"],
  taskTypeAllowlist: ["analysis", "triage", "docs_draft"],
  capacity: {
    maxUsedPercent: 55,
    onlyIfResetsWithinMinutes: 180,
    maxRunsPerDay: 3,
    maxEstimatedSize: "small"
  },
  permissions: {
    maxSandbox: "read-only",
    allowNetwork: false,
    allowPatches: false
  },
  review: {
    requireBeforeUpload: true,
    requireBeforePublicPosting: true
  },
  privacy: {
    identityVisibility: "anonymous",
    shareCodexVersion: true,
    shareRunnerPlatform: false
  },
  createdAt: now,
  updatedAt: now
} satisfies VolunteerPolicy;

export const exampleRunnerCapability = {
  runnerId: "runner-local-macbook",
  volunteerUserId: "user-volunteer-1",
  displayName: "Local MacBook",
  platform: "darwin",
  architecture: "arm64",
  codexCliVersion: "0.42.0",
  codexAuthMode: "chatgpt",
  supportedSandboxModes: ["read-only", "workspace-write"],
  supportsNetwork: false,
  supportsPatchCapture: true,
  supportedTaskTypes: ["analysis", "triage", "docs_draft", "test_investigation"],
  supportedCapabilities: [
    "codex.exec.json",
    "codex.exec.output_schema",
    "codex.app_server.rate_limits",
    "codex.version_detection",
    "sandbox.read_only",
    "sandbox.workspace_write",
    "network.disabled",
    "patch.capture",
    "command.summary"
  ],
  maxOutputBytes: 5 * 1024 * 1024,
  registeredAt: now,
  lastSeenAt: now
} satisfies RunnerCapability;

export const exampleTaskLease = {
  leaseId: "lease-weekly-issue-triage-1",
  runId: "run-weekly-issue-triage-1",
  taskRequestId: "weekly-issue-triage",
  projectId: "open-source/widgets",
  runnerId: "runner-local-macbook",
  volunteerUserId: "user-volunteer-1",
  status: "active",
  attempt: 1,
  taskSnapshotHash,
  leaseTokenHash,
  leasedAt: now,
  expiresAt: later,
  heartbeatAt: now
} satisfies TaskLease;

export const exampleResultPackage = {
  resultPackageId: "result-weekly-issue-triage-1",
  runId: "run-weekly-issue-triage-1",
  taskRequestId: "weekly-issue-triage",
  leaseId: "lease-weekly-issue-triage-1",
  projectId: "open-source/widgets",
  runnerId: "runner-local-macbook",
  volunteerUserId: "user-volunteer-1",
  runStatus: "completed",
  taskSnapshotHash,
  promptHash,
  repositoryCommitSha: "0123456789abcdef0123456789abcdef01234567",
  codexCliVersion: "0.42.0",
  sandbox: "read-only",
  startedAt: now,
  completedAt: later,
  usage: {
    inputTokens: 12_000,
    cachedInputTokens: 1_200,
    outputTokens: 1_500,
    reasoningOutputTokens: 400,
    totalTokens: 13_500
  },
  summary: "Grouped stale issues into three likely subsystems.",
  structuredOutput: {
    summary: "Three groups need maintainer review.",
    groups: [
      {
        label: "Build tooling",
        issues: ["#12", "#18"],
        recommendation: "Confirm whether the failures reproduce on main."
      }
    ],
    risks: ["Issue labels may be stale."]
  },
  commandSummaries: [],
  artifacts: [
    {
      kind: "structured_output",
      storageKey: "results/run-weekly-issue-triage-1/output.json",
      sha256: artifactHash,
      byteLength: 512,
      mediaType: "application/json"
    }
  ],
  warnings: ["No repository files were modified."],
  resultVisibility: "maintainer_only",
  volunteerVisibility: "anonymous"
} satisfies ResultPackage;
