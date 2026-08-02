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

1. **Plan** — turn your supplied issue into a research/test/report plan and verify the
   repository is ready.
2. **Research** — inspect relevant code, tests, project patterns, and external evidence
   when useful.
3. **Propose** — draft 2-4 candidate solutions (BFTS root nodes).
4. **Search** — best-first exploration of candidates, each on an isolated git
   branch/worktree, bounded by worker/step/debug-attempt limits.
5. **Benchmark** — run the project's existing test/build/lint command against each
   executed candidate.
6. **Report** — a short Markdown report comparing tradeoffs and recommending a winner.

## First flow

After cloning the repository and running `npm install` in `mcp-servers/bfts-tools`:

```text
/agent ai-scientist
/ai-scientist-plan <describe the current issue>
```

Review `report/<run-id>/plan.md`. If readiness passes, enable Copilot CLI autopilot for
the long execution and resume with:

```text
/autopilot
/ai-scientist-run <run-id>
```

Use `/ai-scientist-solve <issue>` to plan and proceed in one session. The long run
continues through research, bounded BFTS exploration, common benchmarks, and
`report/<run-id>/report.md`.

## Structure

- `mcp-servers/bfts-tools/` — local MCP server (stdio) providing the real, deterministic
  BFTS tools (state store, node selection, branch management, benchmarking). Registered
  in `.mcp.json`; Copilot CLI spawns it automatically.
- `.github/agents/ai-scientist.agent.md` — the Copilot custom agent orchestrating the
  workflow using the MCP tools and `/fleet` for parallel candidate exploration.
- `.github/prompts/ai-scientist-plan.prompt.md` — planning/readiness-only command.
- `.github/prompts/ai-scientist-run.prompt.md` — long execution/resume command.
- `.github/prompts/ai-scientist-solve.prompt.md` — plan and run in one session.
- `report/`, `experiments/` — generated run artifacts (git-ignored per run).

## Status

The first issue-driven flow is implemented: persistent plans/readiness, BFTS state and
selection, parent/child refinement nodes, isolated worktrees, benchmark capture, and
final report persistence.

## Safety

- All candidate changes happen on isolated git branches/worktrees, never the user's
  checked-out branch.
- Bounded search (workers/steps/debug attempts) — no runaway loops.
- CPU-only benchmarks — no GPU/VM required.
- No fabricated results: anything not actually executed is labeled as such.
