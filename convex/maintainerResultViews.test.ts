import { describe, expect, it } from "vitest";
import { exampleResultPackage } from "@oss-capacity/core";

import {
  maintainerResultListPackageView,
  maintainerResultPackageView,
  maintainerRunView
} from "./maintainerResultViews.js";

describe("maintainer result views", () => {
  it("redacts volunteer and runner identity for anonymous result packages", () => {
    const resultPackage = maintainerResultPackageView({
      ...exampleResultPackage,
      volunteerVisibility: "anonymous",
      runnerId: "runner-local-macbook",
      volunteerUserId: "user-volunteer-1"
    });
    const run = maintainerRunView(
      {
        runId: exampleResultPackage.runId,
        taskRequestId: exampleResultPackage.taskRequestId,
        projectId: exampleResultPackage.projectId,
        leaseId: exampleResultPackage.leaseId,
        runnerId: "runner-local-macbook",
        status: "completed",
        attempt: 1,
        startedAt: exampleResultPackage.startedAt,
        completedAt: exampleResultPackage.completedAt,
        createdAt: exampleResultPackage.startedAt,
        updatedAt: exampleResultPackage.completedAt
      },
      { ...exampleResultPackage, volunteerVisibility: "anonymous" }
    );

    expect(resultPackage.runnerId).toBeUndefined();
    expect("volunteerUserId" in resultPackage).toBe(false);
    expect(run.runnerId).toBeUndefined();
  });

  it("keeps runner metadata when volunteer visibility is not anonymous", () => {
    const resultPackage = maintainerResultPackageView({
      ...exampleResultPackage,
      volunteerVisibility: "display_name",
      runnerId: "runner-local-macbook",
      volunteerUserId: "user-volunteer-1"
    });

    expect(resultPackage.runnerId).toBe("runner-local-macbook");
    expect("volunteerUserId" in resultPackage).toBe(false);
  });

  it("projects list rows without full structured output or artifacts", () => {
    const resultPackage = maintainerResultPackageView({
      ...exampleResultPackage,
      commandSummaries: [
        {
          command: "pnpm test",
          exitCode: 0,
          durationMs: 1_250,
          summary: "Tests passed."
        }
      ],
      warnings: ["No files changed."]
    });
    const listPackage = maintainerResultListPackageView(resultPackage);

    expect(listPackage).toMatchObject({
      resultPackageId: exampleResultPackage.resultPackageId,
      commandCount: 1,
      commandDurationMs: 1_250,
      artifactCount: exampleResultPackage.artifacts.length,
      warningCount: 1
    });
    expect("structuredOutput" in listPackage).toBe(false);
    expect("artifacts" in listPackage).toBe(false);
    expect("commandSummaries" in listPackage).toBe(false);
  });
});
