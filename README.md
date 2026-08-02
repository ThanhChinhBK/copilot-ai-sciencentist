# AI Scientist

A GitHub Copilot CLI agent that uses AI-Scientist-v2's best-first tree-search (BFTS)
mechanic to find the best way to solve a problem in **your own project**: it scans for a
concrete gap or improvement, explores a few candidate solutions on isolated git branches,
benchmarks them locally (CPU-only, no GPU/VM required), and writes a short tradeoff
report.

This is a scoped re-implementation of the BFTS search idea from
[SakanaAI/AI-Scientist-v2](https://github.com/SakanaAI/AI-Scientist-v2)
(arXiv:2504.08066) — not the full ideation/paper-writing pipeline.

## How it works

1. **Scan** — identify a scoped problem in the target project.
2. **Propose** — draft 2-4 candidate solutions (BFTS root nodes).
3. **Search** — best-first exploration of candidates, each on an isolated git
   branch/worktree, bounded by worker/step/debug-attempt limits.
4. **Benchmark** — run the project's existing test/build/lint command against each
   executed candidate.
5. **Report** — a short Markdown report comparing tradeoffs and recommending a winner.

## Structure

- `mcp-servers/bfts-tools/` — local MCP server (stdio) providing the real, deterministic
  BFTS tools (state store, node selection, branch management, benchmarking). Registered
  in `.mcp.json`; Copilot CLI spawns it automatically.
- `.github/agents/ai-scientist.agent.md` — the Copilot custom agent orchestrating the
  workflow using the MCP tools and `/fleet` for parallel candidate exploration.
- `.github/prompts/ai-scientist-solve.prompt.md` — single end-to-end workflow command.
- `report/`, `experiments/` — generated run artifacts (git-ignored per run).

## Status

Project scaffold only. MCP tools are currently stubs (see
`mcp-servers/bfts-tools/README.md`) — search/benchmark/report logic is implemented in
later passes.

## Safety

- All candidate changes happen on isolated git branches/worktrees, never the user's
  checked-out branch.
- Bounded search (workers/steps/debug attempts) — no runaway loops.
- CPU-only benchmarks — no GPU/VM required.
- No fabricated results: anything not actually executed is labeled as such.
