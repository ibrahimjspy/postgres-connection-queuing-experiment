import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { experiment } from './experiment.mjs';

/** This first lesson changes one thing at a time; scaling is manual, with a fixed DB budget. */
const scale = n => execFileSync('docker', ['compose', 'up', '-d', '--scale', `api=${n}`, '--wait'], { stdio: 'inherit' });
const results = [];
try {
  scale(1);
  results.push(await experiment({ name: '01-fast', route: '/fast', count: 40 }));
  results.push(await experiment({ name: '02-slow-sql', route: '/slow?ms=500', count: 40 }));
  results.push(await experiment({ name: '03-blocked-loop', route: '/cpu?ms=150', count: 16 }));
  scale(3);
  results.push(await experiment({ name: '04-slow-sql-three-replicas', route: '/slow?ms=500', count: 40 }));
} finally {
  scale(1);
}
const rows = results.map(r => {
  const s = r.summary;
  return `| ${s.name} | ${s.replicas} | ${s.success}/${s.count} | ${s.requestP95Ms} | ${s.healthP95Ms} | ${s.fastP95Ms} | ${s.peakNodeWaiting} | ${s.peakBouncerWaiting} | ${s.peakLoopDelayMs} |`;
});
await writeFile('results/latest-report.md', `# First lab measurements\n\nGenerated ${new Date().toISOString()}. Fixed bursts, local Docker, one run per case; milliseconds.\n\n| Case | API replicas | OK | Request p95 | Health p95 | Fast SQL p95 | Peak Node waiters per replica | Sampled PgBouncer waiters | Max loop delay |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\nRaw data:\n${results.map(r => `- [${r.summary.name}](${r.path.split('/').pop()})`).join('\n')}\n\nThese are controlled demonstrations, not production capacity estimates. Baseline probe counts are small. The /fast and /health probes add up to 10 requests/second each while the workload runs. PgBouncer sampling can miss short peaks. Node acquisition includes initial connection work and scheduling; DB round trips include PgBouncer waiting, SQL, transport, and Node callback delay. Inspect errors and observerErrors in raw data before drawing conclusions. pg_sleep holds connections without mimicking expensive SQL CPU/I/O. Replicas use direct round-robin dispatch from the host load script, not a production load balancer or Kubernetes autoscaler.\n`);
console.log('Report: results/latest-report.md');
