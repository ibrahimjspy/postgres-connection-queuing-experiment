# Lab 04 — one bad event loop
- One 2,000ms CPU callback made nine ordinary /fast requests take 1,927ms p95.
- After Node invoked them, their handlers took 18ms p95 and DB round trips took 11ms p95.
- PgBouncer sampled 0 active servers and 0 waiting clients during the block; connections were available.
- PgBouncer manages database connections. It cannot schedule JavaScript or rescue a blocked Node event loop.
- Next surface: compare one blocked replica with several replicas behind distribution.
