import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assembleSnapshot,
  type CompletedSnapshotPull,
  type SnapshotAssemblyInput,
} from "../src/snapshot-assembly.js";

const fixtureRoot = fileURLToPath(new URL("fixtures/snapshot", import.meta.url));

function pull(
  rows: CompletedSnapshotPull["rows"],
  reportedIncompleteDates: readonly string[] = [],
): CompletedSnapshotPull {
  return { rows, reportedIncompleteDates };
}

function input(reverse = false): SnapshotAssemblyInput {
  const order = <T>(values: readonly T[]): readonly T[] =>
    reverse ? [...values].reverse() : values;

  return {
    provenance: {
      property: "sc-domain:example.com",
      requestedInterval: { start: null, end: null },
      effectiveInterval: { start: "2026-07-30", end: "2026-08-28" },
      adjustments: [
        {
          field: "start",
          reason: "defaulted-to-29-days-before-yesterday",
          requested: null,
          effective: "2026-07-30",
        },
        {
          field: "end",
          reason: "defaulted-to-yesterday",
          requested: null,
          effective: "2026-08-28",
        },
      ],
      pulledAt: "2026-08-29T12:34:56.000Z",
      packageIdentity: { name: "gsc-snapshot", version: "0.0.0" },
    },
    pulls: {
      pageQuery: pull(
        order([
          {
            keys: ["https://example.com/b", "alpha"],
            clicks: 3,
            impressions: 30,
            ctr: 0.1,
            position: 4,
          },
          {
            keys: ["https://example.com/a|pipe\nnext", "alpha"],
            clicks: 2,
            impressions: 10,
            ctr: 0.2,
            position: 2,
          },
          {
            keys: [undefined, undefined],
            clicks: Number.NaN,
            impressions: Number.POSITIVE_INFINITY,
            ctr: null,
          },
        ]),
        order(["2026-08-27"]),
      ),
      devices: pull(
        order([
          {
            keys: ["MOBILE"],
            clicks: 5,
            impressions: 100,
            ctr: 0.05,
            position: 3,
          },
          {
            keys: ["DESKTOP"],
            clicks: 10,
            impressions: 100,
            ctr: 0.1,
            position: 2,
          },
        ]),
      ),
      countries: pull(
        order([
          {
            keys: ["usa"],
            clicks: 2,
            impressions: 50,
            ctr: 0.04,
            position: 4,
          },
          {
            keys: ["can"],
            clicks: 3,
            impressions: 50,
            ctr: 0.06,
            position: 2,
          },
        ]),
        order(["2026-08-25"]),
      ),
      totals: pull([
        { clicks: 9, impressions: 80, ctr: 0.1125, position: 2.25 },
      ]),
      completeness: pull([], order(["2026-08-26"])),
    },
  };
}

describe("deterministic Snapshot assembly", () => {
  it("produces the complete golden Snapshot", async () => {
    const snapshot = assembleSnapshot(input());

    expect(snapshot.status).toBe("partial");
    expect(snapshot.files.map(({ filename }) => filename)).toEqual([
      "page-query.json",
      "devices.json",
      "countries.json",
      "totals.json",
      "manifest.json",
      "summary.md",
    ]);
    await Promise.all(
      snapshot.files.map(async ({ filename, contents }) => {
        expect(contents).toBe(await readFile(path.join(fixtureRoot, filename), "utf8"));
      }),
    );
  });

  it("produces identical bytes when source order changes", () => {
    expect(assembleSnapshot(input(true))).toEqual(assembleSnapshot(input()));
  });
});
