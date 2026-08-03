# bfts-tools MCP server

Local Model Context Protocol (MCP) server exposing best-first tree-search (BFTS) tools
for the AI Scientist Copilot agent. Runs over stdio; Copilot CLI spawns and manages this
process automatically per `.mcp.json` — no manual server management needed.

## Tools

- `bftsPlanRun` — create the issue-driven plan, readiness checks, and persistent run.
- `bftsRecheckRun` — re-run readiness after a blocker is fixed.
- `bftsScanProject` — identify a concrete, scoped problem in a target project.
- `bftsRunBaseline` — benchmark the untouched base commit in an isolated worktree.
- `bftsSetEvaluationCriteria` — define the shared weighted rubric for all candidates.
- `bftsProposeCandidates` — register the configured root drafts or refinements of the
  measured parent selected by BFTS.
- `bftsSelectNextNode` — reserve pending implementations, then select the highest-scoring
  completed leaf as the next expansion parent.
- `bftsApplyCandidate` — apply a candidate on an isolated git branch/worktree.
- `bftsRunBenchmark` — commit a candidate and run the common command one or more times
  against that exact commit.
- `bftsRecordResult` — record criterion scores, evidence, and final node status.
- `bftsGetRun` — retrieve persistent plan, node, and benchmark state.
- `bftsWriteReport` — persist the final measured tradeoff report.

Naming mirrors the original AI-Scientist-v2 `bfts_config.yaml` fields (`num_workers`,
`steps`, `max_debug_depth`, `num_drafts`) for direct traceability to the source paper.

## Safety

- Candidates are always applied on isolated git branches/worktrees — never the user's
  checked-out branch.
- Search is bounded by `numWorkers`/max steps/max debug attempts per node — no unbounded
  loops.
- Cross-process locking serializes run-state updates from parallel workers.
- Root draft count is enforced and measured rubric scores drive subsequent expansion.
- Benchmarks are CPU-only (no GPU/VM assumptions).
- No network access unless explicitly requested by a tool call.
- Never fabricate results — anything not actually executed must be labeled as such by
  the calling agent.

## Code style

Keep comments minimal. Do not comment on anything obvious from reading the code; only
comment where intent, a non-obvious tradeoff, or a workaround needs explaining.

## Setup

```bash
cd mcp-servers/bfts-tools
npm install
npm test
```

Registered in the repo root `.mcp.json`. Copilot CLI discovers and starts it
automatically.
