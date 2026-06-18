import { describe, expect, it } from "vitest";
import {
  exampleResultPackage,
  exampleRunnerCapability,
  exampleTaskLease,
  exampleTaskRequest,
  exampleVolunteerPolicy
} from "../src/fixtures.js";
import {
  parseResultPackage,
  parseRunnerCapability,
  parseTaskLease,
  parseTaskRequest,
  parseVolunteerPolicy,
  validateTaskRequest,
  validateVolunteerPolicy
} from "../src/index.js";

describe("shared domain contracts", () => {
  it("accepts the exported fixture examples", () => {
    expect(parseTaskRequest(exampleTaskRequest)).toEqual(exampleTaskRequest);
    expect(parseVolunteerPolicy(exampleVolunteerPolicy)).toEqual(
      exampleVolunteerPolicy
    );
    expect(parseRunnerCapability(exampleRunnerCapability)).toEqual(
      exampleRunnerCapability
    );
    expect(parseTaskLease(exampleTaskLease)).toEqual(exampleTaskLease);
    expect(parseResultPackage(exampleResultPackage)).toEqual(exampleResultPackage);
  });

  it("rejects a task request whose project and repository disagree", () => {
    const result = validateTaskRequest({
      ...exampleTaskRequest,
      projectId: "open-source/other-repo"
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "projectId",
          message: "projectId must match repository.fullName"
        })
      ])
    );
  });

  it("rejects empty maintainer prompts", () => {
    const result = validateTaskRequest({
      ...exampleTaskRequest,
      prompt: ""
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "prompt"
        })
      ])
    );
  });

  it("rejects capacity policy percentages outside 0-100", () => {
    const result = validateVolunteerPolicy({
      ...exampleVolunteerPolicy,
      capacity: {
        ...exampleVolunteerPolicy.capacity,
        maxUsedPercent: 101
      }
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "capacity.maxUsedPercent"
        })
      ])
    );
  });
});
