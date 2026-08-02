# Repository instructions

Use `skills/project-workflow/SKILL.md` for development commands, code conventions, and verification. Read it before implementing a change.

- This is the Round 2 HR & People Ops Command Center. Read `docs/ProblemStatement__Onboarding_and_Retention.pdf` and `docs/STAGE_SUMMARY.MD` before changing HR workflows or data contracts.
- Auto by Supervity owns the Orchestrator and Operators. This repository owns the FastAPI/Next.js Command Center, policy APIs, data views, and human-workbench experience.
- Treat Supabase as the HR system of record unless an approved migration says otherwise. Do not create a competing source of truth.
- Never expose sensitive pulse comments or confidential-case payloads in dashboard, insights, standard queues, logs, or client responses. Enforce least-privilege access for confidential cases.
- Preserve existing user changes. Do not commit, reset, or delete data/files unless explicitly requested.
