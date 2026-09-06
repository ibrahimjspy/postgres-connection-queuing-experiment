# Lab UI — learning surface
- The Next.js server reads the newest JSON result for each experiment name on every page refresh.
- The main picture is requests → 10 connection slots → waiting queue.
- The chart compares measured drain time with ceil(requests / 10) × 500ms.
- The UI presents saved evidence; experiment scripts remain the source of truth.
- Next surface: run `npm run dashboard`, then read `dashboard/app/data.ts`.
