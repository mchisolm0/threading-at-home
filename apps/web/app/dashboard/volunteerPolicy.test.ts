import { describe, expect, it } from "vitest";

import type { Viewer, VolunteerProjectView } from "../convexApi";
import {
  buildVolunteerPolicy,
  initialVolunteerPolicyForm,
  toggleListValue
} from "./volunteerPolicy";

const viewer = {
  userId: "user-volunteer-1",
  githubLogin: "volunteer",
  createdAt: "2026-06-18T12:00:00Z",
  updatedAt: "2026-06-18T12:00:00Z"
} satisfies Viewer;

const projects = [
  {
    projectId: "open-source/widgets",
    repository: {
      owner: "open-source",
      name: "widgets",
      fullName: "open-source/widgets",
      defaultBranch: "main"
    },
    status: "verified",
    createdAt: "2026-06-18T12:00:00Z",
    updatedAt: "2026-06-18T12:00:00Z"
  },
  {
    projectId: "tools/runner",
    repository: {
      owner: "tools",
      name: "runner",
      fullName: "tools/runner",
      defaultBranch: "main"
    },
    status: "verified",
    createdAt: "2026-06-18T12:00:00Z",
    updatedAt: "2026-06-18T12:00:00Z"
  }
] satisfies VolunteerProjectView[];

describe("volunteer policy builder", () => {
  it("builds a default policy for available projects", () => {
    const result = buildVolunteerPolicy({
      form: initialVolunteerPolicyForm(null, projects),
      viewer,
      projects,
      now: new Date("2026-06-18T12:00:00Z")
    });

    expect(result.success).toBe(true);
    expect(result.success ? result.policy : undefined).toMatchObject({
      volunteerUserId: viewer.userId,
      enabled: false,
      projectAllowlist: ["open-source/widgets", "tools/runner"],
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
      }
    });
  });

  it("rejects non-numeric capacity fields", () => {
    const result = buildVolunteerPolicy({
      form: {
        ...initialVolunteerPolicyForm(null, projects),
        maxRunsPerDay: "many"
      },
      viewer,
      projects,
      now: new Date("2026-06-18T12:00:00Z")
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toContainEqual({
      field: "maxRunsPerDay",
      message: "Daily runs must be a whole number."
    });
  });

  it("rejects decimal capacity fields", () => {
    const result = buildVolunteerPolicy({
      form: {
        ...initialVolunteerPolicyForm(null, projects),
        maxUsedPercent: "55.5"
      },
      viewer,
      projects,
      now: new Date("2026-06-18T12:00:00Z")
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toContainEqual({
      field: "maxUsedPercent",
      message: "Max used percent must be a whole number."
    });
  });

  it("rejects unavailable projects in the allowlist", () => {
    const result = buildVolunteerPolicy({
      form: {
        ...initialVolunteerPolicyForm(null, projects),
        projectAllowlist: ["open-source/widgets", "missing/repo"]
      },
      viewer,
      projects,
      now: new Date("2026-06-18T12:00:00Z")
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toContainEqual({
      field: "projectAllowlist",
      message: "Project allowlist contains unavailable projects."
    });
  });

  it("requires at least one task type", () => {
    const result = buildVolunteerPolicy({
      form: {
        ...initialVolunteerPolicyForm(null, projects),
        taskTypeAllowlist: []
      },
      viewer,
      projects,
      now: new Date("2026-06-18T12:00:00Z")
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toContainEqual({
      field: "taskTypeAllowlist",
      message: "Choose at least one task type."
    });
  });

  it("toggles list values predictably", () => {
    expect(toggleListValue(["analysis"], "triage", true)).toEqual([
      "analysis",
      "triage"
    ]);
    expect(toggleListValue(["analysis", "triage"], "triage", false)).toEqual([
      "analysis"
    ]);
  });
});
