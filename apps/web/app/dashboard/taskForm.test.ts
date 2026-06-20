import { describe, expect, it } from "vitest";

import { buildTaskRequest, initialTaskForm } from "./taskForm";
import type { ProjectView, Viewer } from "../convexApi";

const viewer = {
  userId: "user-maintainer-1",
  githubLogin: "maintainer",
  createdAt: "2026-06-18T12:00:00Z",
  updatedAt: "2026-06-18T12:00:00Z"
} satisfies Viewer;

const project = {
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
} satisfies ProjectView;

describe("maintainer task form builder", () => {
  it("builds a draft task request from valid form input", () => {
    const form = {
      ...initialTaskForm(project.projectId),
      title: "Triage stale issues",
      prompt: "Group stale issues and suggest next maintainer actions.",
      issueQuery: "is:open label:needs-triage"
    };
    const result = buildTaskRequest({
      form,
      viewer,
      projects: [project],
      now: new Date("2026-06-18T12:00:00Z"),
      id: "task-weekly-triage"
    });

    expect(result.success).toBe(true);
    expect(result.success ? result.task : undefined).toMatchObject({
      id: "task-weekly-triage",
      projectId: project.projectId,
      status: "draft",
      repository: project.repository,
      target: {
        ref: "main",
        issueQuery: "is:open label:needs-triage"
      }
    });
  });

  it("surfaces contract validation errors as field issues", () => {
    const result = buildTaskRequest({
      form: initialTaskForm(project.projectId),
      viewer,
      projects: [project],
      now: new Date("2026-06-18T12:00:00Z"),
      id: "task-empty"
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "title" }),
        expect.objectContaining({ field: "prompt" })
      ])
    );
  });

  it("rejects invalid output schema JSON before submit", () => {
    const form = {
      ...initialTaskForm(project.projectId),
      title: "Review docs",
      prompt: "Draft documentation updates.",
      outputSchema: "{"
    };
    const result = buildTaskRequest({
      form,
      viewer,
      projects: [project],
      now: new Date("2026-06-18T12:00:00Z"),
      id: "task-docs"
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toContainEqual({
      field: "outputSchema",
      message: "Output schema must be valid JSON."
    });
  });

  it("rejects projects that are no longer verified", () => {
    const form = {
      ...initialTaskForm(project.projectId),
      title: "Triage stale issues",
      prompt: "Group stale issues and suggest next maintainer actions."
    };
    const result = buildTaskRequest({
      form,
      viewer,
      projects: [
        {
          ...project,
          status: "installation_removed"
        }
      ],
      now: new Date("2026-06-18T12:00:00Z"),
      id: "task-unverified"
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toContainEqual({
      field: "projectId",
      message: "Project must be verified."
    });
  });

  it("surfaces private beta safety errors before submit", () => {
    const form = {
      ...initialTaskForm(project.projectId),
      title: "Patch production",
      sandbox: "workspace-write" as const,
      network: true,
      allowPatches: true,
      publicPosting: "automatic" as const,
      resultVisibility: "public" as const,
      prompt: "Run a bash script, commit a patch, and post a GitHub comment."
    };
    const result = buildTaskRequest({
      form,
      viewer,
      projects: [project],
      now: new Date("2026-06-18T12:00:00Z"),
      id: "task-unsafe"
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "prompt" }),
        expect.objectContaining({ field: "sandbox" }),
        expect.objectContaining({ field: "network" }),
        expect.objectContaining({ field: "allowPatches" }),
        expect.objectContaining({ field: "publicPosting" }),
        expect.objectContaining({ field: "resultVisibility" })
      ])
    );
  });

  it("builds a gated patch proposal task request", () => {
    const form = {
      ...initialTaskForm(project.projectId),
      title: "Fix widget test",
      type: "patch_proposal" as const,
      sandbox: "workspace-write" as const,
      allowPatches: true,
      prompt: "Edit the widget test fixture and propose the minimal diff for maintainer review."
    };
    const result = buildTaskRequest({
      form,
      viewer,
      projects: [project],
      now: new Date("2026-06-18T12:00:00Z"),
      id: "task-patch"
    });

    expect(result.success).toBe(true);
    expect(result.success ? result.task.permissions : undefined).toMatchObject({
      sandbox: "workspace-write",
      allowPatches: true,
      network: false,
      publicPosting: "maintainer_only"
    });
    expect(result.success ? result.task.requiredCapabilities : []).toEqual(
      expect.arrayContaining(["sandbox.workspace_write", "patch.capture"])
    );
  });
});
