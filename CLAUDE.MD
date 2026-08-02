# Project guide

Read `AGENTS.MD` first, then `skills/project-workflow/SKILL.md` before making changes.

This project extends a FastAPI + Next.js template into a governed HR onboarding and retention Command Center. The Round 1 Auto/Supabase design is summarized in `docs/STAGE_SUMMARY.MD`; the Round 2 requirements are in `docs/ProblemStatement__Onboarding_and_Retention.pdf`.

Keep agent orchestration in Supervity Auto. Build the Command Center and integrations in this repository. Make policies dynamic and auditable, use live operational data rather than template demo data, and keep confidential disclosures out of non-confidential surfaces.
