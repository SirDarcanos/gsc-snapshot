import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

async function harness(responses: SearchAnalyticsResponse[]) {
  const root = await mkdtemp(path.join(tmpdir(), "gsc-snapshot-test-"));
  roots.push(root);
  const scopes: readonly string[][] = [];
  const requests: SearchAnalyticsRequest[] = [];
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
        query,
        now: () => new Date("2026-08-29T12:34:56.000Z"),
        packageIdentity: { name: "gsc-snapshot", version: "0.0.0" },
      }),
    },
  };
}

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
