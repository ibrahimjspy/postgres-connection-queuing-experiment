import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type Summary = {
  name: string;
  count: number;
  rps: number;
  replicas: number;
  success: number;
  errors: number;
  workloadMs: number;
  dispatchSpanMs?: number;
  tailDrainMs?: number;
  completedPerSecond: number;
  requestP50Ms: number;
  requestP95Ms: number;
  acquireP95Ms: number;
  dbRoundTripP95Ms: number;
  healthP95Ms: number | null;
  fastP95Ms: number | null;
  peakNodeWaiting: number;
  peakBouncerWaiting: number;
  peakLoopDelayMs: number;
};

export type EventLoopImpact = {
  name: "event-loop-impact";
  blockerMs: number;
  victimCount: number;
  baselineP95Ms: number;
  victimP95Ms: number;
  victimHandlerP95Ms: number;
  victimDbRoundTripP95Ms: number;
  delayBeforeHandlerP95Ms: number;
  loopMaxMs: number;
  maxServerActiveDuringBlock: number;
  maxServerIdleDuringBlock: number;
  maxBouncerWaitingDuringBlock: number;
  success: number;
  errors: number;
};

export type RustEventLoopComparison = {
  name: "rust-event-loop-comparison";
  cases: Array<{
    name: string;
    mode: "inline" | "offloaded";
    asyncWorkers: number;
    blockerMs: number;
    victimCount: number;
    baselineP95Ms: number;
    victimP95Ms: number;
    preHandlerP95Ms: number;
    handlerP95Ms: number;
    dbRoundTripP95Ms: number;
    success: number;
    errors: number;
  }>;
};

type ResultFile = { timestamp: string; summary: Summary | EventLoopImpact | RustEventLoopComparison };

const measured = (name: string, count: number, values: Partial<Summary>): ResultFile => ({
  timestamp: "2026-09-06T20:20:12.747Z",
  summary: {
    name, count, rps: 0, replicas: 1, success: count, errors: 0,
    workloadMs: 0, completedPerSecond: 0, requestP50Ms: 0, requestP95Ms: 0,
    acquireP95Ms: 0, dbRoundTripP95Ms: 0, healthP95Ms: null, fastP95Ms: null,
    peakNodeWaiting: 0, peakBouncerWaiting: 0, peakLoopDelayMs: 0,
    ...values,
  },
});

/** Curated samples keep a fresh public clone educational before Docker experiments run. */
const bundledResults: ResultFile[] = [
  measured("requests-5", 5, { workloadMs: 517.18, requestP95Ms: 516.92, acquireP95Ms: 0.13, peakNodeWaiting: 1 }),
  measured("requests-10", 10, { workloadMs: 510.97, requestP95Ms: 510.82, acquireP95Ms: 0.13, peakNodeWaiting: 1 }),
  measured("requests-20", 20, { workloadMs: 1115.81, requestP95Ms: 1109.83, acquireP95Ms: 496.93, peakNodeWaiting: 10 }),
  measured("requests-40", 40, { workloadMs: 2026.67, requestP95Ms: 2020.31, acquireP95Ms: 1505.87, peakNodeWaiting: 30 }),
  measured("requests-80", 80, { workloadMs: 4049.01, requestP95Ms: 4027.61, acquireP95Ms: 3496.42, peakNodeWaiting: 70 }),
  measured("01-fast", 40, { requestP95Ms: 54.79, healthP95Ms: 5.98, fastP95Ms: 12.27 }),
  measured("02-slow-sql", 40, { requestP95Ms: 2169.31, healthP95Ms: 22.11, fastP95Ms: 1858.62, peakNodeWaiting: 35 }),
  measured("03-blocked-loop", 16, { requestP95Ms: 2442.11, healthP95Ms: 2237.71, fastP95Ms: 2239.18, peakLoopDelayMs: 2287.99 }),
  measured("04-slow-sql-three-replicas", 40, { replicas: 3, requestP95Ms: 2022.82, healthP95Ms: 8.42, fastP95Ms: 1721.89, peakBouncerWaiting: 20 }),
  measured("rate-5", 80, { rps: 5, requestP95Ms: 545.13, acquireP95Ms: 1.16, peakNodeWaiting: 1 }),
  measured("rate-10", 80, { rps: 10, requestP95Ms: 513.92, acquireP95Ms: 0.48, peakNodeWaiting: 1 }),
  measured("rate-15", 80, { rps: 15, requestP95Ms: 609.1, acquireP95Ms: 0.78, peakNodeWaiting: 2 }),
  measured("rate-20", 80, { rps: 20, requestP95Ms: 551.36, acquireP95Ms: 45.88, peakNodeWaiting: 2 }),
  measured("rate-30", 80, { rps: 30, requestP95Ms: 1723, acquireP95Ms: 1215.36, peakNodeWaiting: 27 }),
  measured("rate-burst", 80, { requestP95Ms: 4034.1, acquireP95Ms: 3514.66, peakNodeWaiting: 70 }),
  {
    timestamp: "2026-09-06T22:32:41.008Z",
    summary: {
      name: "event-loop-impact", blockerMs: 2000, victimCount: 9,
      baselineP95Ms: 12.67, victimP95Ms: 1927.17, victimHandlerP95Ms: 17.56,
      victimDbRoundTripP95Ms: 11.44, delayBeforeHandlerP95Ms: 1915.75,
      loopMaxMs: 2018.51, maxServerActiveDuringBlock: 0, maxServerIdleDuringBlock: 4,
      maxBouncerWaitingDuringBlock: 0, success: 9, errors: 0,
    },
  },
  {
    timestamp: "2026-09-07T00:00:00.000Z",
    summary: {
      name: "rust-event-loop-comparison",
      cases: [
        { name: "rust-one-worker-inline", mode: "inline", asyncWorkers: 1, blockerMs: 2000, victimCount: 9, baselineP95Ms: 9.21, victimP95Ms: 1911.76, preHandlerP95Ms: 1908.01, handlerP95Ms: 7.1, dbRoundTripP95Ms: 7.09, success: 9, errors: 0 },
        { name: "rust-two-workers-inline", mode: "inline", asyncWorkers: 2, blockerMs: 2000, victimCount: 9, baselineP95Ms: 6.84, victimP95Ms: 1911.42, preHandlerP95Ms: 1905.97, handlerP95Ms: 6.31, dbRoundTripP95Ms: 6.31, success: 9, errors: 0 },
        { name: "rust-two-workers-offloaded", mode: "offloaded", asyncWorkers: 2, blockerMs: 2000, victimCount: 9, baselineP95Ms: 5.53, victimP95Ms: 57.85, preHandlerP95Ms: 55.5, handlerP95Ms: 19.37, dbRoundTripP95Ms: 19.25, success: 9, errors: 0 },
      ],
    },
  },
];

function isStandardResult(result: ResultFile): result is ResultFile & { summary: Summary } {
  return "count" in result.summary;
}

/** The UI owns presentation. The experiment scripts remain the source of truth. */
export async function loadResults() {
  const resultsDirectory = path.resolve(process.cwd(), "..", "results");
  const names = (await readdir(resultsDirectory)).filter((name) => name.endsWith(".json"));
  const parsed: ResultFile[] = await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(path.join(resultsDirectory, name), "utf8")) as ResultFile),
  );

  // Local results replace bundled samples by name because their timestamps are newer.
  const latestByName = new Map<string, ResultFile>();
  for (const result of [...bundledResults, ...parsed].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    latestByName.set(result.summary.name, result);
  }

  const requestCounts = [...latestByName.values()]
    .filter(isStandardResult)
    .filter(({ summary }) => /^requests-\d+$/.test(summary.name))
    .map(({ timestamp, summary }) => ({ timestamp, ...summary }))
    .sort((a, b) => a.count - b.count);

  const firstLabNames = ["01-fast", "02-slow-sql", "03-blocked-loop", "04-slow-sql-three-replicas"];
  const firstLab = firstLabNames
    .map((name) => latestByName.get(name))
    .filter((result): result is ResultFile & { summary: Summary } => result !== undefined && isStandardResult(result))
    .map(({ timestamp, summary }) => ({ timestamp, ...summary }));

  const arrivalRates = [...latestByName.values()]
    .filter(isStandardResult)
    .filter(({ summary }) => /^rate-(5|10|15|20|30|burst)$/.test(summary.name))
    .map(({ timestamp, summary }) => ({ timestamp, ...summary }))
    .sort((a, b) => (a.rps || Number.POSITIVE_INFINITY) - (b.rps || Number.POSITIVE_INFINITY));

  const eventLoop = latestByName.get("event-loop-impact")?.summary as unknown as EventLoopImpact | undefined;
  const rustEventLoop = latestByName.get("rust-event-loop-comparison")?.summary as unknown as RustEventLoopComparison | undefined;

  return { requestCounts, firstLab, arrivalRates, eventLoop, rustEventLoop };
}
