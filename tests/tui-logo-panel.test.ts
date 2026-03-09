import { describe, expect, it } from "vitest";
import { getLogoMetaRows, truncateLeft } from "../src/tui/components/logo-panel.js";

describe("truncateLeft", () => {
  it("keeps short strings unchanged", () => {
    expect(truncateLeft("/tmp/project", 20)).toBe("/tmp/project");
  });

  it("truncates from the left with an ellipsis", () => {
    expect(truncateLeft("/Users/felix/Documents/project", 12)).toBe("...s/project");
  });
});

describe("getLogoMetaRows", () => {
  it("adds aligned labels for version and directory", () => {
    expect(getLogoMetaRows("/tmp/project", "1.2.3")).toEqual([
      { label: "Version:", value: "v1.2.3" },
      { label: "Directory:", value: "/tmp/project" },
    ]);
  });

  it("truncates long directories to the configured directory width budget", () => {
    const rows = getLogoMetaRows(
      "/Users/felix/Documents/Agent/LongerAgentTypeScript/src/tui/components/logo-panel.tsx",
      "1.2.3",
    );

    expect(rows[1]?.label).toBe("Directory:");
    expect(rows[1]?.value.startsWith("...")).toBe(true);
    expect(rows[1]?.value.length).toBeLessThanOrEqual(80);
  });
});
