# Lab 01 — observed evidence
- With one API, slow SQL produced 35 peak Node waiters; fast SQL p95 was 1,859ms, health p95 22ms.
- Blocking JavaScript also delayed health: 2,238ms p95, with 2,288ms maximum observed loop delay.
- With three APIs and the same 10-backend PgBouncer budget, PgBouncer reached 20 sampled waiters; slow-request p95 stayed near 2s.
- These local bursts establish distinct queue locations; pg_sleep does not establish real SQL CPU/I/O capacity.
- Next surface: read the acquisition/query/release chain in `lab/api.mjs`, then compare it with `results/latest-report.md`.
