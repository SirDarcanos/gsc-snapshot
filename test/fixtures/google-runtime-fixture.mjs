export function createGoogleServices(packageIdentity) {
  return {
    authenticate: async () => ({ ok: true, auth: Symbol("fixture auth") }),
    listProperties: async () => ["sc-domain:example.com"],
    query: async (_auth, request) => {
      const dimensions = request.requestBody.dimensions?.join(",");
      if (dimensions === "page,query") {
        return {
          rows: [
            {
              keys: ["https://example.com/", "example query"],
              clicks: 2,
              impressions: 10,
              ctr: 0.2,
              position: 3,
            },
          ],
        };
      }
      if (dimensions === "page") {
        return {
          rows: [
            {
              keys: ["https://example.com/"],
              clicks: 2,
              impressions: 10,
              ctr: 0.2,
              position: 3,
            },
          ],
        };
      }
      if (dimensions === "device") {
        return {
          rows: [
            {
              keys: ["DESKTOP"],
              clicks: 2,
              impressions: 10,
              ctr: 0.2,
              position: 3,
            },
          ],
        };
      }
      if (dimensions === "country") {
        return {
          rows: [
            {
              keys: ["usa"],
              clicks: 2,
              impressions: 10,
              ctr: 0.2,
              position: 3,
            },
          ],
        };
      }
      if (dimensions === "date") return { rows: [] };
      return {
        rows: [
          {
            clicks: 2,
            impressions: 10,
            ctr: 0.2,
            position: 3,
          },
        ],
      };
    },
    now: () => new Date("2026-08-29T12:34:56.000Z"),
    packageIdentity,
  };
}
