import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { PatchArtifact, PatchChangedFile } from "@oss-capacity/core";

import { sanitizeText } from "./sanitize.js";
import type { WorkspaceExec } from "./workspace.js";

const maxPatchBytes = 120_000;
const maxChangedFiles = 200;

export type PatchCaptureResult = {
  readonly artifact?: PatchArtifact;
  readonly warnings: readonly string[];
};

export async function captureWorkspacePatch(input: {
  readonly cwd: string;
  readonly baseCommitSha?: string;
  readonly exec: WorkspaceExec;
  readonly maxBytes?: number;
}): Promise<PatchCaptureResult> {
  const maxBytes = input.maxBytes ?? maxPatchBytes;
  const warnings: string[] = [];

  await input.exec("git", ["-C", input.cwd, "add", "--intent-to-add", "--", "."]);

  const [diffResult, nameStatusResult, numstatResult] = await Promise.all([
    input.exec("git", [
      "-C",
      input.cwd,
      "diff",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "HEAD",
      "--"
    ]),
    input.exec("git", ["-C", input.cwd, "diff", "--name-status", "HEAD", "--"]),
    input.exec("git", ["-C", input.cwd, "diff", "--numstat", "HEAD", "--"])
  ]);

  if (diffResult.stdout.trim().length === 0) {
    return { warnings: ["No patch changes were captured."] };
  }

  const sanitized = sanitizeText(diffResult.stdout);
  const bounded = boundUtf8(sanitized, maxBytes);

  if (bounded.truncated) {
    warnings.push(
      `Patch diff was truncated to ${maxBytes} byte(s) before upload.`
    );
  }

  const changedFiles = changedFilesFromGitOutput({
    nameStatus: sanitizeText(nameStatusResult.stdout),
    numstat: sanitizeText(numstatResult.stdout)
  });

  if (changedFiles.total > maxChangedFiles) {
    warnings.push(
      `Patch file list was truncated to ${maxChangedFiles} file(s) before upload.`
    );
  }

  const diff = bounded.text;

  return {
    artifact: {
      kind: "unified_diff",
      baseCommitSha: input.baseCommitSha,
      sha256: contentHash(diff),
      byteLength: Buffer.byteLength(diff, "utf8"),
      truncated: bounded.truncated,
      fileCount: changedFiles.total,
      changedFiles: changedFiles.files.slice(0, maxChangedFiles),
      diff,
      approvalStatus: "pending"
    },
    warnings
  };
}

function boundUtf8(value: string, maxBytes: number): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const bytes = Buffer.from(value, "utf8");

  if (bytes.byteLength <= maxBytes) {
    return { text: value, truncated: false };
  }

  const suffix = "\n\n[diff truncated before upload]\n";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const bounded = bytes.subarray(0, Math.max(0, maxBytes - suffixBytes));

  return {
    text: `${bounded.toString("utf8").replace(/\uFFFD+$/u, "")}${suffix}`,
    truncated: true
  };
}

function changedFilesFromGitOutput(input: {
  readonly nameStatus: string;
  readonly numstat: string;
}): { readonly files: readonly PatchChangedFile[]; readonly total: number } {
  const numstat = new Map<string, Pick<PatchChangedFile, "additions" | "deletions">>();

  for (const line of input.numstat.split("\n")) {
    const [additions, deletions, ...pathParts] = line.split("\t");
    const path = pathParts.at(-1);

    if (path === undefined || path.length === 0) {
      continue;
    }

    numstat.set(path, {
      additions: parseStat(additions),
      deletions: parseStat(deletions)
    });
  }

  const files: PatchChangedFile[] = [];

  for (const line of input.nameStatus.split("\n")) {
    const parts = line.split("\t");
    const statusCode = parts[0];

    if (statusCode === undefined || statusCode.length === 0) {
      continue;
    }

    const status = fileStatus(statusCode);
    const path = parts.at(-1);

    if (path === undefined || path.length === 0) {
      continue;
    }

    files.push({
      path,
      oldPath:
        (status === "renamed" || status === "copied") && parts[1] !== path
          ? parts[1]
          : undefined,
      status,
      ...numstat.get(path)
    });
  }

  return { files, total: files.length };
}

function parseStat(value: string | undefined): number | undefined {
  if (value === undefined || value === "-") {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function fileStatus(value: string): PatchChangedFile["status"] {
  switch (value[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type_changed";
    default:
      return "unknown";
  }
}

function contentHash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
