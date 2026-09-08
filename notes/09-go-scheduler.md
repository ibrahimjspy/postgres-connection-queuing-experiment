# Go scheduler comparison
- With GOMAXPROCS=1, one two-second CPU goroutine left nine fast requests near 36ms p95 because Go preempted it.
- With GOMAXPROCS=2 and one CPU goroutine, victim p95 was about 19ms.
- Four CPU goroutines competing for two processors raised victim p95 to about 122ms, but all requests progressed.
- Go's scheduler prevents one ordinary CPU loop from monopolizing request execution; it does not create CPU capacity.
- Database connection limits, outbound concurrency, locks, and total CPU saturation still require explicit bounds.
