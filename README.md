# gsc-snapshot

`gsc-snapshot` creates a local, read-only Search Console snapshot for one date interval. Each snapshot contains Search Console source rows, provenance, completeness metadata, and a deterministic Markdown summary.

## Requirements

- Node.js 22 or newer
- Access to the selected Search Console property
- Google Application Default Credentials (ADC) with the Search Console read-only scope
- The Search Console API enabled in the Google Cloud project used for ADC quota

## Install

Pin the package as a development dependency in the project whose Search Console data you want to capture:

```sh
npm install --save-dev --save-exact gsc-snapshot@1.0.0
```

Replace `1.0.0` with the release you intend to use. Add a project-local script:

```json
{
  "devDependencies": {
    "gsc-snapshot": "1.0.0"
  },
  "scripts": {
    "search-console:snapshot": "gsc-snapshot --output reports/search-console"
  }
}
```

Run it with:

```sh
npm run search-console:snapshot
```

When npm runs the command, `gsc-snapshot` uses the directory containing the consuming project's active `package.json` as its working root. A direct invocation uses the current directory.

## Set up Google credentials

A human with access to the relevant Google Cloud project and Search Console property must complete this setup. The command does not install `gcloud`, enable APIs, create cloud projects, or start an OAuth flow.

1. Enable the Search Console API in the Google Cloud project that will provide quota.
2. Install and initialize the Google Cloud CLI.
3. Create user-level ADC with the read-only scope:

   ```sh
   gcloud auth application-default login \
     --scopes=https://www.googleapis.com/auth/webmasters.readonly
   ```

4. Confirm that the authenticated user can access the intended Search Console property.

If ADC is absent or rejected, the command exits with setup guidance. Refresh ADC by running the login command again.

## Command reference

```text
gsc-snapshot [--output PATH] [--site PROPERTY] [--start YYYY-MM-DD] [--end YYYY-MM-DD]
```

The command accepts each option at most once. It rejects positional arguments and unsupported options before authentication, network access, or output changes.

| Option | Meaning |
| --- | --- |
| `--output PATH` | Parent directory for interval directories. Relative paths resolve from the working root. An absolute path stays absolute. The default is the working root. |
| `--site PROPERTY` | Exact Search Console property identifier, such as `sc-domain:example.com` or `https://example.com/`. The value passes to Search Console unchanged. |
| `--start YYYY-MM-DD` | Inclusive start date interpreted in `America/Los_Angeles`. |
| `--end YYYY-MM-DD` | Inclusive end date interpreted in `America/Los_Angeles`. |

The first release supports web search data only. It does not expose a supported JavaScript library interface.

## Property discovery

When you omit `--site`, the command reads `homepage` from `package.json` at the working root and extracts its HTTP or HTTPS hostname. It then lists properties available to the ADC identity and chooses one by this order:

1. An exact `sc-domain:<hostname>` property.
2. The only URL-prefix property with the same hostname.

The command stops if no property matches. If several URL-prefix properties match, it prints the sorted candidates so you can rerun with `--site PROPERTY`. Supplying `--site` skips package metadata lookup and property listing.

## Date behavior

Search Console interprets dates in `America/Los_Angeles`, so the command calculates today and yesterday in that timezone. Dates must be real calendar dates in `YYYY-MM-DD` form. Future dates and intervals whose start follows their end fail before any external side effect.

| Request | Effective inclusive interval |
| --- | --- |
| No dates | Yesterday and the preceding 29 days. |
| Start only, more than 30 days before today | Requested start through 29 days after it. |
| Start only, within the last 30 days | Requested start through yesterday. |
| Start only, equal to today | Yesterday only. |
| End only, before today | Requested end and the preceding 29 days. |
| End only, equal to today | Yesterday and the preceding 29 days. |
| Start and end | The requested interval exactly. If both equal today, the interval becomes yesterday only. |

The manifest and summary retain the requested bounds, effective bounds, and every adjustment in order.

## Output

A successful command publishes one directory named `<effective-start>--<effective-end>` beneath the output parent:

```text
reports/search-console/
└── 2026-07-01--2026-07-30/
    ├── countries.json
    ├── devices.json
    ├── manifest.json
    ├── page-query.json
    ├── summary.md
    └── totals.json
```

The JSON datasets contain stable `rows` arrays:

- `page-query.json`: page, query, clicks, impressions, CTR, and position
- `devices.json`: device and metrics
- `countries.json`: country and metrics
- `totals.json`: whole-interval metrics

`manifest.json` records the property, intervals, adjustments, UTC pull time, requested data state, package version, completeness, fixed dataset names, and row counts. `summary.md` presents the same provenance with totals, the top 20 queries and pages by impressions, device and country totals, and the Search Console row-availability limitation.

The command writes and validates a temporary sibling directory before changing the interval directory. A failed pull leaves the previous complete interval in place when recovery is possible.

## Partial and final data

The command requests Search Console's `all` data state so recent source data and incompleteness metadata are available. A snapshot has one of two statuses:

- `final`: Search Console did not report an incomplete date.
- `partial`: Search Console reported provisional data. The manifest records the earliest `firstIncompleteDate`, and the summary displays it as a warning.

Search Console may return only top rows. Pagination retrieves every row the Search Analytics API makes available, but it cannot guarantee exhaustive source data.

## Security properties

- Authentication uses Google ADC and requests only `https://www.googleapis.com/auth/webmasters.readonly`.
- The command does not request a write-capable Search Console scope.
- The command does not launch interactive authentication.
- Credentials and authenticated identity remain runtime-only. Snapshot files omit credential paths, account identity, access tokens, refresh tokens, and OAuth details.
- User-facing Google API failures use redacted diagnostic categories rather than raw response details.
- The command passes an explicit `--site` value unchanged because Search Console property identifiers are opaque inputs.

Snapshot datasets can contain search queries and page URLs. Choose storage and access controls appropriate for that source data.

## Releases

Maintainers release from deliberate version tags through npm trusted publishing. See the [release guide](https://github.com/SirDarcanos/gsc-snapshot/blob/main/docs/releasing.md) for the human-owned prerequisites and the automated checks.

## License

MIT
