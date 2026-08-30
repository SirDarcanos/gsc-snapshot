import { searchconsole, searchconsole_v1 } from "@googleapis/searchconsole";
import { GoogleAuth } from "google-auth-library";

import type {
  SearchAnalyticsRequest,
  SearchAnalyticsResponse,
  SnapshotServices,
} from "./snapshot.js";

function isMissingAdc(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("Could not load the default credentials") ||
    ("code" in error && error.code === "ENOENT")
  );
}

export function createGoogleServices(
  packageIdentity: SnapshotServices["packageIdentity"],
): SnapshotServices {
  return {
    authenticate: async (scopes) => {
      try {
        const auth = new GoogleAuth({ scopes: [...scopes] });
        await auth.getClient();
        await auth.getAccessToken();
        return { ok: true, auth };
      } catch (error) {
        return { ok: false, reason: isMissingAdc(error) ? "missing" : "rejected" };
      }
    },
    listProperties: async (auth) => {
      const client = searchconsole({
        version: "v1",
        // See the matching google-auth-library note in query below.
        auth: auth as never,
      });
      const response = await client.sites.list();
      return (response.data.siteEntry ?? [])
        .filter((entry) => entry.permissionLevel !== "siteUnverifiedUser")
        .map((entry) => entry.siteUrl)
        .filter((siteUrl): siteUrl is string => typeof siteUrl === "string");
    },
    query: async (auth, request: SearchAnalyticsRequest) => {
      const client = searchconsole({
        version: "v1",
        // @googleapis/searchconsole currently carries a second google-auth-library
        // type instance. Both packages accept the same runtime GoogleAuth object.
        auth: auth as never,
      });
      const params: searchconsole_v1.Params$Resource$Searchanalytics$Query = {
        siteUrl: request.siteUrl,
        requestBody: {
          startDate: request.requestBody.startDate,
          endDate: request.requestBody.endDate,
          type: request.requestBody.type,
          dataState: request.requestBody.dataState,
          rowLimit: request.requestBody.rowLimit,
          startRow: request.requestBody.startRow,
          ...(request.requestBody.dimensions === undefined
            ? {}
            : { dimensions: [...request.requestBody.dimensions] }),
        },
      };
      const response = await client.searchanalytics.query(params);
      return response.data as SearchAnalyticsResponse;
    },
    now: () => new Date(),
    packageIdentity,
  };
}
