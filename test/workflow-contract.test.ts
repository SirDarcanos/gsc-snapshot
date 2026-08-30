import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

function lines(contents: string): string[] {
  return contents.split("\n").map((line) => line.trim());
}

describe("release automation contract", () => {
  it("checks supported Node versions from the lockfile without publishing", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    const workflowLines = lines(workflow);

    expect(workflow).toContain("node-version: [22, 24]");
    expect(workflowLines).toContain("- run: npm ci");
    expect(workflowLines).toContain("- run: npm run format:check");
    expect(workflowLines).toContain("- run: npm run typecheck");
    expect(workflowLines).toContain("- run: npm test");
    expect(workflowLines).toContain("- run: npm pack --dry-run");
    expect(workflow).not.toContain("npm publish");
  });

  it("publishes only matching version tags with OIDC and provenance", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    const workflowLines = lines(workflow);

    expect(workflow).toContain('- "v*.*.*"');
    expect(workflow).not.toMatch(/workflow_dispatch|pull_request/);
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("node-version: 24");
    expect(workflow).toContain("registry-url: https://registry.npmjs.org");
    expect(workflow).toContain("GITHUB_REF_NAME#v");
    expect(workflow).toContain("require('./package.json').version");
    expect(workflowLines).toContain(
      "- run: npm publish --access public --provenance",
    );
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npm_[A-Za-z0-9]{20,}/);
  });
});
