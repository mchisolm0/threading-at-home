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
  validateResultPackage,
  validateRunnerCapability,
  validateTaskLease,
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

  it("keeps task-required capabilities matchable by runner capabilities", () => {
    expect(
      exampleTaskRequest.requiredCapabilities.every((capability) =>
        exampleRunnerCapability.supportedCapabilities.includes(capability)
      )
    ).toBe(true);

    const result = validateRunnerCapability({
      ...exampleRunnerCapability,
      supportedCapabilities: ["not-a-contract-capability"]
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "supportedCapabilities.0"
        })
      ])
    );
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

  it("rejects output schemas without a JSON Schema keyword", () => {
    const result = validateTaskRequest({
      ...exampleTaskRequest,
      outputSchema: {
        foo: true
      }
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "outputSchema",
          message: "Expected at least one JSON Schema keyword"
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

  it("rejects impossible UTC timestamps", () => {
    const result = validateTaskRequest({
      ...exampleTaskRequest,
      createdAt: "2026-99-99T99:99:99Z"
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "createdAt"
        })
      ])
    );
  });

  it("rejects leases that expire before they start", () => {
    const result = validateTaskLease({
      ...exampleTaskLease,
      expiresAt: "2026-06-18T11:59:00Z"
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "expiresAt",
          message: "expiresAt must be after leasedAt"
        })
      ])
    );
  });

  it("rejects result packages for non-terminal run statuses", () => {
    const result = validateResultPackage({
      ...exampleResultPackage,
      runStatus: "running"
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "runStatus"
        })
      ])
    );
  });

  it("requires failed result packages to carry an error", () => {
    const result = validateResultPackage({
      ...exampleResultPackage,
      runStatus: "failed",
      summary: undefined,
      structuredOutput: undefined,
      artifacts: []
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "error",
          message: "non-completed result packages must include an error"
        })
      ])
    );
  });
});
