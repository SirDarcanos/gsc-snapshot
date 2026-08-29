import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCommand } from "../src/command.js";
import {
  createSnapshotExecutor,
  type SearchAnalyticsRequest,
  type SearchAnalyticsResponse,
} from "../src/snapshot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(
  responses: SearchAnalyticsResponse[],
  properties: string[] = [],
) {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-snapshot-test-"));
  roots.push(root);
  const scopes: readonly string[][] = [];
  const requests: SearchAnalyticsRequest[] = [];
  const listedProperties: string[][] = [];
  const auth = Symbol("private auth");
  const query = vi.fn(async (_auth: unknown, request: SearchAnalyticsRequest) => {
    requests.push(request);
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected Search Console request");
    return response;
  });

  return {
    root,
    scopes,
    requests,
    listedProperties,
    query,
    adapter: {
      cwd: root,
      env: {},
      now: () => new Date("2026-08-29T12:00:00.000Z"),
      execute: createSnapshotExecutor({
        authenticate: async (requestedScopes) => {
          scopes.push(requestedScopes);
          return { ok: true as const, auth };
        },
        listProperties: async () => {
          listedProperties.push([...properties]);
          return properties;
        },
        query,
        now: () => new Date("2026-08-29T12:34:56.000Z"),
        packageIdentity: { name: "gsc-snapshot", version: "0.0.0" },
      }),
    },
  };
}

describe("Search Console property discovery", () => {
  it("prefers the exact domain property for the project homepage hostname", async () => {
    const test = await harness(
      [{}, {}, {}, {}, {}],
      ["https://example.com/blog/", "sc-domain:example.com"],
    );
    await writeFile(
      path.join(test.root, "package.json"),
      JSON.stringify({ homepage: "https://Example.COM:8443/products" }),
    );

    const result = await runCommand([], test.adapter);

    expect(result.exitCode).toBe(0);
    expect(test.listedProperties).toEqual([
      ["https://example.com/blog/", "sc-domain:example.com"],
    ]);
    expect(test.requests.every((request) => request.siteUrl === "sc-domain:example.com")).toBe(true);
    expect(result.stdout).toContain("Property: sc-domain:example.com");
  });

  it("selects one matching URL-prefix property and ignores malformed listings", async () => {
    const test = await harness(
      [{}, {}, {}, {}, {}],
      [
        "not a property",
        "ftp://example.com/",
        "https://user:secret@example.com/",
        "https://example.com/\ncredential-detail",
        "https://example.com:9443/docs/",
        "https://other.test/",
      ],
    );
    await writeFile(
      path.join(test.root, "package.json"),
      JSON.stringify({ homepage: "https://EXAMPLE.com/project/page" }),
    );

    const result = await runCommand([], test.adapter);

    expect(result.exitCode).toBe(0);
    expect(test.requests.every((request) => request.siteUrl === "https://example.com:9443/docs/")).toBe(true);
  });

  it("uses npm's active working root for homepage discovery and publication", async () => {
    const test = await harness(
      [{}, {}, {}, {}, {}],
      ["sc-domain:consumer.test"],
    );
    const consumerRoot = path.join(test.root, "consumer");
    await writeFile(
      path.join(test.root, "placeholder"),
      "keeps the temporary root present",
    );
    await mkdir(consumerRoot);
    const manifestPath = path.join(consumerRoot, "package.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ homepage: "https://consumer.test/a" }),
    );
    test.adapter.env = { npm_package_json: manifestPath };

    const result = await runCommand([], test.adapter);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Path: ${path.join(consumerRoot, "2026-07-30--2026-08-28")}`,
    );
  });

  it("lists sorted candidates when URL-prefix discovery is ambiguous", async () => {
    const test = await harness(
      [],
      ["https://example.com/b/", "malformed", "http://example.com/", "https://example.com/a/"],
    );
    await writeFile(
      path.join(test.root, "package.json"),
      JSON.stringify({ homepage: "https://example.com" }),
    );

    const result = await runCommand([], test.adapter);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Multiple accessible Search Console properties");
    expect(result.stderr).toContain(
      "- http://example.com/\n- https://example.com/a/\n- https://example.com/b/",
    );
    expect(result.stderr).toContain("Rerun with --site PROPERTY");
    expect(test.query).not.toHaveBeenCalled();
  });

  it("reports the homepage hostname when no accessible property matches", async () => {
    const test = await harness([], ["sc-domain:other.test", "bad listing"]);
    await writeFile(
      path.join(test.root, "package.json"),
      JSON.stringify({ homepage: "https://Example.com/path" }),
    );

    const result = await runCommand([], test.adapter);

    expect(result.stderr).toContain(
      "No accessible Search Console property matches homepage hostname example.com",
    );
    expect(result.stderr).toContain("--site PROPERTY");
  });

  it.each([
    ["an absent homepage", {}, "has no valid homepage"],
    ["a non-string homepage", { homepage: 42 }, "has no valid homepage"],
    ["a malformed homepage", { homepage: "example.com" }, "not a valid HTTP(S) URL"],
    ["a non-HTTP homepage", { homepage: "ftp://example.com" }, "not a valid HTTP(S) URL"],
  ])("rejects $0 with actionable guidance", async (_name, manifest, diagnostic) => {
    const test = await harness([]);
    await writeFile(path.join(test.root, "package.json"), JSON.stringify(manifest));

    const result = await runCommand([], test.adapter);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    expect(result.stderr).toContain("--site PROPERTY");
    expect(test.scopes).toEqual([]);
  });

  it("reports missing and malformed package metadata", async () => {
    const missing = await harness([]);
    const missingResult = await runCommand([], missing.adapter);
    expect(missingResult.stderr).toContain("package.json is missing or unreadable");

    const malformed = await harness([]);
    await writeFile(path.join(malformed.root, "package.json"), "{ nope");
    const malformedResult = await runCommand([], malformed.adapter);
    expect(malformedResult.stderr).toContain("package.json is invalid");
    expect(malformed.scopes).toEqual([]);
  });
});

describe("explicit-property Search Console snapshot", () => {
  it("authenticates read-only, requests each web view, and publishes a complete snapshot", async () => {
    const test = await harness([
      { rows: [{ keys: ["https://example.com/a", "alpha"], clicks: 2, impressions: 10, ctr: 0.2, position: 3 }] },
      { rows: [{ keys: ["DESKTOP"], clicks: 2, impressions: 10, ctr: 0.2, position: 3 }] },
      { rows: [{ keys: ["usa"], clicks: 2, impressions: 10, ctr: 0.2, position: 3 }] },
      { rows: [{ clicks: 2, impressions: 10, ctr: 0.2, position: 3 }] },
      { rows: [{ keys: ["2026-08-01"] }] },
    ]);

    const result = await runCommand(
      ["--site", "sc-domain:example.com", "--start", "2026-08-01", "--end", "2026-08-20"],
      test.adapter,
    );

    const snapshotPath = path.join(test.root, "2026-08-01--2026-08-20");
    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `Created Search Console snapshot\nInterval: 2026-08-01 to 2026-08-20\nProperty: sc-domain:example.com\nStatus: final\nPath: ${snapshotPath}\n`,
    });
    expect(test.scopes).toEqual([["https://www.googleapis.com/auth/webmasters.readonly"]]);
    expect(test.listedProperties).toEqual([]);
    expect(test.requests).toEqual([
      expect.objectContaining({ siteUrl: "sc-domain:example.com", requestBody: expect.objectContaining({ dimensions: ["page", "query"], type: "web", dataState: "all" }) }),
      expect.objectContaining({ siteUrl: "sc-domain:example.com", requestBody: expect.objectContaining({ dimensions: ["device"], type: "web", dataState: "all" }) }),
      expect.objectContaining({ siteUrl: "sc-domain:example.com", requestBody: expect.objectContaining({ dimensions: ["country"], type: "web", dataState: "all" }) }),
      expect.objectContaining({ siteUrl: "sc-domain:example.com", requestBody: expect.not.objectContaining({ dimensions: expect.anything() }) }),
      expect.objectContaining({ siteUrl: "sc-domain:example.com", requestBody: expect.objectContaining({ dimensions: ["date"], type: "web", dataState: "all" }) }),
    ]);
    for (const request of test.requests) {
      expect(request.requestBody).toMatchObject({
        startDate: "2026-08-01",
        endDate: "2026-08-20",
        type: "web",
        dataState: "all",
        rowLimit: 25_000,
        startRow: 0,
      });
    }
    expect(await readdir(snapshotPath)).toEqual([
      "countries.json",
      "devices.json",
      "manifest.json",
      "page-query.json",
      "summary.md",
      "totals.json",
    ]);

    const manifest = JSON.parse(await readFile(path.join(snapshotPath, "manifest.json"), "utf8"));
    expect(manifest).toEqual({
      property: "sc-domain:example.com",
      searchType: "web",
      requestedInterval: { start: "2026-08-01", end: "2026-08-20" },
      effectiveInterval: { start: "2026-08-01", end: "2026-08-20" },
      adjustments: [],
      pulledAt: "2026-08-29T12:34:56.000Z",
      requestedDataState: "all",
      status: "final",
      firstIncompleteDate: null,
      package: { name: "gsc-snapshot", version: "0.0.0" },
      datasets: {
        pageQuery: { filename: "page-query.json", rowCount: 1 },
        devices: { filename: "devices.json", rowCount: 1 },
        countries: { filename: "countries.json", rowCount: 1 },
        totals: { filename: "totals.json", rowCount: 1 },
      },
    });
    const summary = await readFile(path.join(snapshotPath, "summary.md"), "utf8");
    expect(summary).toContain("# Search Console snapshot");
    expect(summary).toContain("**Requested interval:** 2026-08-01 to 2026-08-20");
    expect(summary).toContain("| Clicks | Impressions | CTR | Average position |");
    expect(summary).toContain("| 2 | 10 | 20.00% | 3.00 |");
    expect(summary).toContain("Search Console may return only top rows; pagination does not guarantee exhaustive data.");
    expect(summary).not.toMatch(/recommend|should|comparison/i);
  });

  it("publishes valid empty dataset arrays", async () => {
    const test = await harness([{ rows: [] }, {}, { rows: [] }, {}, {}]);

    const result = await runCommand(["--site", "https://example.com/"], test.adapter);

    expect(result.exitCode).toBe(0);
    const snapshotPath = path.join(test.root, "2026-07-30--2026-08-28");
    for (const filename of ["page-query.json", "devices.json", "countries.json", "totals.json"]) {
      expect(JSON.parse(await readFile(path.join(snapshotPath, filename), "utf8"))).toEqual({ rows: [] });
    }
  });

  it("reports partial data from the date-grouped completeness response", async () => {
    const test = await harness([
      {},
      {},
      {},
      { rows: [{ clicks: 1, impressions: 2, ctr: 0.5, position: 4 }] },
      { metadata: { firstIncompleteDate: "2026-08-27" } },
    ]);

    const result = await runCommand(["--site", "sc-domain:example.com"], test.adapter);

    expect(result.stdout).toContain("Status: partial");
    const snapshotPath = path.join(test.root, "2026-07-30--2026-08-28");
    const manifest = JSON.parse(await readFile(path.join(snapshotPath, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ status: "partial", firstIncompleteDate: "2026-08-27" });
    expect(await readFile(path.join(snapshotPath, "summary.md"), "utf8")).toContain(
      "Search Console reports incomplete data beginning 2026-08-27",
    );
  });

  it("gives setup guidance for missing ADC without publishing success", async () => {
    const test = await harness([]);
    test.adapter.execute = createSnapshotExecutor({
      authenticate: async () => ({ ok: false as const, reason: "missing" as const }),
      listProperties: async () => [],
      query: test.query,
      now: () => new Date(),
      packageIdentity: { name: "gsc-snapshot", version: "0.0.0" },
    });

    const result = await runCommand(["--site", "sc-domain:example.com"], test.adapter);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Application Default Credentials were not found");
    expect(result.stderr).toContain("gcloud auth application-default login");
    expect(test.query).not.toHaveBeenCalled();
    expect(await readdir(test.root)).toEqual([]);
  });

  it.each([
    [
      Object.assign(new Error("oauth internals"), {
        status: 400,
        response: { data: { error: "invalid_grant" } },
      }),
      "Application Default Credentials were rejected",
    ],
    [
      Object.assign(new Error("account identity"), {
        status: 403,
        errors: [{ reason: "forbidden" }],
      }),
      "Search Console property is inaccessible",
    ],
  ])("classifies safe structured Google failures", async (failure, diagnostic) => {
    const test = await harness([]);
    test.query.mockRejectedValueOnce(failure);

    const result = await runCommand(["--site", "sc-domain:example.com"], test.adapter);

    expect(result.stderr).toContain(diagnostic);
    expect(result.stderr).not.toMatch(/oauth internals|account identity|invalid_grant/);
  });

  it.each([
    [401, "Application Default Credentials were rejected"],
    [403, "Search Console rejected the request"],
    [500, "Search Console request failed"],
  ])("redacts sensitive API errors with status %s", async (status, diagnostic) => {
    const test = await harness([]);
    test.query.mockRejectedValueOnce(Object.assign(new Error("token=secret refresh_token=also-secret /Users/me/adc.json user@example.com"), { status }));

    const result = await runCommand(["--site", "sc-domain:example.com"], test.adapter);

    expect(result).toEqual(expect.objectContaining({ exitCode: 1, stdout: "" }));
    expect(result.stderr).toContain(diagnostic);
    expect(result.stderr).not.toMatch(/secret|adc\.json|user@example|refresh_token|\/Users\/me/);
    expect(await readdir(test.root)).toEqual([]);
  });
});
