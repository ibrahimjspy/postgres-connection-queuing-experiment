# Rust/Tokio event-loop comparison
- Inline CPU work delayed nine fast requests to about 1.91s p95 with both one and two Tokio async workers in this Axum run.
- The database round trip remained about 6–7ms; waiting happened before the handler could progress.
- Moving the same loop through spawn_blocking kept victim p95 near 58ms.
- Tokio worker count is capacity, not a guarantee that new server tasks avoid a blocked worker.
- Rust async code must still isolate blocking CPU work and bound its blocking-pool concurrency.
