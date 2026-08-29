import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CommandExecution, PreflightPlan } from "./command.js";

export const WEBMASTERS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";

export interface SearchAnalyticsRequest {
  siteUrl: string;
  requestBody: {
    startDate: string;
    endDate: string;
    type: "web";
    dataState: "all";
    rowLimit: 25_000;
    startRow: 0;
    dimensions?: readonly string[];
  };
}

export interface SearchAnalyticsRow {
  keys?: readonly string[] | null;
  clicks?: number | null;
  impressions?: number | null;
  ctr?: number | null;
  position?: number | null;
}

export interface SearchAnalyticsResponse {
  rows?: readonly SearchAnalyticsRow[] | null;
  metadata?: { firstIncompleteDate?: string | null } | null;
}

type AuthenticationResult =
  | { ok: true; auth: unknown }
  | { ok: false; reason: "missing" | "rejected" };

export interface SnapshotServices {
  authenticate(scopes: readonly string[]): Promise<AuthenticationResult>;
  listProperties(auth: unknown): Promise<readonly string[]>;
  query(auth: unknown, request: SearchAnalyticsRequest): Promise<SearchAnalyticsResponse>;
  now(): Date;
  packageIdentity: { name: string; version: string };
}

interface MetricRow {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface DatasetDescriptor {
  filename: string;
  rowCount: number;
}

class SafeDiagnostic extends Error {}

function metric(row: SearchAnalyticsRow, field: keyof MetricRow): number {
  const value = row[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function metrics(row: SearchAnalyticsRow): MetricRow {
  return {
    clicks: metric(row, "clicks"),
    impressions: metric(row, "impressions"),
    ctr: metric(row, "ctr"),
    position: metric(row, "position"),
  };
}

function apiStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status ?? candidate.code;
  if (typeof status === "number") return status;
  if (typeof status === "string" && /^\d{3}$/.test(status)) return Number(status);
  return undefined;
}

function googleErrorReasons(error: unknown): string[] {
  if (typeof error !== "object" || error === null) return [];
  const candidate = error as {
    errors?: Array<{ reason?: unknown }>;
    response?: {
      data?: {
        error?: string | { errors?: Array<{ reason?: unknown }> };
      };
    };
  };
  const responseError = candidate.response?.data?.error;
  const errors = [
    ...(candidate.errors ?? []),
    ...(typeof responseError === "object" && responseError !== null
      ? (responseError.errors ?? [])
      : []),
  ];
  const reasons = errors
    .map(({ reason }) => reason)
    .filter((reason): reason is string => typeof reason === "string");
  if (responseError === "invalid_grant") reasons.push("invalid_grant");
  return reasons;
}

function searchConsoleDiagnostic(error: unknown): SafeDiagnostic {
  const status = apiStatus(error);
  const reasons = googleErrorReasons(error);
  if (
    status === 401 ||
    reasons.some((reason) =>
      ["authError", "invalid_grant", "insufficientPermissions"].includes(reason),
    )
  ) {
    return new SafeDiagnostic(
      "Application Default Credentials were rejected or lack the required read-only scope. Refresh your ADC and try again.",
    );
  }
  if (status === 403 && reasons.includes("forbidden")) {
    return new SafeDiagnostic(
      "Search Console property is inaccessible. Confirm the property identifier and your Search Console access.",
    );
  }
  if (
    status === 403 &&
    reasons.some((reason) =>
      ["accessNotConfigured", "serviceDisabled"].includes(reason),
    )
  ) {
    return new SafeDiagnostic(
      "The Search Console API is not enabled for the active Google Cloud project. Enable it and retry.",
    );
  }
  if (
    status === 403 &&
    reasons.some((reason) =>
      ["quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded"].includes(reason),
    )
  ) {
    return new SafeDiagnostic(
      "The Search Console API quota or rate limit was exceeded. Wait or adjust quota, then retry.",
    );
  }
  if (status === 403) {
    return new SafeDiagnostic(
      "Search Console rejected the request. Confirm API enablement, quota, credential scope, and property access.",
    );
  }
  return new SafeDiagnostic(
    "Search Console request failed. Check API availability and retry the snapshot.",
  );
}

async function queryView(
  services: SnapshotServices,
  auth: unknown,
  siteUrl: string,
  plan: PreflightPlan,
  dimensions?: readonly string[],
): Promise<SearchAnalyticsResponse> {
  const requestBody: SearchAnalyticsRequest["requestBody"] = {
    startDate: plan.effectiveInterval.start,
    endDate: plan.effectiveInterval.end,
    type: "web",
    dataState: "all",
    rowLimit: 25_000,
    startRow: 0,
    ...(dimensions === undefined ? {} : { dimensions }),
  };

  try {
    return await services.query(auth, { siteUrl, requestBody });
  } catch (error) {
    throw searchConsoleDiagnostic(error);
  }
}

async function homepageHostname(workingRoot: string): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(path.join(workingRoot, "package.json"), "utf8");
  } catch {
    throw new SafeDiagnostic(
      "Cannot discover a Search Console property because package.json is missing or unreadable at the working root. Add a valid homepage or use --site PROPERTY.",
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch {
    throw new SafeDiagnostic(
      "Cannot discover a Search Console property because package.json is invalid. Fix it or use --site PROPERTY.",
    );
  }
  const homepage =
    typeof manifest === "object" && manifest !== null && "homepage" in manifest
      ? (manifest as { homepage?: unknown }).homepage
      : undefined;
  if (typeof homepage !== "string" || homepage.length === 0) {
    throw new SafeDiagnostic(
      "Cannot discover a Search Console property because package.json has no valid homepage. Add an HTTP(S) homepage or use --site PROPERTY.",
    );
  }

  try {
    const url = new URL(homepage);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.hostname === ""
    ) {
      throw new Error("invalid homepage protocol");
    }
    return url.hostname;
  } catch {
    throw new SafeDiagnostic(
      "Cannot discover a Search Console property because package.json homepage is not a valid HTTP(S) URL. Fix it or use --site PROPERTY.",
    );
  }
}

function selectProperty(hostname: string, listed: readonly string[]): string {
  const domainProperty = `sc-domain:${hostname}`;
  if (listed.includes(domainProperty)) return domainProperty;

  const candidates = [...new Set(listed.filter((property) => {
    try {
      const url = new URL(property);
      return (
        !/[\u0000-\u001f\u007f]/.test(property) &&
        url.username === "" &&
        url.password === "" &&
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.hostname === hostname
      );
    } catch {
      return false;
    }
  }))].sort((left, right) => left.localeCompare(right));

  if (candidates.length === 1) return candidates[0] as string;
  if (candidates.length === 0) {
    throw new SafeDiagnostic(
      `No accessible Search Console property matches homepage hostname ${hostname}. Rerun with --site PROPERTY.`,
    );
  }
  throw new SafeDiagnostic(
    `Multiple accessible Search Console properties match homepage hostname ${hostname}:\n${candidates.map((candidate) => `- ${candidate}`).join("\n")}\nRerun with --site PROPERTY.`,
  );
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatRequested(value: string | null): string {
  return value ?? "(omitted)";
}

function renderSummary(input: {
  plan: PreflightPlan;
  property: string;
  status: "final" | "partial";
  firstIncompleteDate: string | null;
  totals: MetricRow[];
  datasets: Record<"pageQuery" | "devices" | "countries" | "totals", DatasetDescriptor>;
}): string {
  const total = input.totals[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const adjustments =
    input.plan.adjustments.length === 0
      ? "None."
      : input.plan.adjustments
          .map(
            (adjustment) =>
              `- ${adjustment.field}: ${adjustment.reason} (${formatRequested(adjustment.requested)} → ${adjustment.effective})`,
          )
          .join("\n");
  const completeness =
    input.status === "partial"
      ? `**Warning:** Search Console reports incomplete data beginning ${input.firstIncompleteDate}.`
      : "Search Console did not report an incomplete date for this pull.";

  return `# Search Console snapshot

**Property:** ${input.property}
**Requested interval:** ${formatRequested(input.plan.requestedInterval.start)} to ${formatRequested(input.plan.requestedInterval.end)}
**Effective interval:** ${input.plan.effectiveInterval.start} to ${input.plan.effectiveInterval.end}
**Status:** ${input.status}

${completeness}

## Adjustments

${adjustments}

## Totals

| Clicks | Impressions | CTR | Average position |
| ---: | ---: | ---: | ---: |
| ${total.clicks} | ${total.impressions} | ${(total.ctr * 100).toFixed(2)}% | ${total.position.toFixed(2)} |

## Dataset rows

| Dataset | Rows |
| --- | ---: |
| page-query.json | ${input.datasets.pageQuery.rowCount} |
| devices.json | ${input.datasets.devices.rowCount} |
| countries.json | ${input.datasets.countries.rowCount} |
| totals.json | ${input.datasets.totals.rowCount} |

Search Console may return only top rows; pagination does not guarantee exhaustive data.
`;
}

export function createSnapshotExecutor(
  services: SnapshotServices,
): (plan: PreflightPlan) => Promise<CommandExecution> {
  return async (plan) => {
    const discoveredHostname =
      plan.site === null ? await homepageHostname(plan.workingRoot) : null;

    let authentication: AuthenticationResult;
    try {
      authentication = await services.authenticate([WEBMASTERS_READONLY_SCOPE]);
    } catch {
      authentication = { ok: false, reason: "rejected" };
    }
    if (!authentication.ok) {
      if (authentication.reason === "missing") {
        throw new SafeDiagnostic(
          `Application Default Credentials were not found. Set them up with \`gcloud auth application-default login --scopes=${WEBMASTERS_READONLY_SCOPE}\` and try again.`,
        );
      }
      throw new SafeDiagnostic(
        "Application Default Credentials were rejected. Refresh your ADC and try again.",
      );
    }

    let property: string;
    if (plan.site !== null) {
      property = plan.site;
    } else {
      let listed: readonly string[];
      try {
        listed = await services.listProperties(authentication.auth);
      } catch (error) {
        throw searchConsoleDiagnostic(error);
      }
      property = selectProperty(discoveredHostname as string, listed);
    }

    const [
      pageQueryResponse,
      devicesResponse,
      countriesResponse,
      totalsResponse,
      completenessResponse,
    ] = await Promise.all([
      queryView(services, authentication.auth, property, plan, ["page", "query"]),
      queryView(services, authentication.auth, property, plan, ["device"]),
      queryView(services, authentication.auth, property, plan, ["country"]),
      queryView(services, authentication.auth, property, plan),
      // Search Console returns firstIncompleteDate only for date-grouped data.
      queryView(services, authentication.auth, property, plan, ["date"]),
    ]);

    const pageQueryRows = (pageQueryResponse.rows ?? []).map((row) => ({
      page: row.keys?.[0] ?? "",
      query: row.keys?.[1] ?? "",
      ...metrics(row),
    }));
    const deviceRows = (devicesResponse.rows ?? []).map((row) => ({
      device: row.keys?.[0] ?? "",
      ...metrics(row),
    }));
    const countryRows = (countriesResponse.rows ?? []).map((row) => ({
      country: row.keys?.[0] ?? "",
      ...metrics(row),
    }));
    const totalRows = (totalsResponse.rows ?? []).map(metrics);
    const incompleteDates = [
      pageQueryResponse,
      devicesResponse,
      countriesResponse,
      totalsResponse,
      completenessResponse,
    ]
      .map((response) => response.metadata?.firstIncompleteDate)
      .filter((date): date is string => typeof date === "string")
      .sort();
    const firstIncompleteDate = incompleteDates[0] ?? null;
    const status = firstIncompleteDate === null ? "final" : "partial";
    const datasets = {
      pageQuery: { filename: "page-query.json", rowCount: pageQueryRows.length },
      devices: { filename: "devices.json", rowCount: deviceRows.length },
      countries: { filename: "countries.json", rowCount: countryRows.length },
      totals: { filename: "totals.json", rowCount: totalRows.length },
    } satisfies Record<string, DatasetDescriptor>;
    const manifest = {
      property,
      searchType: "web",
      requestedInterval: plan.requestedInterval,
      effectiveInterval: plan.effectiveInterval,
      adjustments: plan.adjustments,
      pulledAt: services.now().toISOString(),
      requestedDataState: "all",
      status,
      firstIncompleteDate,
      package: services.packageIdentity,
      datasets,
    };
    const target = path.join(
      plan.outputRoot,
      `${plan.effectiveInterval.start}--${plan.effectiveInterval.end}`,
    );

    let temporary: string | null = null;
    try {
      await mkdir(plan.outputRoot, { recursive: true });
      temporary = await mkdtemp(path.join(plan.outputRoot, ".gsc-snapshot-"));
      await Promise.all([
        writeFile(path.join(temporary, "page-query.json"), serialize({ rows: pageQueryRows })),
        writeFile(path.join(temporary, "devices.json"), serialize({ rows: deviceRows })),
        writeFile(path.join(temporary, "countries.json"), serialize({ rows: countryRows })),
        writeFile(path.join(temporary, "totals.json"), serialize({ rows: totalRows })),
        writeFile(path.join(temporary, "manifest.json"), serialize(manifest)),
        writeFile(
          path.join(temporary, "summary.md"),
          renderSummary({
            plan,
            property,
            status,
            firstIncompleteDate,
            totals: totalRows,
            datasets,
          }),
        ),
      ]);
      await rename(temporary, target);
    } catch {
      if (temporary !== null) {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
      throw new SafeDiagnostic(
        "Snapshot publication failed. Check the output path and try again.",
      );
    }

    return {
      stdout: `Created Search Console snapshot\nInterval: ${plan.effectiveInterval.start} to ${plan.effectiveInterval.end}\nProperty: ${property}\nStatus: ${status}\nPath: ${target}\n`,
    };
  };
}
