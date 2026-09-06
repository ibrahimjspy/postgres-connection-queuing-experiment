import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { discover, experiment } from './experiment.mjs';

const REQUEST_COUNT = 80;
const QUERY_MS = 500;
const CONNECTIONS = 10;
const PREDICTED_CAPACITY_RPS = CONNECTIONS / (QUERY_MS / 1000);

/** One lesson: keep total work fixed and change only how quickly it arrives. */
const replicas = discover();
assert.equal(replicas.length, 1, 'Use one API: docker compose up -d --scale api=1 --wait');
for (const setting of ['POOL_MAX=10', 'PGHOST=pgbouncer', 'PGPORT=6432']) {
  assert.ok(replicas[0].environment.includes(setting), `This lesson requires ${setting}`);
}

const admin = new pg.Client({ host: '127.0.0.1', port: 56439, database: 'pgbouncer', user: 'lab', password: 'lab-local-only', connectionTimeoutMillis: 5000, query_timeout: 5000 });
try {
  await admin.connect();
  const config = Object.fromEntries((await admin.query('SHOW CONFIG')).rows.map(row => [row.key, row.value]));
  assert.equal(config.pool_mode, 'transaction');
  assert.equal(Number(config.default_pool_size), CONNECTIONS);
  assert.equal(Number(config.max_db_connections), CONNECTIONS);
} finally {
  await admin.end();
}

const cases = [
  { label: '5', rps: 5 },
  { label: '10', rps: 10 },
  { label: '15', rps: 15 },
  { label: '20', rps: 20 },
  { label: '30', rps: 30 },
  { label: 'burst', rps: 0 },
];
const results = [];

for (const testCase of cases) {
  const result = await experiment({
    name: `rate-${testCase.label}`,
    route: `/slow?ms=${QUERY_MS}`,
    count: REQUEST_COUNT,
    rps: testCase.rps,
    probePaths: [],
  });
  assert.equal(result.summary.success, REQUEST_COUNT, `${testCase.label}: inspect ${result.path}`);
  assert.equal(result.summary.errors, 0);
  assert.deepEqual(result.observerErrors, [], `Observer failed: ${result.path}`);
  assert.equal(result.probes.length, 0);
  assert.ok(result.samples.some(sample => sample.source === 'postgres'));
  assert.ok(result.samples.some(sample => sample.source === 'pgbouncer'));
  if (testCase.rps) {
    // The load generator records its actual dispatch span so a late sender cannot fake a low queue.
    assert.ok(Math.abs(result.summary.dispatchSpanMs - result.summary.expectedDispatchSpanMs) < 250,
      `Dispatch clock drifted too far: ${result.path}`);
  }
  results.push(result);
}

const rows = results.map(({ summary: s }) => {
  const rate = s.rps || 'burst';
  const relation = s.rps === 0 ? 'all at once' : s.rps < PREDICTED_CAPACITY_RPS ? 'below' : s.rps === PREDICTED_CAPACITY_RPS ? 'at line' : 'above';
  return `| ${rate} | ${relation} | ${s.dispatchSpanMs} | ${s.requestP95Ms} | ${s.acquireP95Ms} | ${s.peakNodeWaiting} | ${s.tailDrainMs} | ${s.completedPerSecond} | ${s.errors} |`;
});

await writeFile('results/arrival-rate-report.md', `# Lab 03 — arrival rate

Generated ${new Date().toISOString()}. One local run per arrival rate.

Only arrival rate changes. Every case sends ${REQUEST_COUNT} workload requests to one API. Node pool=${CONNECTIONS}, PgBouncer backend limit=${CONNECTIONS}, and every request holds a connection with pg_sleep for ${QUERY_MS}ms. Load-script probes are disabled.

Our simplified service-rate prediction is ${CONNECTIONS} connections ÷ ${QUERY_MS / 1000}s = **${PREDICTED_CAPACITY_RPS} requests/second**. Below that line, connections should become free as quickly as new work arrives. Above it, the difference accumulates as a queue. Real query workloads do not have one fixed service time, so production capacity is a distribution rather than this clean line.

| Arrival requests/s | Position vs 20 rps | Actual dispatch span ms | Request p95 ms | Acquisition p95 ms | Peak Node waiters | Tail after last dispatch ms | Whole-run completions/s | Errors |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

Dispatch span measures first-to-last workload dispatch. Tail is time from the final dispatch until the final response. Whole-run completions/s includes both the arrival window and final drain, so it is not a direct measurement of instantaneous database throughput. A burst has no configured requests/second and is included as an extreme comparison. Docker scheduling and PgBouncer overhead can make the practical boundary slightly lower than the simple 20 rps prediction. These are single runs, not capacity estimates.

Raw data:
${results.map(result => `- [${result.summary.rps || 'burst'} requests/s](${result.path.split('/').pop()})`).join('\n')}
`);

console.log('Verified all workload responses, dispatch timing, and observers. Report: results/arrival-rate-report.md');
