# Lab 03 — arrival rate
- Fixed 80 requests, 10 connections, and 500ms occupancy; changed only arrival rate.
- At 20 req/s, acquisition p95 was 46ms; at 30 req/s it was 1,215ms with 27 peak Node waiters.
- The all-at-once burst reached 70 waiters and 3,515ms acquisition p95.
- SQL duration remained near 500ms; overload latency accumulated before a connection was acquired.
- Next surface: open the dashboard's “Arrival rate finds the limit” section.
