---
name: auto-studio-ops
description: Debug an Auto Studio step, review an Auto Studio workflow build, build or modify an Operator, or design a live test against Auto/Supabase. Use before any of these — it points to the project's failure log and build runbook.
---

# Auto Studio Operations

Read `docs/AGENT_LESSONS.md` in full first. It records specific failures already hit in this project (patch scoping, Supabase REST/RPC contracts, policy-snapshot shapes, sanitization boundaries, builder-prompt behavior, live-test evidence discipline) so a known trap isn't rediscovered. Append a short entry after any new failed attempt — the prevention, never credentials or confidential payloads.

Read `docs/AUTO_BUILD_GUIDE.md` for the copy-paste Operator build prompts, go-live gates, and per-step test tables (OP-05, OP-06, OP-07, and the scheduled cohort sweep).
