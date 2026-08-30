import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CommandExecution, PreflightPlan } from "./command.js";
import {
  assembleSnapshot,
  type CompletedSnapshotPull,
} from "./snapshot-assembly.js";

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
    startRow: number;
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

export interface SnapshotFileSystem {
  mkdir(directory: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  readFile(filename: string): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  rm(target: string): Promise<void>;
  writeFile(filename: string, contents: string): Promise<void>;
  exists(target: string): Promise<boolean>;
}

export interface SnapshotServices {
  authenticate(scopes: readonly string[]): Promise<AuthenticationResult>;
  listProperties(auth: unknown): Promise<readonly string[]>;
  query(auth: unknown, request: SearchAnalyticsRequest): Promise<SearchAnalyticsResponse>;
  now(): Date;
  packageIdentity: { name: string; version: string };
  filesystem?: SnapshotFileSystem;
}

const nodeFileSystem: SnapshotFileSystem = {
  mkdir: async (directory) => {
    await mkdir(directory, { recursive: true });
  },
  mkdtemp: (prefix) => mkdtemp(prefix),
  readFile: (filename) => readFile(filename, "utf8"),
  rename: (source, destination) => rename(source, destination),
  rm: async (target) => {
    await rm(target, { recursive: true, force: true });
  },
  writeFile: async (filename, contents) => {
    await writeFile(filename, contents);
  },
  exists: async (target) => {
    try {
      await stat(target);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  },
};

class SafeDiagnostic extends Error {}

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
): Promise<CompletedSnapshotPull> {
  const rows: SearchAnalyticsRow[] = [];
  const reportedIncompleteDates: string[] = [];
  let startRow = 0;

  while (true) {
    const requestBody: SearchAnalyticsRequest["requestBody"] = {
      startDate: plan.effectiveInterval.start,
      endDate: plan.effectiveInterval.end,
      type: "web",
      dataState: "all",
      rowLimit: 25_000,
      startRow,
      ...(dimensions === undefined ? {} : { dimensions }),
    };

    let response: SearchAnalyticsResponse;
    try {
      response = await services.query(auth, { siteUrl, requestBody });
    } catch (error) {
      throw searchConsoleDiagnostic(error);
    }

    const pageRows = response.rows ?? [];
    rows.push(...pageRows);
    if (typeof response.metadata?.firstIncompleteDate === "string") {
      reportedIncompleteDates.push(response.metadata.firstIncompleteDate);
    }
    if (pageRows.length < requestBody.rowLimit) break;
    startRow += pageRows.length;
  }

  return { rows, reportedIncompleteDates };
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

    const assembled = assembleSnapshot({
      provenance: {
        property,
        requestedInterval: plan.requestedInterval,
        effectiveInterval: plan.effectiveInterval,
        adjustments: plan.adjustments,
        pulledAt: services.now().toISOString(),
        packageIdentity: services.packageIdentity,
      },
      pulls: {
        pageQuery: pageQueryResponse,
        devices: devicesResponse,
        countries: countriesResponse,
        totals: totalsResponse,
        completeness: completenessResponse,
      },
    });
    const target = path.join(
      plan.outputRoot,
      `${plan.effectiveInterval.start}--${plan.effectiveInterval.end}`,
    );

    const filesystem = services.filesystem ?? nodeFileSystem;
    const files = new Map(
      assembled.files.map(({ filename, contents }) => [filename, contents]),
    );

    let temporary: string | null = null;
    let backup: string | null = null;
    try {
      await filesystem.mkdir(plan.outputRoot);
      temporary = await filesystem.mkdtemp(
        path.join(plan.outputRoot, ".gsc-snapshot-"),
      );
      for (const [filename, contents] of files) {
        await filesystem.writeFile(path.join(temporary, filename), contents);
      }
      for (const [filename, contents] of files) {
        const written = await filesystem.readFile(path.join(temporary, filename));
        if (written !== contents) {
          throw new Error(`Snapshot validation failed for ${filename}`);
        }
      }

      const stagedSnapshot = temporary;
      if (await filesystem.exists(target)) {
        try {
          // Use atomic replacement on filesystems that support replacing a directory.
          await filesystem.rename(stagedSnapshot, target);
          temporary = null;
        } catch {
          backup = path.join(
            plan.outputRoot,
            `.gsc-snapshot-backup-${randomUUID()}`,
          );
          await filesystem.rename(target, backup);
          try {
            await filesystem.rename(stagedSnapshot, target);
            temporary = null;
          } catch (error) {
            try {
              await filesystem.rename(backup, target);
              backup = null;
            } catch {
              // The prior complete snapshot remains recoverable at the backup path.
            }
            throw error;
          }
          const priorBackup = backup;
          await filesystem.rm(priorBackup).catch(async () => {
            // Cleanup is destructive and cannot safely trigger rollback once begun.
            await filesystem.rm(priorBackup).catch(() => undefined);
          });
          backup = null;
        }
      } else {
        await filesystem.rename(stagedSnapshot, target);
        temporary = null;
      }
    } catch {
      if (temporary !== null) {
        await filesystem.rm(temporary).catch(() => undefined);
      }
      throw new SafeDiagnostic(
        "Snapshot publication failed. Check the output path and try again.",
      );
    }

    return {
      stdout: `Created Search Console snapshot\nInterval: ${plan.effectiveInterval.start} to ${plan.effectiveInterval.end}\nProperty: ${property}\nStatus: ${assembled.status}\nPath: ${target}\n`,
    };
  };
}
