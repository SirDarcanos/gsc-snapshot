import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("user documentation contract", () => {
  it("documents setup, the command, output, completeness, and security", async () => {
    const readme = await readFile("README.md", "utf8");

    for (const required of [
      "## Install",
      "## Set up Google credentials",
      "## Command reference",
      "--output PATH",
      "--site PROPERTY",
      "--start YYYY-MM-DD",
      "--end YYYY-MM-DD",
      "## Property discovery",
      "## Date behavior",
      "America/Los_Angeles",
      "## Output",
      "manifest.json",
      "summary.md",
      "## Partial and final data",
      "firstIncompleteDate",
      "## Security properties",
      '"gsc-snapshot": "0.1.0"',
      '"search-console:snapshot"',
    ]) {
      expect(readme).toContain(required);
    }
  });

  it("uses the canonical product term throughout user and release documentation", async () => {
    const documentation = `${await readFile("README.md", "utf8")}\n${await readFile("docs/releasing.md", "utf8")}`;

    expect(documentation).toContain("Search Console snapshot");
    expect(documentation.toLowerCase()).not.toMatch(
      /seo report|analytics export/,
    );
  });

  it("separates human release setup from tokenless automation", async () => {
    const guide = await readFile("docs/releasing.md", "utf8");

    expect(guide).toContain("## Human-owned prerequisites");
    expect(guide).toContain("## Publish from a version tag");
    expect(guide).toContain("Workflow filename: `release.yml`");
    expect(guide).toContain("Environment: `npm`");
    expect(guide).toContain("OIDC");
    expect(guide).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });
});
