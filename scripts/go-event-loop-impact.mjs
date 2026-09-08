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
  const id = execFileSync('docker', ['compose', '--profile', 'go', 'ps', '-q', service], { encoding: 'utf8' }).trim();
  if (!id) throw new Error('Start the Go lab first: npm run go:up');
  const container = JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' }))[0];
  return `http://127.0.0.1:${container.NetworkSettings.Ports['3000/tcp'][0].HostPort}`;
}

async function request(url) {
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  return { status: response.status, elapsed_ms: performance.now() - started, ...(await response.json()) };
}

async function runCase({ name, service, expectedProcs, cpuTasks }) {
  const url = serviceUrl(service);
  const health = await request(`${url}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.goMaxProcs, expectedProcs);

  const warm = await Promise.all(Array.from({ length: 10 }, () => request(`${url}/fast`)));
  assert.ok(warm.every(result => result.status === 200));
  const baseline = await Promise.all(Array.from({ length: VICTIMS }, () => request(`${url}/fast`)));

  const scheduled = await request(`${url}/cpu-scheduled?ms=${BLOCK_MS}&delay_ms=${START_DELAY_MS}&count=${cpuTasks}`);
  assert.equal(scheduled.status, 202);
  await delay(START_DELAY_MS + 100);
  const victims = await Promise.all(Array.from({ length: VICTIMS }, () => request(`${url}/fast`)));
  assert.ok(victims.every(result => result.status === 200));

  const summary = {
    name,
    goMaxProcs: expectedProcs,
    cpuTasks,
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

  // CPU goroutines may still be running after responsive victims complete.
  await delay(BLOCK_MS + START_DELAY_MS + 100);
  return { summary, baseline, victims, scheduled };
}

const cases = [
  { name: 'go-one-proc-one-cpu-task', service: 'go-api-one-proc', expectedProcs: 1, cpuTasks: 1 },
  { name: 'go-two-procs-one-cpu-task', service: 'go-api-two-procs', expectedProcs: 2, cpuTasks: 1 },
  { name: 'go-two-procs-four-cpu-tasks', service: 'go-api-two-procs', expectedProcs: 2, cpuTasks: 4 },
];

const results = [];
for (const testCase of cases) results.push(await runCase(testCase));
console.log(JSON.stringify(results.map(result => result.summary), null, 2));

assert.ok(results.every(result => result.summary.success === VICTIMS && result.summary.errors === 0));
assert.ok(results[0].summary.victimP95Ms < 500, 'Go should preempt one CPU goroutine even with GOMAXPROCS=1');
assert.ok(results[1].summary.victimP95Ms < 500, 'The two-processor case should remain responsive');
assert.ok(results[2].summary.victimP95Ms < 500, 'The saturated case should still schedule request goroutines');
assert.ok(results[2].summary.victimP95Ms > results[1].summary.victimP95Ms, 'Extra CPU contention should increase latency in this lab');

const summary = { name: 'go-event-loop-comparison', cases: results.map(result => result.summary) };
const timestamp = new Date().toISOString();
const rawPath = `results/${timestamp.replaceAll(':', '-')}-go-event-loop-comparison.json`;
await writeFile(rawPath, JSON.stringify({ timestamp, summary, results }, null, 2) + '\n');

const rows = results.map(({ summary: item }) =>
  `| ${item.goMaxProcs} | ${item.cpuTasks} | ${item.baselineP95Ms} | ${item.victimP95Ms} | ${item.preHandlerP95Ms} | ${item.handlerP95Ms} | ${item.dbRoundTripP95Ms} | ${item.success}/${item.victimCount} |`
);
await writeFile('results/go-event-loop-report.md', `# Go scheduler comparison

Generated ${timestamp}. Each case schedules two-second CPU goroutines, then sends nine ordinary SELECT 1 requests through database/sql with 10 clients and the shared PgBouncer.

| GOMAXPROCS | CPU goroutines | Baseline p95 ms | Victim p95 ms | Before handler p95 ms | Handler p95 ms | DB round trip p95 ms | Successful |
|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

Go's HTTP server runs handlers in goroutines, and the runtime can preempt CPU-heavy goroutines so others receive scheduler time. GOMAXPROCS controls how many goroutines may execute Go code simultaneously. Preemption preserves responsiveness; it does not create CPU capacity. When CPU goroutines outnumber available processors, all work shares the same finite cores and latency can still rise.

Raw data: [go-event-loop-comparison](${rawPath.split('/').pop()})
`);
console.log(JSON.stringify({ summary, report: 'results/go-event-loop-report.md' }, null, 2));
