import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exampleTaskRequest } from "@oss-capacity/core";
import { describe, expect, it } from "vitest";

import { ensureCleanWorkspace, safeRepositoryPath } from "../src/workspace.js";

describe("runner workspace cache", () => {
  it("keeps repository paths inside the workspace root", () => {
    const root = "/tmp/oss-capacity-workspaces";
    const path = safeRepositoryPath(root, "open-source/widgets");

    expect(path.startsWith(root)).toBe(true);
    expect(path).toContain("open-source__widgets");
  });

  it("uses read-only remote operations and cleans the local cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "oss-capacity-workspace-test-"));
    const execCalls: string[][] = [];
    const task = {
      ...exampleTaskRequest,
      target: {
        ...exampleTaskRequest.target,
        ref: "main"
      }
    };

    await ensureCleanWorkspace({
      workspaceRoot: root,
      task,
      dependencies: {
        exec: async (file, args) => {
          execCalls.push([file, ...args]);

          if (args.includes("rev-parse")) {
            return {
              stdout: "0123456789abcdef0123456789abcdef01234567\n",
              stderr: ""
            };
          }

          return { stdout: "", stderr: "" };
        }
      }
    });

    expect(execCalls.some((call) => call.includes("clone"))).toBe(true);
    expect(execCalls.some((call) => call.includes("push"))).toBe(false);
    expect(execCalls.some((call) => call.includes("reset"))).toBe(true);
    expect(execCalls.some((call) => call.includes("clean"))).toBe(true);
    expect(execCalls.some((call) => call.includes("-ffdx"))).toBe(true);
  });
});
