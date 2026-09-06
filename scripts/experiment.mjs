import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? +sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(2) : null;
};

/** Discover every replica; request round-robin models dispatch, not a production proxy. */
export function discover() {
  const ids = docker('compose', 'ps', '-q', 'api').split('\n').filter(Boolean);
  if (!ids.length) throw new Error('Start the lab first: npm run up');
  const containers = JSON.parse(docker('inspect', ...ids));
  return containers.map(c => ({
    name: c.Name,
    url: `http://127.0.0.1:${c.NetworkSettings.Ports['3000/tcp'][0].HostPort}`,
    cpuQuota: c.HostConfig.NanoCpus / 1e9,
    memoryBytes: c.HostConfig.Memory,
    environment: c.Config.Env.filter(e => /^(PGHOST|PGPORT|POOL_MAX|ACQUIRE_TIMEOUT_MS)=/.test(e)),
    image: c.Image,
  }));
}

async function request(url, method = 'GET') {
  const start = performance.now();
  try {
    const response = await fetch(url, { method, signal: AbortSignal.timeout(30000) });
    const body = await response.json();
    return { status: response.status, elapsedMs: performance.now() - start, ...body };
  } catch (error) {
    return { status: 0, elapsedMs: performance.now() - start, error: error.message };
  }
}

/** A fixed burst sends all requests regardless of response speed. Rate mode uses a fixed clock. */
export async function experiment({ name = 'burst', route = '/slow?ms=500', count = 40, rps = 0, probePaths = ['/health', '/fast'] } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 5000 || !Number.isFinite(rps) || rps < 0 || rps > 500) {
    throw new Error('count: integer 1..5000; rps: 0 (burst) or up to 500');
  }
  const replicas = discover();
  const auth = { host: '127.0.0.1', user: 'lab', password: 'lab-local-only', connectionTimeoutMillis: 5000, query_timeout: 5000 };
  const bouncer = new pg.Client({ ...auth, port: 56439, database: 'pgbouncer' });
  const postgres = new pg.Client({ ...auth, port: 55439, database: 'lab', application_name: 'lab-observer' });
  // Error listeners prevent asynchronous connection failures from crashing without cleanup.
  const observerErrors = [];
  for (const client of [bouncer, postgres]) client.on('error', e => observerErrors.push(e.message));
  let polling = true;
  const polls = [];
  const samples = [];
  const probes = [];
  let probeTimer;
  try {
    await Promise.all([bouncer.connect(), postgres.connect()]);
    // Warm all 10 connections per replica so initial connection setup is less influential.
    for (const replica of replicas) {
      const ready = await request(`${replica.url}/metrics`);
      if (ready.status !== 200) throw new Error(`API unavailable: ${replica.url}`);
      const warm = await Promise.all(Array.from({ length: ready.poolMax }, () => request(`${replica.url}/slow?ms=20`)));
      if (warm.some(r => r.status !== 200)) throw new Error('Database warmup failed; inspect docker compose logs');
      await request(`${replica.url}/reset`, 'POST');
    }
    const before = (await bouncer.query('SHOW STATS')).rows;
    const metricsBefore = await Promise.all(replicas.map(r => request(`${r.url}/metrics`)));
    const started = performance.now();
    // DB observers run independently of the API event loop and each other, every ~100ms.
    for (const [source, client, sql] of [
      ['pgbouncer', bouncer, 'SHOW POOLS'],
      ['postgres', postgres, "SELECT application_name, state, wait_event_type, wait_event, count(*)::int AS count FROM pg_stat_activity WHERE datname = 'lab' AND pid <> pg_backend_pid() GROUP BY 1,2,3,4"],
    ]) {
      polls.push((async () => {
        while (polling) {
          try { samples.push({ source, atMs: performance.now() - started, rows: (await client.query(sql)).rows }); }
          catch (error) { observerErrors.push(`${source}: ${error.message}`); break; }
          await delay(100);
        }
      })());
    }
    let probeIndex = 0;
    const probe = () => {
      const replica = replicas[probeIndex++ % replicas.length];
      const atMs = performance.now() - started;
      // Fast SQL probes show shared-pool contention; health probes need no DB connection.
      for (const path of probePaths) {
        probes.push(request(`${replica.url}${path}`).then(r => ({ path, atMs, ...r })));
      }
    };
    if (probePaths.length) {
      probe();
      probeTimer = setInterval(probe, 100);
    }
    const pending = [];
    for (let i = 0; i < count; i++) {
      if (rps) await delay(Math.max(0, started + i * 1000 / rps - performance.now()));
      const replica = replicas[i % replicas.length];
      const dispatchedAtMs = performance.now() - started;
      pending.push(request(`${replica.url}${route}`).then(r => ({ dispatchedAtMs, ...r })));
    }
    const requests = await Promise.all(pending);
    const workloadMs = performance.now() - started;
    clearInterval(probeTimer);
    const probeResults = await Promise.all(probes);
    // Allow the loop-delay observer to record the final blocking callback.
    await delay(100);
    polling = false;
    await Promise.all(polls);
    const metricsAfter = await Promise.all(replicas.map(r => request(`${r.url}/metrics`)));
    const after = (await bouncer.query('SHOW STATS')).rows;
    const pgVersion = (await postgres.query('SHOW server_version')).rows;
    const pgSettings = (await postgres.query("SELECT name, setting, unit FROM pg_settings WHERE name IN ('max_connections', 'statement_timeout')")).rows;
    const bouncerVersion = (await bouncer.query('SHOW VERSION')).rows;
    const bouncerSettings = (await bouncer.query('SHOW CONFIG')).rows.filter(r => ['pool_mode', 'default_pool_size', 'max_db_connections', 'max_client_conn', 'query_wait_timeout'].includes(r.key));
    const dispatchTimes = requests.map(r => r.dispatchedAtMs);
    const dispatchSpanMs = dispatchTimes.length > 1 ? Math.max(...dispatchTimes) - Math.min(...dispatchTimes) : 0;
    const summary = {
      name, replicas: replicas.length, count, rps, route, probePaths,
      success: requests.filter(r => r.status === 200).length,
      errors: requests.filter(r => r.status !== 200).length,
      workloadMs: +workloadMs.toFixed(2),
      expectedDispatchSpanMs: +(rps ? (count - 1) * 1000 / rps : 0).toFixed(2),
      dispatchSpanMs: +dispatchSpanMs.toFixed(2),
      tailDrainMs: +(workloadMs - dispatchSpanMs).toFixed(2),
      completedPerSecond: +(count / workloadMs * 1000).toFixed(2),
      requestP50Ms: percentile(requests.map(r => r.elapsedMs), .5),
      requestP95Ms: percentile(requests.map(r => r.elapsedMs), .95),
      acquireP95Ms: percentile(requests.map(r => r.acquireMs), .95),
      dbRoundTripP95Ms: percentile(requests.map(r => r.dbRoundTripMs), .95),
      healthP95Ms: percentile(probeResults.filter(r => r.path === '/health').map(r => r.elapsedMs), .95),
      fastP95Ms: percentile(probeResults.filter(r => r.path === '/fast').map(r => r.elapsedMs), .95),
      probeErrors: probeResults.filter(r => r.status !== 200).length,
      probeCount: probeResults.length,
      peakNodeWaiting: Math.max(...metricsAfter.map(r => r.pool?.peakWaiting ?? 0)),
      peakBouncerWaiting: Math.max(0, ...samples.filter(s => s.source === 'pgbouncer').map(s => s.rows.filter(r => r.database === 'lab').reduce((sum, r) => sum + Number(r.cl_waiting), 0))),
      peakLoopDelayMs: +Math.max(...metricsAfter.map(r => r.loop?.maxMs ?? 0)).toFixed(2),
    };
    const result = {
      timestamp: new Date().toISOString(), summary, replicas, metricsBefore, metricsAfter,
      host: { node: process.version, docker: docker('info', '--format', 'CPUs={{.NCPU}} Memory={{.MemTotal}}') },
      versions: { pgVersion, bouncerVersion }, pgSettings, bouncerSettings,
      bouncerStats: { before, after }, observerErrors, requests, probes: probeResults, samples,
    };
    await mkdir('results', { recursive: true });
    const path = `results/${new Date().toISOString().replaceAll(':', '-')}-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    await writeFile(path, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ...summary, path }, null, 2));
    return { ...result, path };
  } finally {
    polling = false;
    clearInterval(probeTimer);
    await Promise.allSettled(polls);
    await Promise.allSettled(probes);
    await Promise.allSettled([bouncer.end(), postgres.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [name = 'burst', route = '/slow?ms=500', count = '40', rps = '0'] = process.argv.slice(2);
  await experiment({ name, route, count: Number(count), rps: Number(rps) });
}
