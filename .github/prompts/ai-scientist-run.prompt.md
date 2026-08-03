---
description: Resume a planned AI Scientist run and continue autonomously through research, BFTS candidate exploration, testing, and final reporting.
---

# AI Scientist: Run

Treat the remaining prompt text as either an existing run ID or an issue that still needs
`bftsPlanRun`.

1. Load or create the run and pass the readiness gate.
2. Ensure the untouched baseline is benchmarked, then write `research.md` after focused
   local and, when useful, external research.
3. Define shared weighted evaluation criteria before proposing candidates.
4. Propose distinct candidates and execute the bounded BFTS loop using MCP state,
   isolated worktrees, common benchmarks, and parallel subagents when independent nodes
   are selected.
5. Score completed candidates against every shared criterion using concrete evidence.
6. Continue until a configured stop condition is reached; do not stop after planning or
   the first candidate.
7. Persist the final evidence-based tradeoff report with `bftsWriteReport`.

Never modify the current branch, fabricate evidence, or leave the run without either a
final report or a clearly recorded blocker.
