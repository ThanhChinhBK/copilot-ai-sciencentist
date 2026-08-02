---
description: Turn a supplied project issue into a verified AI Scientist research, testing, and reporting plan without implementing candidates yet.
---

# AI Scientist: Plan

Treat the remaining prompt text as the current issue to investigate.

1. Call `bftsPlanRun` for the current repository and issue.
2. Inspect the repository enough to validate the generated plan, benchmark command, and
   success criteria.
3. Confirm that local research, optional external research, isolated implementation,
   test execution, and report writing are all available.
4. Update `report/<run-id>/plan.md` with issue-specific research questions and evaluation
   criteria.
5. Stop before proposing or implementing candidates.

Return the run ID, plan path, readiness result, and the exact command to start/resume the
long run. If readiness is blocked, state only the concrete blockers.
