import { describe, expect, it } from "vitest";

import {
  assertRunnerSetupTokenCanBeExchanged,
  normalizeRunnerSetupTokenHash
} from "./volunteerLogic.js";

const now = "2026-06-19T12:00:00Z";
const validHash = `sha256:${"A".repeat(64)}`;

describe("volunteer runner setup token helpers", () => {
  it("normalizes valid setup token hashes", () => {
    expect(normalizeRunnerSetupTokenHash(validHash)).toBe(validHash.toLowerCase());
  });

  it("rejects malformed setup token hashes", () => {
    expect(() => normalizeRunnerSetupTokenHash("ocr_raw-token")).toThrow(
      "Runner setup token hash must be a sha256 hex digest"
    );
    expect(() => normalizeRunnerSetupTokenHash("sha256:not-hex")).toThrow(
      "Runner setup token hash must be a sha256 hex digest"
    );
  });

  it("allows active unexpired setup tokens to be exchanged", () => {
    expect(() =>
      assertRunnerSetupTokenCanBeExchanged(
        { status: "active", expiresAt: "2026-06-19T12:01:00Z" },
        now
      )
    ).not.toThrow();
  });

  it("rejects inactive setup tokens", () => {
    expect(() =>
      assertRunnerSetupTokenCanBeExchanged({ status: "used" }, now)
    ).toThrow("Runner setup token is not active");
    expect(() =>
      assertRunnerSetupTokenCanBeExchanged({ status: "revoked" }, now)
    ).toThrow("Runner setup token is not active");
  });

  it("rejects expired setup tokens", () => {
    expect(() =>
      assertRunnerSetupTokenCanBeExchanged(
        { status: "active", expiresAt: "2026-06-19T12:00:00Z" },
        now
      )
    ).toThrow("Runner setup token has expired");
  });
});
