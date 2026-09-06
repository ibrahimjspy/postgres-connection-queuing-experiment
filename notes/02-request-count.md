# Lab 02 — burst request count
- Fixed one API, 10 Node pool clients, 10 PgBouncer backends, and 500ms SQL sleep per request.
- Bursts of 5/10/20/40/80 drained in 0.52/0.51/1.12/2.03/4.05 seconds; all 155 workload requests succeeded.
- Above 10 requests, Node acquisition time grew: 80 requests reached 70 waiters and about 3.50s acquisition p95.
- A transient pool waiter can be a library handoff; a direct housekeeping DB connection must not be counted as an API backend.
- This tests requests arriving together; next distinguish burst size from sustained arrival rate using the same count.
