import { describe, expect, it } from "vitest";

import {
  boundAndRedactLog,
  formatPercent,
  reasonLabel,
  snapshotToViewModel,
  type RunnerSnapshot
} from "./runnerUi";

const baseSnapshot: RunnerSnapshot = {
  running: false,
  mode: "stopped",
  intervalSeconds: 300,
  commandPreview: "pnpm --filter @oss-capacity/runner dev -- run-once",
  trustBoundary: [
    "Codex runs locally on this machine.",
    "Convex brokers task state and result packages.",
    "Volunteer Codex credentials stay on this machine."
  ]
};

describe("runner UI helpers", () => {
  it("summarizes unchecked, available, and paused capacity states", () => {
    expect(snapshotToViewModel(baseSnapshot)).toMatchObject({
      badgeTone: "neutral",
      capacityLabel: "Capacity not checked yet"
    });

    expect(
      snapshotToViewModel({
        ...baseSnapshot,
        running: true,
        capacity: {
          ok: true,
          reasons: []
        }
      })
    ).toMatchObject({
      badgeTone: "good",
      statusLabel: "Runner loop active",
      capacityLabel: "Capacity available"
    });

    expect(
      snapshotToViewModel({
        ...baseSnapshot,
        capacity: {
          ok: false,
          reasons: ["codex_rate_limit_exceeded"]
        }
      })
    ).toMatchObject({
      badgeTone: "warn",
      capacityReasons: ["codex_rate_limit_exceeded"],
      capacityLabel: "Capacity paused"
    });
  });

  it("bounds and redacts displayed logs", () => {
    const log = [
      "email person@example.com",
      "token: sk-secretabc123456789",
      "/Users/alice/.codex/auth.json",
      "keep this final line"
    ].join("\n");

    const redacted = boundAndRedactLog(log, {
      maxChars: 80,
      maxLines: 2
    });

    expect(redacted).not.toContain("person@example.com");
    expect(redacted).not.toContain("sk-secretabc");
    expect(redacted).not.toContain("/Users/alice");
    expect(redacted).toContain("keep this final line");
    expect(redacted.length).toBeLessThanOrEqual(112);
  });

  it("formats compact display labels", () => {
    expect(formatPercent(54.4)).toBe("54% used");
    expect(formatPercent(undefined)).toBe("Unknown");
    expect(reasonLabel("codex_rate_limit_exceeded")).toBe("Codex Rate Limit Exceeded");
  });
});
