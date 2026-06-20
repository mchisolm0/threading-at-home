import { describe, expect, it } from "vitest";

import {
  buildGitHubPromotionPreview,
  exampleResultPackage,
  exampleTaskRequest,
  normalizeGitHubPromotionTarget
} from "../src/index.js";

describe("GitHub promotion previews", () => {
  it("builds an issue comment preview from a redacted result package", () => {
    const preview = buildGitHubPromotionPreview({
      repositoryFullName: exampleTaskRequest.repository.fullName,
      task: exampleTaskRequest,
      resultPackage: {
        ...exampleResultPackage,
        summary: "api token: abcdefghijklmnopqrstuvwxyz123456 leaked.",
        structuredOutput: {
          path: "/Users/alice/work/project/.env"
        }
      },
      target: {
        kind: "issue_comment",
        issueNumber: 42
      },
      attributionMode: "app"
    });

    expect(preview).toMatchObject({
      targetKind: "issue_comment",
      targetRepository: "open-source/widgets",
      targetIssueNumber: 42,
      attributionText: "Posted by OSS Capacity on maintainer request.",
      redaction: {
        applied: true
      }
    });
    expect(preview.body).toContain("[redacted]");
    expect(preview.body).toContain("[redacted-path]");
    expect(preview.body).toContain("open-source/widgets#42");
    expect(preview.body).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(preview.body).not.toContain("/Users/alice");
  });

  it("keeps anonymous attribution from exposing runner identity", () => {
    const preview = buildGitHubPromotionPreview({
      repositoryFullName: exampleTaskRequest.repository.fullName,
      task: exampleTaskRequest,
      resultPackage: {
        ...exampleResultPackage,
        volunteerVisibility: "anonymous",
        runnerId: "runner-secret-local"
      },
      target: {
        kind: "new_issue",
        title: "Maintainer follow-up"
      },
      attributionMode: "app_with_anonymous_run",
      visibleRunnerId: "runner-secret-local"
    });

    expect(preview.title).toBe("Maintainer follow-up");
    expect(preview.body).toContain("open-source/widgets new issue: Maintainer follow-up");
    expect(preview.attributionText).toContain("volunteer visibility: anonymous");
    expect(preview.attributionText).toContain(exampleResultPackage.runId);
    expect(preview.attributionText).not.toContain("runner-secret-local");
  });

  it("exposes a disabled patch pull request contract without body content", () => {
    const preview = buildGitHubPromotionPreview({
      repositoryFullName: exampleTaskRequest.repository.fullName,
      task: exampleTaskRequest,
      resultPackage: exampleResultPackage,
      target: {
        kind: "patch_pull_request",
        disabledReason: "Task 7.2 will provide patch artifacts."
      },
      attributionMode: "app"
    });

    expect(preview.targetKind).toBe("patch_pull_request");
    expect(preview.disabledReason).toBe("Task 7.2 will provide patch artifacts.");
    expect(preview.body).toBe("");
  });

  it("validates current MVP promotion targets", () => {
    expect(() =>
      normalizeGitHubPromotionTarget({
        kind: "issue_comment",
        issueNumber: 0
      })
    ).toThrow("positive issue number");

    expect(() =>
      normalizeGitHubPromotionTarget({
        kind: "new_issue",
        title: ""
      })
    ).toThrow("1-256 characters");
  });
});
