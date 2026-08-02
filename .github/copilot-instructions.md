# AI Scientist — Copilot Guiding Instructions

This repository defines **AI Scientist**, a GitHub Copilot CLI agent that uses
[SakanaAI/AI-Scientist-v2](https://github.com/SakanaAI/AI-Scientist-v2)'s (arXiv:2504.08066)
best-first tree-search (BFTS) mechanic — its core, proven contribution — to find the best
way to solve a scoped problem in the user's own project. It is **not** a reimplementation
of the full ideation/paper-writing pipeline; scope is limited to: scan for a problem,
explore candidate solutions via real BFTS, benchmark them locally (CPU-only, no GPU/VM),
and produce a short tradeoff report.

## Why Copilot CLI + a local MCP server

Cloud custom agents (`.github/agents` invoked from github.com) are prompt-only — an LLM
can only *simulate* a tree search by following instructions, with no real state machine,
scoring, or deterministic execution. To make BFTS genuine rather than simulated, this repo
ships a local MCP server (`mcp-servers/bfts-tools/`, stdio transport, registered in
`.mcp.json`) that Copilot CLI auto-spawns as a child process. It exposes deterministic
tools for node state, best-first selection, isolated branch/worktree management, and
benchmarking. The Copilot agent orchestrates these tools and uses `/fleet` for parallel
candidate exploration.

## Repository layout

- `mcp-servers/bfts-tools/` — the local MCP server and its tools (see its own README).
- `.github/agents/ai-scientist.agent.md` — the orchestrating custom agent.
- `.github/prompts/ai-scientist-solve.prompt.md` — single end-to-end workflow command.
- `report/`, `experiments/` — generated run artifacts (git-ignored per run).

## Ground rules

1. **Safety first.** Candidates are applied only on isolated git branches/worktrees,
   never the user's checked-out branch. Never run destructive, networked, or
   credential-touching commands without calling them out first.
2. **Bounded search.** BFTS exploration must be bounded by worker/step/debug-attempt
   limits (named after the original `bfts_config.yaml` fields) — no unbounded loops.
3. **Honesty about results.** Never fabricate benchmark numbers or scores. If a
   candidate wasn't actually executed, label it as such rather than as a measured result.
4. **Traceability.** Every run's problem statement, search log, and report are versioned
   Markdown files under `report/<run-id>/`, not just chat output.
5. **CPU-only.** No GPU/VM-dependent experiments in this workflow.
6. **Comment discipline.** Keep code comments minimal. Do not comment on anything
   obvious from reading the code itself — only comment where intent, a non-obvious
   tradeoff, or a workaround genuinely needs explaining. This applies to all code in this
   repo (MCP server and any future scripts).

## Conventions

- Run artifacts: `report/<run-id>/{problem.md, search-log.md, report.md}`.
- Use kebab-case for all new file and directory names.
