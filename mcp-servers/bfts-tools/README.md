# bfts-tools MCP server

Local Model Context Protocol (MCP) server exposing best-first tree-search (BFTS) tools
for the AI Scientist Copilot agent. Runs over stdio; Copilot CLI spawns and manages this
process automatically per `.mcp.json` — no manual server management needed.

## Tools

- `bftsPlanRun` — create the issue-driven plan, readiness checks, and persistent run.
- `bftsRecheckRun` — re-run readiness after a blocker is fixed.
- `bftsScanProject` — identify a concrete, scoped problem in a target project.
- `bftsProposeCandidates` — register candidate solution approaches as BFTS root nodes.
- `bftsSelectNextNode` — best-first selection of the next node(s) to explore.
- `bftsApplyCandidate` — apply a candidate on an isolated git branch/worktree.
- `bftsRunBenchmark` — run the project's test/build/lint command against a candidate.
- `bftsRecordResult` — record a node's status/score/benchmark output.
- `bftsGetRun` — retrieve persistent plan, node, and benchmark state.
- `bftsWriteReport` — persist the final measured tradeoff report.

Naming mirrors the original AI-Scientist-v2 `bfts_config.yaml` fields (`num_workers`,
`steps`, `max_debug_depth`, `num_drafts`) for direct traceability to the source paper.

## Safety

- Candidates are always applied on isolated git branches/worktrees — never the user's
  checked-out branch.
- Search is bounded by `numWorkers`/max steps/max debug attempts per node — no unbounded
  loops.
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
