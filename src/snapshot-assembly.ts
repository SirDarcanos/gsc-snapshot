import type { DateAdjustment } from "./command.js";

const SEARCH_CONSOLE_ROW_WARNING =
  "Search Console may return only top rows; pagination does not guarantee exhaustive data.";

export interface SnapshotSourceRow {
  keys?: readonly (string | undefined)[] | null;
  clicks?: number | null;
  impressions?: number | null;
  ctr?: number | null;
  position?: number | null;
}

export interface CompletedSnapshotPull {
  rows: readonly SnapshotSourceRow[];
  reportedIncompleteDates: readonly string[];
}

export interface SnapshotProvenance {
  property: string;
  requestedInterval: {
    start: string | null;
    end: string | null;
  };
  effectiveInterval: {
    start: string;
    end: string;
  };
  adjustments: readonly DateAdjustment[];
  pulledAt: string;
  packageIdentity: {
    name: string;
    version: string;
  };
}

export interface SnapshotAssemblyInput {
  provenance: SnapshotProvenance;
  pulls: {
    pageQuery: CompletedSnapshotPull;
    devices: CompletedSnapshotPull;
    countries: CompletedSnapshotPull;
    totals: CompletedSnapshotPull;
    completeness: CompletedSnapshotPull;
  };
}

export type SnapshotFilename =
  | "page-query.json"
  | "devices.json"
  | "countries.json"
  | "totals.json"
  | "manifest.json"
  | "summary.md";

export interface SnapshotFile<Name extends SnapshotFilename = SnapshotFilename> {
  filename: Name;
  contents: string;
}

export type SnapshotFiles = readonly [
  SnapshotFile<"page-query.json">,
  SnapshotFile<"devices.json">,
  SnapshotFile<"countries.json">,
  SnapshotFile<"totals.json">,
  SnapshotFile<"manifest.json">,
  SnapshotFile<"summary.md">,
];

export interface AssembledSnapshot {
  status: "final" | "partial";
  files: SnapshotFiles;
}

interface MetricRow {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface PageQueryMetricRow extends MetricRow {
  page: string;
  query: string;
}

interface DimensionMetricRow extends MetricRow {
  [dimension: string]: string | number;
}

interface SummaryMetric {
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
}

interface SummaryRow extends SummaryMetric {
  label: string;
}

interface DatasetDescriptor {
  filename: string;
  rowCount: number;
}

function metric(row: SnapshotSourceRow, field: keyof MetricRow): number {
  const value = row[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function metrics(row: SnapshotSourceRow): MetricRow {
  return {
    clicks: metric(row, "clicks"),
    impressions: metric(row, "impressions"),
    ctr: metric(row, "ctr"),
    position: metric(row, "position"),
  };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatRequested(value: string | null): string {
  return value ?? "(omitted)";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareMetricRows(left: MetricRow, right: MetricRow): number {
  return (
    compareNumber(left.clicks, right.clicks) ||
    compareNumber(left.impressions, right.impressions) ||
    compareNumber(left.ctr, right.ctr) ||
    compareNumber(left.position, right.position)
  );
}

function aggregateMetrics(rows: readonly MetricRow[]): SummaryMetric {
  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;
  for (const row of rows) {
    clicks += row.clicks;
    impressions += row.impressions;
    weightedPosition += row.position * row.impressions;
  }
  const safeClicks = Number.isFinite(clicks) ? clicks : null;
  const safeImpressions = Number.isFinite(impressions) ? impressions : null;
  const ctr =
    safeClicks !== null && safeImpressions !== null
      ? safeImpressions > 0
        ? safeClicks / safeImpressions
        : 0
      : null;
  const position =
    safeImpressions !== null && safeImpressions > 0
      ? weightedPosition / safeImpressions
      : null;
  return {
    clicks: safeClicks,
    impressions: safeImpressions,
    ctr: ctr !== null && Number.isFinite(ctr) ? ctr : null,
    position:
      position !== null && Number.isFinite(position) ? position : null,
  };
}

function groupMetrics<T extends MetricRow>(
  rows: readonly T[],
  label: (row: T) => string,
): SummaryRow[] {
  const groups = new Map<string, MetricRow[]>();
  for (const row of rows) {
    const key = label(row);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return [...groups]
    .map(([groupLabel, groupRows]) => ({
      label: groupLabel,
      ...aggregateMetrics(groupRows),
    }))
    .sort((left, right) => {
      if (left.impressions === null && right.impressions !== null) return 1;
      if (left.impressions !== null && right.impressions === null) return -1;
      if (left.impressions !== null && right.impressions !== null) {
        const impressionOrder = compareNumber(right.impressions, left.impressions);
        if (impressionOrder !== 0) return impressionOrder;
      }
      return compareText(left.label, right.label);
    });
}

function escapeMarkdown(value: string): string {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) =>
      line.replace(
        /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g,
        (character) => `&#${character.codePointAt(0)};`,
      ),
    )
    .join("<br>");
}

function formatCount(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatPercentage(ratio: number | null): string {
  if (ratio === null) return "—";
  const percentage = ratio * 100;
  if (Number.isFinite(percentage)) return `${percentage.toFixed(2)}%`;

  const match = /^(.*)e([+-])(\d+)$/.exec(ratio.toExponential(2));
  if (match === null) return "—";
  const exponent = Number(match[3]) + 2;
  return `${match[1]}e${match[2]}${exponent}%`;
}

function renderMetricTable(
  title: string,
  labelHeading: string,
  rows: readonly SummaryRow[],
  limit?: number,
): string {
  const selected = limit === undefined ? rows : rows.slice(0, limit);
  const body = selected
    .map(
      (row) =>
        `| ${escapeMarkdown(row.label)} | ${formatCount(row.clicks)} | ${formatCount(row.impressions)} | ${formatPercentage(row.ctr)} | ${row.position === null ? "—" : row.position.toFixed(2)} |`,
    )
    .join("\n");
  return `## ${title}\n\n| ${labelHeading} | Clicks | Impressions | CTR | Average position |\n| --- | ---: | ---: | ---: | ---: |${body === "" ? "" : `\n${body}`}\n`;
}

function renderSummary(input: {
  provenance: SnapshotProvenance;
  status: "final" | "partial";
  firstIncompleteDate: string | null;
  pageQuery: PageQueryMetricRow[];
  devices: DimensionMetricRow[];
  countries: DimensionMetricRow[];
  totals: MetricRow[];
  datasets: Record<"pageQuery" | "devices" | "countries" | "totals", DatasetDescriptor>;
}): string {
  const total = aggregateMetrics(input.totals);
  const topQueries = groupMetrics(input.pageQuery, (row) => row.query);
  const topPages = groupMetrics(input.pageQuery, (row) => row.page);
  const devices = groupMetrics(input.devices, (row) => String(row.device));
  const countries = groupMetrics(input.countries, (row) => String(row.country));
  const adjustments =
    input.provenance.adjustments.length === 0
      ? "None."
      : input.provenance.adjustments
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

**Property:** ${escapeMarkdown(input.provenance.property)}
**Requested interval:** ${formatRequested(input.provenance.requestedInterval.start)} to ${formatRequested(input.provenance.requestedInterval.end)}
**Effective interval:** ${input.provenance.effectiveInterval.start} to ${input.provenance.effectiveInterval.end}
**Status:** ${input.status}

${completeness}

## Adjustments

${adjustments}

## Totals

| Clicks | Impressions | CTR | Average position |
| ---: | ---: | ---: | ---: |
| ${formatCount(total.clicks)} | ${formatCount(total.impressions)} | ${formatPercentage(total.ctr)} | ${total.position === null ? "—" : total.position.toFixed(2)} |

For rows with zero impressions, CTR is 0.00% and average position is —. Metrics beyond the finite numeric range are shown as —.

${renderMetricTable("Top queries", "Query", topQueries, 20)}
${renderMetricTable("Top pages", "Page", topPages, 20)}
${renderMetricTable("Devices", "Device", devices)}
${renderMetricTable("Countries", "Country", countries)}
## Dataset rows

| Dataset | Rows |
| --- | ---: |
| page-query.json | ${input.datasets.pageQuery.rowCount} |
| devices.json | ${input.datasets.devices.rowCount} |
| countries.json | ${input.datasets.countries.rowCount} |
| totals.json | ${input.datasets.totals.rowCount} |

${SEARCH_CONSOLE_ROW_WARNING}
`;
}

export function assembleSnapshot(input: SnapshotAssemblyInput): AssembledSnapshot {
  const pageQueryRows = input.pulls.pageQuery.rows
    .map((row) => ({
      page: row.keys?.[0] ?? "",
      query: row.keys?.[1] ?? "",
      ...metrics(row),
    }))
    .sort(
      (left, right) =>
        compareText(left.page, right.page) ||
        compareText(left.query, right.query) ||
        compareMetricRows(left, right),
    );
  const deviceRows = input.pulls.devices.rows
    .map((row) => ({
      device: row.keys?.[0] ?? "",
      ...metrics(row),
    }))
    .sort(
      (left, right) =>
        compareText(left.device, right.device) || compareMetricRows(left, right),
    );
  const countryRows = input.pulls.countries.rows
    .map((row) => ({
      country: row.keys?.[0] ?? "",
      ...metrics(row),
    }))
    .sort(
      (left, right) =>
        compareText(left.country, right.country) || compareMetricRows(left, right),
    );
  const totalRows = input.pulls.totals.rows.map(metrics).sort(compareMetricRows);
  const firstIncompleteDate = [
    ...input.pulls.pageQuery.reportedIncompleteDates,
    ...input.pulls.devices.reportedIncompleteDates,
    ...input.pulls.countries.reportedIncompleteDates,
    ...input.pulls.totals.reportedIncompleteDates,
    ...input.pulls.completeness.reportedIncompleteDates,
  ].sort()[0] ?? null;
  const status = firstIncompleteDate === null ? "final" : "partial";
  const datasets = {
    pageQuery: { filename: "page-query.json", rowCount: pageQueryRows.length },
    devices: { filename: "devices.json", rowCount: deviceRows.length },
    countries: { filename: "countries.json", rowCount: countryRows.length },
    totals: { filename: "totals.json", rowCount: totalRows.length },
  } satisfies Record<string, DatasetDescriptor>;
  const manifest = {
    property: input.provenance.property,
    searchType: "web",
    requestedInterval: input.provenance.requestedInterval,
    effectiveInterval: input.provenance.effectiveInterval,
    adjustments: input.provenance.adjustments,
    pulledAt: input.provenance.pulledAt,
    requestedDataState: "all",
    rowAvailability: SEARCH_CONSOLE_ROW_WARNING,
    status,
    firstIncompleteDate,
    package: input.provenance.packageIdentity,
    datasets,
  };

  return {
    status,
    files: [
      { filename: "page-query.json", contents: serialize({ rows: pageQueryRows }) },
      { filename: "devices.json", contents: serialize({ rows: deviceRows }) },
      { filename: "countries.json", contents: serialize({ rows: countryRows }) },
      { filename: "totals.json", contents: serialize({ rows: totalRows }) },
      { filename: "manifest.json", contents: serialize(manifest) },
      {
        filename: "summary.md",
        contents: renderSummary({
          provenance: input.provenance,
          status,
          firstIncompleteDate,
          pageQuery: pageQueryRows,
          devices: deviceRows,
          countries: countryRows,
          totals: totalRows,
          datasets,
        }),
      },
    ],
  };
}
