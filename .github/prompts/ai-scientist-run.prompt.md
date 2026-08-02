---
description: Resume a planned AI Scientist run and continue autonomously through research, BFTS candidate exploration, testing, and final reporting.
---

# AI Scientist: Run

Treat the remaining prompt text as either an existing run ID or an issue that still needs
`bftsPlanRun`.

1. Load or create the run and pass the readiness gate.
2. Write `research.md` after focused local and, when useful, external research.
3. Propose distinct candidates and execute the bounded BFTS loop using MCP state,
   isolated worktrees, common benchmarks, and parallel subagents when independent nodes
   are selected.
4. Continue until a configured stop condition is reached; do not stop after planning or
   the first candidate.
5. Persist the final evidence-based tradeoff report with `bftsWriteReport`.

Never modify the current branch, fabricate evidence, or leave the run without either a
final report or a clearly recorded blocker.
