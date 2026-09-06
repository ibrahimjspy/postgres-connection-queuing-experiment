# Autoscaling visual
- Load reaches the load balancer, which routes only to ready pods.
- One blocked loop reduces usable capacity; readiness removes that pod from traffic.
- HPA observes metrics, requests replicas, and waits for startup before capacity increases.
- A fixed PgBouncer ceiling can become the next bottleneck after Node scales.
- Scaling handles sustained load; isolation and workers handle one bad synchronous request.
