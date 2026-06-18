export type WorkspaceArea = "web" | "runner" | "convex" | "codex" | "github";

export function createWorkspaceLabel(area: WorkspaceArea): string {
  return `oss-capacity:${area}`;
}

export * from "./contracts.js";
export * from "./fixtures.js";
