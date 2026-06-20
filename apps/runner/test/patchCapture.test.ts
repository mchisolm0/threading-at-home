import { describe, expect, it } from "vitest";

import { captureWorkspacePatch } from "../src/patchCapture.js";

describe("workspace patch capture", () => {
  it("captures a sanitized bounded diff with changed file metadata", async () => {
    const calls: unknown[] = [];
    const result = await captureWorkspacePatch({
      cwd: "/tmp/work",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      maxBytes: 180,
      exec: async (_file, args) => {
        calls.push(args);

        if (args.includes("--name-status")) {
          return { stdout: "M\tsrc/widget.ts\nA\tsecret.txt\n", stderr: "" };
        }

        if (args.includes("--numstat")) {
          return { stdout: "2\t1\tsrc/widget.ts\n1\t0\tsecret.txt\n", stderr: "" };
        }

        if (args.includes("diff")) {
          return {
            stdout:
              "diff --git a/src/widget.ts b/src/widget.ts\n" +
              "@@ -1 +1 @@\n" +
              "-old\n" +
              "+new sk-test1234567890 /Users/alice/.codex/auth.json\n" +
              "+".repeat(400),
            stderr: ""
          };
        }

        return { stdout: "", stderr: "" };
      }
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(["add", "--intent-to-add"]),
        expect.arrayContaining(["diff"])
      ])
    );
    expect(result.artifact).toMatchObject({
      kind: "unified_diff",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      truncated: true,
      fileCount: 2,
      approvalStatus: "pending"
    });
    expect(result.artifact?.changedFiles[0]).toMatchObject({
      path: "src/widget.ts",
      status: "modified",
      additions: 2,
      deletions: 1
    });
    expect(result.artifact?.diff).toContain("[redacted]");
    expect(result.artifact?.diff).not.toContain("sk-test1234567890");
    expect(result.artifact?.diff).not.toContain("/Users/alice");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Patch diff was truncated")
      ])
    );
  });

  it("returns a warning when no patch changes are present", async () => {
    const result = await captureWorkspacePatch({
      cwd: "/tmp/work",
      exec: async () => ({ stdout: "", stderr: "" })
    });

    expect(result.artifact).toBeUndefined();
    expect(result.warnings).toContain("No patch changes were captured.");
  });
});
