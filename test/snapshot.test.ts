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
  responses: Array<SearchAnalyticsResponse | Error>,
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
    if (response instanceof Error) throw response;
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
      rowAvailability:
        "Search Console may return only top rows; pagination does not guarantee exhaustive data.",
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

  it("renders grouped, weighted, escaped, and deterministically ordered summary tables", async () => {
    const test = await harness([
      {
        rows: [
          {
            keys: [
              "https://example.com/a|pipe\nnext",
              "![*alpha*](https://probe.test/pixel)`code`|beta\nline",
            ],
            clicks: 2,
            impressions: 10,
            ctr: 0.2,
            position: 2,
          },
          {
            keys: [
              "https://example.com/b",
              "![*alpha*](https://probe.test/pixel)`code`|beta\nline",
            ],
            clicks: 3,
            impressions: 30,
            ctr: 0.1,
            position: 4,
          },
          {
            keys: ["https://example.com/a|pipe\nnext", "beta"],
            clicks: 4,
            impressions: 40,
            ctr: 0.1,
            position: 1,
          },
          {
            keys: ["https://example.com/zero", "zero"],
            clicks: 0,
            impressions: 0,
            ctr: 0,
            position: 99,
          },
        ],
      },
      {
        rows: [
          { keys: ["MOBILE"], clicks: 5, impressions: 100, ctr: 0.05, position: 3 },
          { keys: ["DESKTOP"], clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
          { keys: ["TABLET"], clicks: 0, impressions: 0, ctr: 0, position: 50 },
        ],
      },
      {
        rows: [
          { keys: ["usa"], clicks: 2, impressions: 50, ctr: 0.04, position: 4 },
          { keys: ["can"], clicks: 3, impressions: 50, ctr: 0.06, position: 2 },
        ],
      },
      { rows: [{ clicks: 9, impressions: 80, ctr: 0.1125, position: 2.25 }] },
      {},
    ]);

    const result = await runCommand(["--site", "sc-domain:example.com"], test.adapter);

    expect(result.exitCode).toBe(0);
    const snapshotPath = path.join(test.root, "2026-07-30--2026-08-28");
    const summary = await readFile(path.join(snapshotPath, "summary.md"), "utf8");
    expect(summary).toContain("## Top queries");
    expect(summary).toContain("## Top pages");
    expect(summary).toContain("## Devices");
    expect(summary).toContain("## Countries");
    expect(summary).toContain(
      "| &#33;&#91;&#42;alpha&#42;&#93;&#40;https&#58;&#47;&#47;probe&#46;test&#47;pixel&#41;&#96;code&#96;&#124;beta<br>line | 5 | 40 | 12.50% | 3.50 |",
    );
    expect(summary).toContain(
      "| https&#58;&#47;&#47;example&#46;com&#47;a&#124;pipe<br>next | 6 | 50 | 12.00% | 1.20 |",
    );
    expect(summary).toContain("| zero | 0 | 0 | 0.00% | — |");
    expect(summary).not.toContain("![*alpha*]");
    expect(summary).not.toContain("](https://probe.test/pixel)");
    expect(summary).toContain(
      "For rows with zero impressions, CTR is 0.00% and average position is —.",
    );
    expect(summary.indexOf("| DESKTOP | 10 | 100")).toBeLessThan(
      summary.indexOf("| MOBILE | 5 | 100"),
    );
    expect(summary.indexOf("| can | 3 | 50")).toBeLessThan(
      summary.indexOf("| usa | 2 | 50"),
    );
    expect(summary).toContain(
      "- start: defaulted-to-29-days-before-yesterday ((omitted) → 2026-07-30)",
    );
    expect(summary).toContain(
      "- end: defaulted-to-yesterday ((omitted) → 2026-08-28)",
    );

    expect(
      await readFile(path.join(snapshotPath, "page-query.json"), "utf8"),
    ).toBe(`${JSON.stringify({
      rows: [
        {
          page: "https://example.com/a|pipe\nnext",
          query: "![*alpha*](https://probe.test/pixel)`code`|beta\nline",
          clicks: 2,
          impressions: 10,
          ctr: 0.2,
          position: 2,
        },
        {
          page: "https://example.com/a|pipe\nnext",
          query: "beta",
          clicks: 4,
          impressions: 40,
          ctr: 0.1,
          position: 1,
        },
        {
          page: "https://example.com/b",
          query: "![*alpha*](https://probe.test/pixel)`code`|beta\nline",
          clicks: 3,
          impressions: 30,
          ctr: 0.1,
          position: 4,
        },
        {
          page: "https://example.com/zero",
          query: "zero",
          clicks: 0,
          impressions: 0,
          ctr: 0,
          position: 99,
        },
      ],
    }, null, 2)}\n`);
  });

  it("limits impression ties lexically and serializes identical inputs byte-for-byte", async () => {
    const responses = (reverse: boolean) => {
      const rows = Array.from({ length: 22 }, (_, offset) => {
        const index = 21 - offset;
        const suffix = String(index).padStart(2, "0");
        return {
          keys: [`https://example.com/p${suffix}`, `q${suffix}`],
          clicks: 1,
          impressions: 10,
          ctr: 0.1,
          position: index + 1,
        };
      });
      return [
        { rows: reverse ? rows.reverse() : rows },
        {},
        {},
        { rows: [{ clicks: 22, impressions: 220, ctr: 0.1, position: 11.5 }] },
        {},
      ];
    };
    const first = await harness(responses(false));
    const second = await harness(responses(true));

    await runCommand(["--site", "sc-domain:example.com"], first.adapter);
    await runCommand(["--site", "sc-domain:example.com"], second.adapter);

    const firstPath = path.join(first.root, "2026-07-30--2026-08-28");
    const secondPath = path.join(second.root, "2026-07-30--2026-08-28");
    const summary = await readFile(path.join(firstPath, "summary.md"), "utf8");
    const querySection = summary
      .split("## Top queries")[1]
      ?.split("## Top pages")[0] ?? "";
    const pageSection = summary
      .split("## Top pages")[1]
      ?.split("## Devices")[0] ?? "";
    expect(querySection).toContain("| q00 | 1 | 10 |");
    expect(querySection).toContain("| q19 | 1 | 10 |");
    expect(querySection).not.toContain("| q20 |");
    expect(querySection).not.toContain("| q21 |");
    expect(querySection.indexOf("| q00 |")).toBeLessThan(
      querySection.indexOf("| q01 |"),
    );
    expect(pageSection).toContain(
      "| https&#58;&#47;&#47;example&#46;com&#47;p00 | 1 | 10 |",
    );
    expect(pageSection).not.toContain(
      "| https&#58;&#47;&#47;example&#46;com&#47;p20 |",
    );

    for (const filename of [
      "page-query.json",
      "devices.json",
      "countries.json",
      "totals.json",
      "manifest.json",
      "summary.md",
    ]) {
      expect(await readFile(path.join(firstPath, filename), "utf8")).toBe(
        await readFile(path.join(secondPath, filename), "utf8"),
      );
    }
  });

  it("paginates exact page-size boundaries and keeps the earliest completeness date", async () => {
    const firstPage = Array.from({ length: 25_000 }, (_, index) => ({
      keys: [`https://example.com/${index}`, `query-${index}`],
      clicks: index,
      impressions: index + 1,
      ctr: 0.5,
      position: 1,
    }));
    const test = await harness([
      { rows: firstPage, metadata: { firstIncompleteDate: "2026-08-27" } },
      { metadata: { firstIncompleteDate: "2026-08-25" } },
      {},
      {},
      {},
      { rows: [], metadata: { firstIncompleteDate: "2026-08-26" } },
    ]);

    const result = await runCommand(["--site", "sc-domain:example.com"], test.adapter);

    expect(result.exitCode).toBe(0);
    const pageRequests = test.requests.filter(
      (request) => request.requestBody.dimensions?.join(",") === "page,query",
    );
    expect(pageRequests.map((request) => request.requestBody.startRow)).toEqual([
      0, 25_000,
    ]);
    const snapshotPath = path.join(test.root, "2026-07-30--2026-08-28");
    const dataset = JSON.parse(
      await readFile(path.join(snapshotPath, "page-query.json"), "utf8"),
    );
    expect(dataset.rows).toHaveLength(25_000);
    expect(dataset.rows[0]).toMatchObject({
      page: "https://example.com/0",
      query: "query-0",
    });
    expect(dataset.rows[24_999]).toMatchObject({
      page: "https://example.com/9999",
      query: "query-9999",
    });
    expect(dataset.rows).toContainEqual(
      expect.objectContaining({
        page: "https://example.com/24999",
        query: "query-24999",
      }),
    );
    const manifest = JSON.parse(
      await readFile(path.join(snapshotPath, "manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      status: "partial",
      firstIncompleteDate: "2026-08-25",
      datasets: { pageQuery: { rowCount: 25_000 } },
    });
  });

  it("redacts a later-page failure and does not publish a snapshot", async () => {
    const failure = Object.assign(
      new Error("token=secret /Users/person/application_default_credentials.json"),
      { status: 500 },
    );
    const test = await harness([
      { rows: Array(25_000).fill({}) },
      {},
      {},
      {},
      {},
      failure,
    ]);

    const result = await runCommand(["--site", "sc-domain:example.com"], test.adapter);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Search Console request failed");
    expect(result.stderr).not.toMatch(/secret|application_default_credentials|\/Users/);
    expect(
      test.requests.filter(
        (request) => request.requestBody.dimensions?.join(",") === "page,query",
      ).map((request) => request.requestBody.startRow),
    ).toEqual([0, 25_000]);
    expect(await readdir(test.root)).toEqual([]);
  });

  it("publishes valid empty dataset arrays", async () => {
    const test = await harness([{ rows: [] }, {}, { rows: [] }, {}, {}]);

    const result = await runCommand(["--site", "https://example.com/"], test.adapter);

    expect(result.exitCode).toBe(0);
    const snapshotPath = path.join(test.root, "2026-07-30--2026-08-28");
    for (const filename of ["page-query.json", "devices.json", "countries.json", "totals.json"]) {
      const contents = await readFile(path.join(snapshotPath, filename), "utf8");
      expect(JSON.parse(contents)).toEqual({ rows: [] });
      expect(contents.endsWith("\n")).toBe(true);
      expect(contents).not.toMatch(/NaN|Infinity/);
    }
    const summary = await readFile(path.join(snapshotPath, "summary.md"), "utf8");
    expect(summary).toContain("| 0 | 0 | 0.00% | — |");
    expect(summary).not.toMatch(/NaN|Infinity/);
  });

  it("keeps extreme and non-finite adapter metrics out of serialized output", async () => {
    const test = await harness([
      {
        rows: [
          {
            keys: ["https://example.com/extreme-a", "extreme"],
            clicks: Number.MAX_VALUE,
            impressions: 1,
            ctr: Number.MAX_VALUE,
            position: 1,
          },
          {
            keys: ["https://example.com/extreme-b", "extreme"],
            clicks: Number.MAX_VALUE,
            impressions: 1,
            ctr: Number.MAX_VALUE,
            position: 1,
          },
        ],
      },
      {
        rows: [
          {
            keys: ["MOBILE"],
            clicks: Number.POSITIVE_INFINITY,
            impressions: Number.NaN,
            ctr: Number.NEGATIVE_INFINITY,
            position: Number.NaN,
          },
        ],
      },
      {},
      {
        rows: [
          {
            clicks: Number.MAX_VALUE,
            impressions: 1,
            ctr: Number.MAX_VALUE,
            position: 1,
          },
          {
            clicks: Number.MAX_VALUE,
            impressions: 1,
            ctr: Number.MAX_VALUE,
            position: 1,
          },
        ],
      },
      {},
    ]);

    await runCommand(["--site", "sc-domain:example.com"], test.adapter);

    const snapshotPath = path.join(test.root, "2026-07-30--2026-08-28");
    for (const filename of [
      "page-query.json",
      "devices.json",
      "countries.json",
      "totals.json",
      "manifest.json",
      "summary.md",
    ]) {
      expect(await readFile(path.join(snapshotPath, filename), "utf8")).not.toMatch(
        /NaN|Infinity/,
      );
    }
    const summary = await readFile(path.join(snapshotPath, "summary.md"), "utf8");
    expect(summary).toContain(
      "| https&#58;&#47;&#47;example&#46;com&#47;extreme&#45;a | 1.7976931348623157e+308 | 1 | 1.80e+310% | 1.00 |",
    );
    expect(summary).toContain("| — | 2 | — | 1.00 |");
    expect(summary).toContain("| extreme | — | 2 | — | 1.00 |");
    expect(summary).toContain(
      "Metrics beyond the finite numeric range are shown as —.",
    );
    expect(
      JSON.parse(await readFile(path.join(snapshotPath, "devices.json"), "utf8")),
    ).toEqual({
      rows: [
        {
          device: "MOBILE",
          clicks: 0,
          impressions: 0,
          ctr: 0,
          position: 0,
        },
      ],
    });
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
