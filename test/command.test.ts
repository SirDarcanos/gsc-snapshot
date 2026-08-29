import { describe, expect, it, vi } from "vitest";

import { runCommand, type PreflightPlan } from "../src/command.js";

function runtime(overrides: {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
} = {}) {
  const plans: PreflightPlan[] = [];

  return {
    plans,
    adapter: {
      cwd: overrides.cwd ?? "/workspace/project",
      env: overrides.env ?? {},
      now: () => overrides.now ?? new Date("2026-08-29T12:00:00.000Z"),
      execute: vi.fn(async (plan: PreflightPlan) => {
        plans.push(plan);
      }),
    },
  };
}

describe("gsc-snapshot command", () => {
  it("prepares the default complete 30-day interval from the direct working root", async () => {
    const harness = runtime();

    const result = await runCommand(
      ["--site", "sc-domain:example.com"],
      harness.adapter,
    );

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    expect(harness.plans).toEqual([
      {
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
        effectiveInterval: {
          start: "2026-07-30",
          end: "2026-08-28",
        },
        outputRoot: "/workspace/project",
        requestedInterval: { start: null, end: null },
        site: "sc-domain:example.com",
        workingRoot: "/workspace/project",
      },
    ]);
  });

  it("uses npm's active package directory for relative output resolution", async () => {
    const harness = runtime({
      cwd: "/workspace/launcher",
      env: { npm_package_json: "/consumer/site/package.json" },
    });

    const result = await runCommand(
      ["--site", "sc-domain:example.com", "--output", "reports/search-console"],
      harness.adapter,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.plans[0]).toMatchObject({
      workingRoot: "/consumer/site",
      outputRoot: "/consumer/site/reports/search-console",
    });
  });

  it("preserves an absolute output path", async () => {
    const harness = runtime();

    await runCommand(
      ["--site", "sc-domain:example.com", "--output", "/snapshots"],
      harness.adapter,
    );

    expect(harness.plans[0]?.outputRoot).toBe("/snapshots");
  });

  it("uses the Search Console timezone rather than the machine timezone", async () => {
    const harness = runtime({ now: new Date("2026-08-29T06:59:00.000Z") });

    await runCommand(["--site", "sc-domain:example.com"], harness.adapter);

    expect(harness.plans[0]?.effectiveInterval).toEqual({
      start: "2026-07-29",
      end: "2026-08-27",
    });
  });

  it.each([
    ["an unsupported option", ["--url", "https://example.com"], "Unsupported argument: --url"],
    ["a positional argument", ["example.com"], "Unsupported argument: example.com"],
    ["a missing value", ["--start"], "Option --start requires a value"],
    [
      "a value replaced by another option",
      ["--start", "--site", "sc-domain:example.com"],
      "Option --start requires a value",
    ],
    [
      "a duplicate option",
      ["--site", "one", "--site", "two"],
      "Option --site may only be provided once",
    ],
    ["a malformed date", ["--start", "2026-8-01"], "Invalid start date: 2026-8-01"],
    ["an impossible date", ["--end", "2026-02-30"], "Invalid end date: 2026-02-30"],
    ["a future start", ["--start", "2026-08-30"], "Start date cannot be after today"],
    ["a future end", ["--end", "2026-08-30"], "End date cannot be after today"],
    [
      "an inverted interval",
      ["--start", "2026-08-20", "--end", "2026-08-10"],
      "Start date cannot be after end date",
    ],
  ])("rejects %s before executing", async (_name, argv, message) => {
    const harness = runtime();

    const result = await runCommand(argv, harness.adapter);

    expect(result).toEqual({
      exitCode: 1,
      stderr: `Error: ${message}\n`,
      stdout: "",
    });
    expect(harness.adapter.execute).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "caps an old start-only request at 30 days",
      argv: ["--start", "2026-07-01"],
      requested: { start: "2026-07-01", end: null },
      effective: { start: "2026-07-01", end: "2026-07-30" },
      adjustments: [
        {
          field: "end",
          reason: "defaulted-to-30-day-cap",
          requested: null,
          effective: "2026-07-30",
        },
      ],
    },
    {
      name: "ends a start-only request from exactly 30 days ago yesterday",
      argv: ["--start", "2026-07-30"],
      requested: { start: "2026-07-30", end: null },
      effective: { start: "2026-07-30", end: "2026-08-28" },
      adjustments: [
        {
          field: "end",
          reason: "defaulted-to-yesterday",
          requested: null,
          effective: "2026-08-28",
        },
      ],
    },
    {
      name: "ends a recent start-only request yesterday",
      argv: ["--start", "2026-08-01"],
      requested: { start: "2026-08-01", end: null },
      effective: { start: "2026-08-01", end: "2026-08-28" },
      adjustments: [
        {
          field: "end",
          reason: "defaulted-to-yesterday",
          requested: null,
          effective: "2026-08-28",
        },
      ],
    },
    {
      name: "turns a start-only request for today into yesterday",
      argv: ["--start", "2026-08-29"],
      requested: { start: "2026-08-29", end: null },
      effective: { start: "2026-08-28", end: "2026-08-28" },
      adjustments: [
        {
          field: "start",
          reason: "replaced-today-with-yesterday",
          requested: "2026-08-29",
          effective: "2026-08-28",
        },
        {
          field: "end",
          reason: "defaulted-to-yesterday",
          requested: null,
          effective: "2026-08-28",
        },
      ],
    },
    {
      name: "starts an end-only request 29 days earlier",
      argv: ["--end", "2026-08-10"],
      requested: { start: null, end: "2026-08-10" },
      effective: { start: "2026-07-12", end: "2026-08-10" },
      adjustments: [
        {
          field: "start",
          reason: "defaulted-to-29-days-before-end",
          requested: null,
          effective: "2026-07-12",
        },
      ],
    },
    {
      name: "replaces an end-only request for today with yesterday",
      argv: ["--end", "2026-08-29"],
      requested: { start: null, end: "2026-08-29" },
      effective: { start: "2026-07-30", end: "2026-08-28" },
      adjustments: [
        {
          field: "end",
          reason: "replaced-today-with-yesterday",
          requested: "2026-08-29",
          effective: "2026-08-28",
        },
        {
          field: "start",
          reason: "defaulted-to-29-days-before-end",
          requested: null,
          effective: "2026-07-30",
        },
      ],
    },
    {
      name: "preserves an exact requested interval",
      argv: ["--start", "2026-08-01", "--end", "2026-08-20"],
      requested: { start: "2026-08-01", end: "2026-08-20" },
      effective: { start: "2026-08-01", end: "2026-08-20" },
      adjustments: [],
    },
    {
      name: "preserves today as the explicit end of a multi-day interval",
      argv: ["--start", "2026-08-20", "--end", "2026-08-29"],
      requested: { start: "2026-08-20", end: "2026-08-29" },
      effective: { start: "2026-08-20", end: "2026-08-29" },
      adjustments: [],
    },
    {
      name: "turns an exact today-only interval into yesterday",
      argv: ["--start", "2026-08-29", "--end", "2026-08-29"],
      requested: { start: "2026-08-29", end: "2026-08-29" },
      effective: { start: "2026-08-28", end: "2026-08-28" },
      adjustments: [
        {
          field: "start",
          reason: "replaced-today-with-yesterday",
          requested: "2026-08-29",
          effective: "2026-08-28",
        },
        {
          field: "end",
          reason: "replaced-today-with-yesterday",
          requested: "2026-08-29",
          effective: "2026-08-28",
        },
      ],
    },
  ])("$name", async ({ argv, requested, effective, adjustments }) => {
    const harness = runtime();

    const result = await runCommand(argv, harness.adapter);

    expect(result.exitCode).toBe(0);
    expect(harness.plans[0]).toMatchObject({
      requestedInterval: requested,
      effectiveInterval: effective,
      adjustments,
    });
  });
});
