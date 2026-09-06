import http from 'node:http';
import os from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import pg from 'pg';

/** Each process owns this pool. Three replicas with max=10 can open 30 clients. */
const pool = new pg.Pool({
  max: Number(process.env.POOL_MAX ?? 10),
  connectionTimeoutMillis: Number(process.env.ACQUIRE_TIMEOUT_MS ?? 15000),
  application_name: `queue-lab-${os.hostname()}`,
});
pool.on('error', error => console.error('idle pool client error:', error.message));
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
let peakWaiting = 0;
const identity = { replica: os.hostname(), node: process.version, poolMax: pool.options.max };

function blockJavaScript(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* intentional lab fault */ }
}

/** Observing the loop needs the loop to run: read this again after a CPU stall. */
function metrics() {
  return {
    ...identity,
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, peakWaiting },
    loop: { maxMs: lag.max / 1e6, p99Ms: lag.percentile(99) / 1e6 },
    cpu: process.cpuUsage(),
    rssBytes: process.memoryUsage().rss,
  };
}

http.createServer(async (req, res) => {
  const start = performance.now();
  const url = new URL(req.url, 'http://localhost');
  let acquireMs = 0;
  let dbRoundTripMs = 0;
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...identity, ...body, acquireMs, dbRoundTripMs, handlerMs: performance.now() - start }));
  };
  try {
    if (url.pathname === '/health') return send(200, { ok: true });
    if (url.pathname === '/metrics') return send(200, metrics());
    if (url.pathname === '/reset' && req.method === 'POST') {
      lag.reset();
      peakWaiting = 0;
      return send(200, { ok: true });
    }
    if (!['/fast', '/slow', '/cpu', '/cpu-scheduled'].includes(url.pathname)) return send(404, { error: 'unknown route' });
    const ms = Number(url.searchParams.get('ms') ?? 500);
    if (!Number.isFinite(ms) || ms < 0 || ms > 5000) return send(400, { error: 'ms must be between 0 and 5000' });
    if (url.pathname === '/cpu-scheduled') {
      const delayMs = Number(url.searchParams.get('delayMs') ?? 150);
      if (!Number.isFinite(delayMs) || delayMs < 50 || delayMs > 1000) return send(400, { error: 'delayMs must be between 50 and 1000' });
      /** Acknowledging first lets the load script know exactly when this fault will begin. */
      setTimeout(() => blockJavaScript(ms), delayMs);
      return send(202, { ok: true, scheduledInMs: delayMs, blockForMs: ms });
    }
    if (url.pathname === '/cpu') {
      /** Deliberately blocks this process's JavaScript thread; no database involved. */
      blockJavaScript(ms);
      return send(200, { ok: true });
    }
    const acquiring = pool.connect();
    peakWaiting = Math.max(peakWaiting, pool.waitingCount);
    let client;
    try {
      client = await acquiring;
    } finally {
      acquireMs = performance.now() - start;
    }
    const queryStart = performance.now();
    try {
      /** pg_sleep holds a DB backend predictably; it does not simulate DB CPU or I/O pressure. */
      if (url.pathname === '/slow') await client.query('SELECT pg_sleep($1)', [ms / 1000]);
      else await client.query('SELECT 1 AS value');
    } finally {
      // This includes PgBouncer waiting + SQL + transport + delayed Node callbacks.
      dbRoundTripMs = performance.now() - queryStart;
      client.release();
    }
    send(200, { ok: true });
  } catch (error) {
    send(503, { error: error.message, code: error.code });
  }
}).listen(3000, '0.0.0.0', () => console.log(JSON.stringify({ listening: 3000, ...identity })));
