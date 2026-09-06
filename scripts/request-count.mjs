import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { discover, experiment } from './experiment.mjs';

/** One lesson: vary burst size while connection limits and query duration stay fixed. */
const replicas = discover();
assert.equal(replicas.length, 1, 'Use one API: docker compose up -d --scale api=1 --wait');
for (const setting of ['POOL_MAX=10', 'PGHOST=pgbouncer', 'PGPORT=6432']) {
  assert.ok(replicas[0].environment.includes(setting), `This lesson requires ${setting}`);
}
const admin = new pg.Client({ host: '127.0.0.1', port: 56439, database: 'pgbouncer', user: 'lab', password: 'lab-local-only', connectionTimeoutMillis: 5000, query_timeout: 5000 });
try {
  await admin.connect();
  const config = Object.fromEntries((await admin.query('SHOW CONFIG')).rows.map(r => [r.key, r.value]));
  assert.equal(config.pool_mode, 'transaction');
  assert.equal(Number(config.default_pool_size), 10);
  assert.equal(Number(config.max_db_connections), 10);
} finally {
  await admin.end();
}

const results = [];
for (const count of [5, 10, 20, 40, 80]) {
  // No extra fast-SQL probes: the measured burst contains exactly count workload requests.
  const result = await experiment({ name: `requests-${count}`, route: '/slow?ms=500', count, probePaths: [] });
  assert.equal(result.summary.success, count, `Burst ${count}: inspect ${result.path}`);
  assert.deepEqual(result.observerErrors, [], `Observer failed: ${result.path}`);
  assert.ok(result.metricsAfter.every(m => m.status === 200), `Metrics failed: ${result.path}`);
  assert.equal(result.probes.length, 0);
  // A useful invariant: scaling the offered burst must not exceed our DB connection budget.
  const databaseSamples = result.samples.filter(s => s.source === 'postgres');
  assert.ok(databaseSamples.length > 0);
  assert.ok(databaseSamples.some(s => s.rows.some(row => row.application_name?.startsWith('queue-lab-'))));
  assert.ok(databaseSamples.every(s => s.rows.filter(row => row.application_name?.startsWith('queue-lab-')).reduce((n, row) => n + row.count, 0) <= 10), 'Unexpected extra API DB backends');
  const bouncerSamples = result.samples.filter(s => s.source === 'pgbouncer');
  assert.ok(bouncerSamples.length > 0);
  assert.ok(bouncerSamples.every(s => s.rows.filter(row => row.database === 'lab').every(row =>
    Object.entries(row).filter(([key]) => key.startsWith('sv_')).reduce((n, [, value]) => n + Number(value), 0) <= 10
  )), 'PgBouncer exceeded its backend budget');
  results.push(result);
}

const rows = results.map(({ summary: s }) =>
  `| ${s.count} | ${Math.ceil(s.count / 10) * 500} | ${s.workloadMs} | ${s.requestP95Ms} | ${s.acquireP95Ms} | ${s.peakNodeWaiting} | ${s.peakBouncerWaiting} | ${s.errors} |`
);
await writeFile('results/request-count-report.md', `# Lab 02 — requests arriving together

Generated ${new Date().toISOString()}. One local run per burst size.

Only workload request count changes. One API, Node pool=10, one shared transaction-mode PgBouncer with a 10-backend limit, pg_sleep(0.5) per request. No /fast or /health load-script probes during these measurements. Docker health checks and measurement setup still issue housekeeping HTTP requests; database observers run separately. Warmup completes before measurement.

Prediction: with 10 available connections, up to 10 sleeps can execute together. Ignoring overhead, a burst of N takes approximately ceil(N/10) × 500ms to drain. Requests beyond the first 10 wait for a connection. This is a simplified prediction, not a performance assertion.

| Burst requests | Predicted drain ms | Measured drain ms | Request p95 ms | Node acquisition p95 ms | Peak Node waiters | Sampled PgBouncer waiters | Errors |
|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

The peak of 1 waiter in small bursts can be a brief library handoff: this installed pg-pool queues acquisition until the next tick even when an idle client is available. Compare acquisition duration to distinguish that from sustained contention. PostgreSQL samples include application_name so the budget check can distinguish API backends from direct housekeeping connections; PgBouncer server counts are checked separately.

Each client sends one request without waiting for other clients' responses. Dispatch timestamps are saved in JSON: a host process cannot send every request at literally the same instant. Drain time runs from the measurement start until all workload responses have been read. At small counts p95 is the maximum under our nearest-rank definition. Connection acquisition includes scheduling overhead. These bursts demonstrate queuing; they do not estimate production capacity or sustained requests/second. pg_sleep holds connections without simulating database CPU/I/O pressure. No timing thresholds are asserted because local scheduling varies.

Raw data:
${results.map(r => `- [${r.summary.count} requests](${r.path.split('/').pop()})`).join('\n')}
`);
console.log('Verified every workload response, observer health, and the 10-backend budget. Report: results/request-count-report.md');
