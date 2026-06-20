import {
  taskSizes,
  taskTypes,
  type IdentityVisibilityMode,
  type SandboxMode,
  type TaskSize,
  type TaskType,
  type VolunteerPolicy,
  validateVolunteerPolicy
} from "@oss-capacity/core";

import type { Viewer, VolunteerProjectView } from "../convexApi";

export type VolunteerPolicyFormState = {
  readonly enabled: boolean;
  readonly projectAllowlist: readonly string[];
  readonly taskTypeAllowlist: readonly TaskType[];
  readonly maxUsedPercent: string;
  readonly onlyIfResetsWithinMinutes: string;
  readonly maxRunsPerDay: string;
  readonly maxEstimatedSize: TaskSize;
  readonly maxSandbox: SandboxMode;
  readonly allowNetwork: boolean;
  readonly allowPatches: boolean;
  readonly requireBeforeUpload: boolean;
  readonly requireBeforePublicPosting: boolean;
  readonly identityVisibility: IdentityVisibilityMode;
  readonly shareCodexVersion: boolean;
  readonly shareRunnerPlatform: boolean;
};

export type VolunteerPolicyIssue = {
  readonly field: string;
  readonly message: string;
};

export type BuildVolunteerPolicyResult =
  | {
      readonly success: true;
      readonly policy: VolunteerPolicy;
    }
  | {
      readonly success: false;
      readonly issues: readonly VolunteerPolicyIssue[];
    };

export function initialVolunteerPolicyForm(
  policy: VolunteerPolicy | null,
  projects: readonly VolunteerProjectView[]
): VolunteerPolicyFormState {
  if (policy !== null) {
    return {
      enabled: policy.enabled,
      projectAllowlist: policy.projectAllowlist,
      taskTypeAllowlist: policy.taskTypeAllowlist,
      maxUsedPercent: String(policy.capacity.maxUsedPercent),
      onlyIfResetsWithinMinutes: String(policy.capacity.onlyIfResetsWithinMinutes),
      maxRunsPerDay: String(policy.capacity.maxRunsPerDay),
      maxEstimatedSize: policy.capacity.maxEstimatedSize,
      maxSandbox: policy.permissions.maxSandbox,
      allowNetwork: policy.permissions.allowNetwork,
      allowPatches: policy.permissions.allowPatches,
      requireBeforeUpload: policy.review.requireBeforeUpload,
      requireBeforePublicPosting: policy.review.requireBeforePublicPosting,
      identityVisibility: policy.privacy.identityVisibility,
      shareCodexVersion: policy.privacy.shareCodexVersion,
      shareRunnerPlatform: policy.privacy.shareRunnerPlatform
    };
  }

  return {
    enabled: false,
    projectAllowlist: projects.map((project) => project.projectId),
    taskTypeAllowlist: ["analysis", "triage", "docs_draft"],
    maxUsedPercent: "55",
    onlyIfResetsWithinMinutes: "180",
    maxRunsPerDay: "3",
    maxEstimatedSize: taskSizes[0],
    maxSandbox: "read-only",
    allowNetwork: false,
    allowPatches: false,
    requireBeforeUpload: true,
    requireBeforePublicPosting: true,
    identityVisibility: "anonymous",
    shareCodexVersion: true,
    shareRunnerPlatform: false
  };
}

export function toggleListValue<T extends string>(
  values: readonly T[],
  value: T,
  enabled: boolean
): T[] {
  if (enabled) {
    return values.includes(value) ? [...values] : [...values, value];
  }

  return values.filter((item) => item !== value);
}

function intField(value: string, field: string, label: string): number | VolunteerPolicyIssue {
  const normalized = value.trim();
  const parsed = Number(normalized);

  if (normalized.length === 0 || !Number.isInteger(parsed)) {
    return { field, message: `${label} must be a whole number.` };
  }

  return parsed;
}

function issuePathToField(path: string): string {
  const [head] = path.split(".");

  return head.length > 0 ? head : "policy";
}

export function buildVolunteerPolicy(input: {
  readonly form: VolunteerPolicyFormState;
  readonly viewer: Viewer;
  readonly projects: readonly VolunteerProjectView[];
  readonly existingPolicy?: VolunteerPolicy | null;
  readonly now?: Date;
}): BuildVolunteerPolicyResult {
  const issues: VolunteerPolicyIssue[] = [];
  const projectIds = new Set(input.projects.map((project) => project.projectId));
  const projectAllowlist = input.form.projectAllowlist.filter((projectId) =>
    projectIds.has(projectId)
  );

  if (input.form.projectAllowlist.length !== projectAllowlist.length) {
    issues.push({
      field: "projectAllowlist",
      message: "Project allowlist contains unavailable projects."
    });
  }

  if (input.form.taskTypeAllowlist.length === 0) {
    issues.push({
      field: "taskTypeAllowlist",
      message: "Choose at least one task type."
    });
  }

  const maxUsedPercent = intField(
    input.form.maxUsedPercent,
    "maxUsedPercent",
    "Max used percent"
  );
  const onlyIfResetsWithinMinutes = intField(
    input.form.onlyIfResetsWithinMinutes,
    "onlyIfResetsWithinMinutes",
    "Reset window"
  );
  const maxRunsPerDay = intField(
    input.form.maxRunsPerDay,
    "maxRunsPerDay",
    "Daily runs"
  );

  for (const parsed of [maxUsedPercent, onlyIfResetsWithinMinutes, maxRunsPerDay]) {
    if (typeof parsed !== "number") {
      issues.push(parsed);
    }
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  const now = input.now ?? new Date();
  const createdAt = input.existingPolicy?.createdAt ?? now.toISOString();
  const policy = {
    volunteerUserId: input.viewer.userId,
    enabled: input.form.enabled,
    projectAllowlist,
    taskTypeAllowlist: taskTypes.filter((type) =>
      input.form.taskTypeAllowlist.includes(type)
    ),
    capacity: {
      maxUsedPercent: maxUsedPercent as number,
      onlyIfResetsWithinMinutes: onlyIfResetsWithinMinutes as number,
      maxRunsPerDay: maxRunsPerDay as number,
      maxEstimatedSize: input.form.maxEstimatedSize
    },
    permissions: {
      maxSandbox: input.form.maxSandbox,
      allowNetwork: input.form.allowNetwork,
      allowPatches: input.form.allowPatches
    },
    review: {
      requireBeforeUpload: input.form.requireBeforeUpload,
      requireBeforePublicPosting: input.form.requireBeforePublicPosting
    },
    privacy: {
      identityVisibility: input.form.identityVisibility,
      shareCodexVersion: input.form.shareCodexVersion,
      shareRunnerPlatform: input.form.shareRunnerPlatform
    },
    createdAt,
    updatedAt: now.toISOString()
  } satisfies VolunteerPolicy;
  const validation = validateVolunteerPolicy(policy);

  if (!validation.success) {
    return {
      success: false,
      issues: validation.issues.map((issue) => ({
        field: issuePathToField(issue.path),
        message: issue.message
      }))
    };
  }

  return { success: true, policy: validation.data };
}
