import { describe, expect, it } from "vitest";
import { exampleResultPackage } from "@oss-capacity/core";

import {
  formatDurationMs,
  structuredEntries,
  totalCommandDurationMs
} from "./resultView";

describe("result view helpers", () => {
  it("formats run durations for result metadata", () => {
    expect(
      formatDurationMs("2026-06-18T12:00:00.000Z", "2026-06-18T12:00:00.250Z")
    ).toBe("250ms");
    expect(
      formatDurationMs("2026-06-18T12:00:00.000Z", "2026-06-18T12:01:05.000Z")
    ).toBe("1m 5s");
    expect(
      formatDurationMs("2026-06-18T12:00:00.000Z", "2026-06-18T11:59:59.000Z")
    ).toBe("unknown");
  });

  it("turns structured output objects into display entries", () => {
    const output = exampleResultPackage.structuredOutput;

    if (output === undefined) {
      throw new Error("Fixture should include structured output");
    }

    const entries = structuredEntries(output);

    expect(entries.map((entry) => entry.label)).toEqual([
      "summary",
      "groups",
      "risks"
    ]);
    expect(entries[1]?.key).toBe("groups");
  });

  it("totals command durations without reading raw runner auth material", () => {
    expect(
      totalCommandDurationMs({
        ...exampleResultPackage,
        commandSummaries: [
          {
            command: "pnpm test",
            exitCode: 0,
            durationMs: 1_200,
            summary: "Tests passed."
          },
          {
            command: "pnpm build",
            exitCode: 0,
            durationMs: 2_300,
            summary: "Build passed."
          }
        ]
      })
    ).toBe(3_500);
  });
});
