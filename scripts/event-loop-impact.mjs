import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { discover } from './experiment.mjs';

const BLOCK_MS = 2000;
const START_DELAY_MS = 150;
const VICTIMS = 9;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => {
  const sorted = values.sort((a, b) => a - b);
  return +sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(2);
};

async function request(url, method = 'GET') {
  const started = performance.now();
  const response = await fetch(url, { method, signal: AbortSignal.timeout(10000) });
  return { status: response.status, elapsedMs: performance.now() - started, ...(await response.json()) };
}

const replicas = discover();
assert.equal(replicas.length, 1, 'Use one API: docker compose up -d --scale api=1 --wait');
const api = replicas[0].url;

// Warm every Node client so connection creation cannot explain the impacted latency.
const warm = await Promise.all(Array.from({ length: 10 }, () => request(`${api}/fast`)));
assert.ok(warm.every(result => result.status === 200));
const baseline = await Promise.all(Array.from({ length: VICTIMS }, () => request(`${api}/fast`)));
assert.ok(baseline.every(result => result.status === 200));
await request(`${api}/reset`, 'POST');

const observer = new pg.Client({ host: '127.0.0.1', port: 56439, database: 'pgbouncer', user: 'lab', password: 'lab-local-only', connectionTimeoutMillis: 5000, query_timeout: 5000 });
const observerErrors = [];
observer.on('error', error => observerErrors.push(error.message));
await observer.connect();

try {
  const scheduled = await request(`${api}/cpu-scheduled?ms=${BLOCK_MS}&delayMs=${START_DELAY_MS}`);
  assert.equal(scheduled.status, 202);

  // Enter the known blocking window, then send nine ordinary database requests.
  await delay(START_DELAY_MS + 100);
  const victimsPending = Array.from({ length: VICTIMS }, () => request(`${api}/fast`));
  const bouncerDuringBlock = [];
  for (const afterDispatchMs of [100, 600, 1200]) {
    await delay(afterDispatchMs - (bouncerDuringBlock.at(-1)?.afterDispatchMs ?? 0));
    bouncerDuringBlock.push({ afterDispatchMs, rows: (await observer.query('SHOW POOLS')).rows });
  }
  const victims = await Promise.all(victimsPending);
  const metrics = await request(`${api}/metrics`);

  assert.ok(victims.every(result => result.status === 200));
  assert.deepEqual(observerErrors, []);
  assert.ok(victims.every(result => result.elapsedMs > 1000), 'Victims did not land inside the blocking window');
  assert.ok(metrics.loop.maxMs > 1000, 'Event-loop monitor did not observe the block');

  const labPools = bouncerDuringBlock.flatMap(sample => sample.rows.filter(row => row.database === 'lab'));
  const maxServerActive = Math.max(0, ...labPools.map(row => Number(row.sv_active)));
  const maxBouncerWaiting = Math.max(0, ...labPools.map(row => Number(row.cl_waiting)));
  const maxServerIdle = Math.max(0, ...labPools.map(row => Number(row.sv_idle)));
  const summary = {
    name: 'event-loop-impact',
    blockerMs: BLOCK_MS,
    victimCount: VICTIMS,
    baselineP95Ms: percentile(baseline.map(result => result.elapsedMs), .95),
    victimP95Ms: percentile(victims.map(result => result.elapsedMs), .95),
    victimHandlerP95Ms: percentile(victims.map(result => result.handlerMs), .95),
    victimDbRoundTripP95Ms: percentile(victims.map(result => result.dbRoundTripMs), .95),
    delayBeforeHandlerP95Ms: percentile(victims.map(result => result.elapsedMs - result.handlerMs), .95),
    loopMaxMs: +metrics.loop.maxMs.toFixed(2),
    maxServerActiveDuringBlock: maxServerActive,
    maxServerIdleDuringBlock: maxServerIdle,
    maxBouncerWaitingDuringBlock: maxBouncerWaiting,
    success: victims.length,
    errors: 0,
  };
  const result = { timestamp: new Date().toISOString(), summary, scheduled, baseline, victims, bouncerDuringBlock, metrics, observerErrors };
  const path = `results/${new Date().toISOString().replaceAll(':', '-')}-event-loop-impact.json`;
  await writeFile(path, JSON.stringify(result, null, 2) + '\n');
  await writeFile('results/event-loop-impact-report.md', `# Lab 04 — one CPU-heavy request, nine victims

Generated ${result.timestamp}. One API process, Node pool=10, shared PgBouncer backend limit=10.

One scheduled route blocked JavaScript for ${BLOCK_MS}ms. Nine ordinary /fast requests arrived 100ms after the block began. The pool was warmed first, and the same nine requests were measured without the blocker as a baseline.

| Measurement | Result |
|---|---:|
| Baseline /fast p95 | ${summary.baselineP95Ms}ms |
| Impacted /fast p95 seen by client | ${summary.victimP95Ms}ms |
| Time before Node handler could run, p95 | ${summary.delayBeforeHandlerP95Ms}ms |
| Node handler time after it ran, p95 | ${summary.victimHandlerP95Ms}ms |
| Database round trip after handler ran, p95 | ${summary.victimDbRoundTripP95Ms}ms |
| Maximum event-loop delay | ${summary.loopMaxMs}ms |
| Maximum active PgBouncer servers sampled during block | ${summary.maxServerActiveDuringBlock} |
| Maximum idle PgBouncer servers sampled during block | ${summary.maxServerIdleDuringBlock} |
| PgBouncer clients waiting for a server during block | ${summary.maxBouncerWaitingDuringBlock} |
| Successful victim requests | ${summary.success}/${VICTIMS} |

The client latency minus handler time estimates time before Node invoked the HTTP handler. During that interval, the request may wait in the operating-system/network path; it has not reached the application query code. PgBouncer cannot assign a database connection for work Node has not sent. Sampling is every few hundred milliseconds and this is one local run.

Raw data: [event-loop-impact](${path.split('/').pop()})
`);
  console.log(JSON.stringify({ ...summary, path: 'results/event-loop-impact-report.md' }, null, 2));
} finally {
  await observer.end();
}
