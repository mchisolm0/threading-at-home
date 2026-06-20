import { describe, expect, it } from "vitest";

import { hashToken, isTokenHash } from "../src/token.js";

describe("runner token helpers", () => {
  it("hashes setup tokens locally without preserving the raw token", () => {
    const hash = hashToken(" ocr_test-token ");

    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(hash).not.toContain("ocr_test-token");
    expect(isTokenHash(hash)).toBe(true);
  });

  it("rejects empty tokens", () => {
    expect(() => hashToken("   ")).toThrow("Token must not be empty");
  });
});
