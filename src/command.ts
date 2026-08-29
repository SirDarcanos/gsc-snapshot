import path from "node:path";

export interface DateAdjustment {
  field: "start" | "end";
  reason:
    | "defaulted-to-29-days-before-yesterday"
    | "defaulted-to-yesterday"
    | "defaulted-to-30-day-cap"
    | "defaulted-to-29-days-before-end"
    | "replaced-today-with-yesterday";
  requested: string | null;
  effective: string;
}

export interface PreflightPlan {
  workingRoot: string;
  outputRoot: string;
  site: string | null;
  requestedInterval: {
    start: string | null;
    end: string | null;
  };
  effectiveInterval: {
    start: string;
    end: string;
  };
  adjustments: DateAdjustment[];
}

export interface CommandAdapter {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  now(): Date;
  execute(plan: PreflightPlan): Promise<void>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ParsedArguments {
  output: string | null;
  site: string | null;
  start: string | null;
  end: string | null;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    output: null,
    site: null,
    start: null,
    end: null,
  };
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    if (
      option !== "--output" &&
      option !== "--site" &&
      option !== "--start" &&
      option !== "--end"
    ) {
      throw new Error(`Unsupported argument: ${option}`);
    }
    if (seen.has(option)) {
      throw new Error(`Option ${option} may only be provided once`);
    }

    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`Option ${option} requires a value`);
    }

    seen.add(option);
    if (option === "--output") parsed.output = value;
    if (option === "--site") parsed.site = value;
    if (option === "--start") parsed.start = value;
    if (option === "--end") parsed.end = value;
  }

  return parsed;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return formatDate(value);
}

function todayInLosAngeles(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return formatDate(date) === value;
}

function validateDates(
  start: string | null,
  end: string | null,
  today: string,
): void {
  if (start !== null && !isCalendarDate(start)) {
    throw new Error(`Invalid start date: ${start}`);
  }
  if (end !== null && !isCalendarDate(end)) {
    throw new Error(`Invalid end date: ${end}`);
  }
  if (start !== null && start > today) {
    throw new Error("Start date cannot be after today");
  }
  if (end !== null && end > today) {
    throw new Error("End date cannot be after today");
  }
  if (start !== null && end !== null && start > end) {
    throw new Error("Start date cannot be after end date");
  }
}

function deriveInterval(
  requestedStart: string | null,
  requestedEnd: string | null,
  today: string,
): Pick<PreflightPlan, "requestedInterval" | "effectiveInterval" | "adjustments"> {
  const yesterday = addDays(today, -1);
  const requestedInterval = { start: requestedStart, end: requestedEnd };
  const adjustments: DateAdjustment[] = [];
  let start: string;
  let end: string;

  if (requestedStart === null && requestedEnd === null) {
    start = addDays(yesterday, -29);
    end = yesterday;
    adjustments.push(
      {
        field: "start",
        reason: "defaulted-to-29-days-before-yesterday",
        requested: null,
        effective: start,
      },
      {
        field: "end",
        reason: "defaulted-to-yesterday",
        requested: null,
        effective: end,
      },
    );
  } else if (requestedStart !== null && requestedEnd === null) {
    if (requestedStart === today) {
      start = yesterday;
      adjustments.push({
        field: "start",
        reason: "replaced-today-with-yesterday",
        requested: requestedStart,
        effective: start,
      });
    } else {
      start = requestedStart;
    }

    if (requestedStart < addDays(today, -30)) {
      end = addDays(start, 29);
      adjustments.push({
        field: "end",
        reason: "defaulted-to-30-day-cap",
        requested: null,
        effective: end,
      });
    } else {
      end = yesterday;
      adjustments.push({
        field: "end",
        reason: "defaulted-to-yesterday",
        requested: null,
        effective: end,
      });
    }
  } else if (requestedStart === null && requestedEnd !== null) {
    if (requestedEnd === today) {
      end = yesterday;
      adjustments.push({
        field: "end",
        reason: "replaced-today-with-yesterday",
        requested: requestedEnd,
        effective: end,
      });
    } else {
      end = requestedEnd;
    }
    start = addDays(end, -29);
    adjustments.push({
      field: "start",
      reason: "defaulted-to-29-days-before-end",
      requested: null,
      effective: start,
    });
  } else if (requestedStart === today && requestedEnd === today) {
    start = yesterday;
    end = yesterday;
    adjustments.push(
      {
        field: "start",
        reason: "replaced-today-with-yesterday",
        requested: requestedStart,
        effective: start,
      },
      {
        field: "end",
        reason: "replaced-today-with-yesterday",
        requested: requestedEnd,
        effective: end,
      },
    );
  } else {
    start = requestedStart as string;
    end = requestedEnd as string;
  }

  return {
    requestedInterval,
    effectiveInterval: { start, end },
    adjustments,
  };
}

export async function runCommand(
  argv: readonly string[],
  adapter: CommandAdapter,
): Promise<CommandResult> {
  try {
    const parsed = parseArguments(argv);
    const workingRoot = adapter.env.npm_package_json
      ? path.dirname(path.resolve(adapter.cwd, adapter.env.npm_package_json))
      : adapter.cwd;
    const today = todayInLosAngeles(adapter.now());
    validateDates(parsed.start, parsed.end, today);
    const interval = deriveInterval(parsed.start, parsed.end, today);

    const plan: PreflightPlan = {
      workingRoot,
      outputRoot:
        parsed.output === null
          ? workingRoot
          : path.resolve(workingRoot, parsed.output),
      site: parsed.site,
      ...interval,
    };

    await adapter.execute(plan);
    return { exitCode: 0, stderr: "", stdout: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { exitCode: 1, stderr: `Error: ${message}\n`, stdout: "" };
  }
}
