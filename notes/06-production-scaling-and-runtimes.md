# Production scaling — locked lesson
- Keep GET/API handlers short; move multi-minute publish workflows to a durable queue and separate worker deployment.
- Scale API pods on traffic/latency and publish workers on queue depth or oldest-job age; keep warm minimum replicas.
- Node async I/O can overlap, while CPU work belongs in bounded worker threads/processes; Go schedules goroutines across threads; Tokio needs blocking work off async workers.
- Bound outbound calls, retries, job concurrency, and DB concurrency independently so overload cannot move unchecked downstream.
- PgBouncer protects the PostgreSQL connection budget; total application concurrency must still respect database capacity.
