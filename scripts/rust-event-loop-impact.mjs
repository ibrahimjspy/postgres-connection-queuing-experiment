import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const BLOCK_MS = 2000;
const START_DELAY_MS = 150;
const VICTIMS = 9;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => {
  const sorted = values.sort((a, b) => a - b);
  return +sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(2);
};

function serviceUrl(service) {
  const id = execFileSync('docker', ['compose', '--profile', 'rust', 'ps', '-q', service], { encoding: 'utf8' }).trim();
  if (!id) throw new Error(`Start the Rust lab first: npm run rust:up`);
  const container = JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' }))[0];
  return `http://127.0.0.1:${container.NetworkSettings.Ports['3000/tcp'][0].HostPort}`;
}

async function request(url) {
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  return { status: response.status, elapsed_ms: performance.now() - started, ...(await response.json()) };
}

async function runCase({ name, service, expectedWorkers, mode }) {
  const url = serviceUrl(service);
  const health = await request(`${url}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.asyncWorkers, expectedWorkers);

  const warm = await Promise.all(Array.from({ length: 10 }, () => request(`${url}/fast`)));
  assert.ok(warm.every(result => result.status === 200));
  const baseline = await Promise.all(Array.from({ length: VICTIMS }, () => request(`${url}/fast`)));

  const scheduled = await request(`${url}/cpu-scheduled?ms=${BLOCK_MS}&delay_ms=${START_DELAY_MS}&mode=${mode}`);
  assert.equal(scheduled.status, 202);
  await delay(START_DELAY_MS + 100);
  const victims = await Promise.all(Array.from({ length: VICTIMS }, () => request(`${url}/fast`)));
  assert.ok(victims.every(result => result.status === 200));

  const summary = {
    name,
    mode,
    asyncWorkers: expectedWorkers,
    blockerMs: BLOCK_MS,
    victimCount: VICTIMS,
    baselineP95Ms: percentile(baseline.map(result => result.elapsed_ms), .95),
    victimP95Ms: percentile(victims.map(result => result.elapsed_ms), .95),
    preHandlerP95Ms: percentile(victims.map(result => result.elapsed_ms - result.handler_ms), .95),
    handlerP95Ms: percentile(victims.map(result => result.handler_ms), .95),
    dbRoundTripP95Ms: percentile(victims.map(result => result.db_round_trip_ms), .95),
    success: victims.filter(result => result.status === 200).length,
    errors: victims.filter(result => result.status !== 200).length,
  };

  // In responsive cases the CPU task is still running after victims finish; isolate the next case.
  await delay(BLOCK_MS + START_DELAY_MS + 100);
  return { summary, baseline, victims, scheduled };
}

const cases = [
  { name: 'rust-one-worker-inline', service: 'rust-api-one-thread', expectedWorkers: 1, mode: 'inline' },
  { name: 'rust-two-workers-inline', service: 'rust-api', expectedWorkers: 2, mode: 'inline' },
  { name: 'rust-two-workers-offloaded', service: 'rust-api', expectedWorkers: 2, mode: 'offloaded' },
];

const results = [];
for (const testCase of cases) results.push(await runCase(testCase));

console.log(JSON.stringify(results.map(result => result.summary), null, 2));

assert.ok(results[0].summary.victimP95Ms > 1000, 'One-worker inline case should delay the victims');
assert.ok(results[1].summary.victimP95Ms > 1000, 'This lab expects inline CPU to delay the server even with a second worker');
assert.ok(results[2].summary.victimP95Ms < 500, 'spawn_blocking should keep async workers responsive');

const summary = { name: 'rust-event-loop-comparison', cases: results.map(result => result.summary) };
const timestamp = new Date().toISOString();
const rawPath = `results/${timestamp.replaceAll(':', '-')}-rust-event-loop-comparison.json`;
await writeFile(rawPath, JSON.stringify({ timestamp, summary, results }, null, 2) + '\n');

const rows = results.map(({ summary: item }) =>
  `| ${item.asyncWorkers} | ${item.mode} | ${item.baselineP95Ms} | ${item.victimP95Ms} | ${item.preHandlerP95Ms} | ${item.handlerP95Ms} | ${item.dbRoundTripP95Ms} | ${item.success}/${item.victimCount} |`
);
await writeFile('results/rust-event-loop-report.md', `# Rust/Tokio event-loop comparison

Generated ${timestamp}. Each case schedules one 2,000ms CPU task, then sends nine ordinary SELECT 1 requests through a 10-client Rust pool and the shared PgBouncer.

| Tokio async workers | CPU placement | Baseline p95 ms | Victim p95 ms | Before handler p95 ms | Handler p95 ms | DB round trip p95 ms | Successful |
|---:|---|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

Inline CPU work performs no await and occupies a Tokio core worker. With one async worker it reproduces the Node-style stall. In this Axum run, merely configuring two workers did not protect new requests: the relevant server tasks were still scheduled behind the blocking task. Extra runtime threads are capacity, not request isolation. spawn_blocking explicitly moved the CPU closure to Tokio's dedicated blocking pool and kept the async request path responsive. This is one local run; sufficient simultaneous CPU tasks can still saturate every core or blocking-pool worker.

Raw data: [rust-event-loop-comparison](${rawPath.split('/').pop()})
`);
console.log(JSON.stringify({ summary, report: 'results/rust-event-loop-report.md' }, null, 2));
