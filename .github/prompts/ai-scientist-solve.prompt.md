---
description: Run the full AI Scientist BFTS workflow — scan, propose candidates, best-first search, benchmark, and report — against a target project.
---

# AI Scientist: Solve

Given a target project path (default: current repo) and optional focus area:

1. Call `bftsScanProject` to get a scoped problem statement; write it to
   `report/<run-id>/problem.md`.
2. Draft 2-4 candidate solution approaches and register them via
   `bftsProposeCandidates`.
3. Loop: `bftsSelectNextNode` → `bftsApplyCandidate` (isolated branch/worktree) →
   implement → `bftsRunBenchmark` → `bftsRecordResult`, using `/fleet` to explore
   multiple nodes concurrently when possible. Respect worker/step/debug-attempt bounds;
   stop once the search is exhausted or a clear winner emerges.
4. Write `report/<run-id>/report.md`: problem summary, per-candidate approach and
   benchmark numbers, a tradeoffs/advantages table, and a recommendation. Label anything
   not actually executed as such.

Never touch the user's checked-out branch directly. Never fabricate results.
