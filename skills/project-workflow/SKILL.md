---
name: project-workflow
description: Implement, review, or verify changes in the AutoPilot HR Command Center repository. Use for backend, frontend, database, documentation, tests, and local-development tasks that need repository-specific commands, coding conventions, or safety checks.
---

# Project Workflow

Use the smallest change that fully solves the request. Inspect related code and tests first; keep unrelated worktree changes intact.

## Commands

On Windows, start services with `./scripts/start.ps1`; otherwise use `docker compose up --build -d`. The frontend is at port 3001 and API at 8001.

Run focused verification first:

```powershell
docker compose exec backend pytest
npm --prefix frontend run build
docker compose logs -f backend
```

Use Alembic for persistent schema changes:

```powershell
docker compose exec backend alembic revision --autogenerate -m "description"
docker compose exec backend alembic upgrade head
```

## Conventions

- Backend: FastAPI routers contain transport concerns; put business logic in `app/services/`; add Pydantic schemas and Alembic migrations with model/API changes.
- Frontend: use Next.js App Router, TypeScript, Tailwind semantic tokens, existing UI components, and Lucide icons. Keep API calls in `frontend/src/lib/api-client.ts`.
- Use `snake_case` in Python/API payloads and repository-standard `PascalCase` React components. Do not add hardcoded demo data to production-facing HR views.
- Add tests for behavior changes. Validate backend changes with pytest and frontend changes with a production build when practical.

## HR safeguards

- Never infer missing values; route incomplete or ambiguous data to the appropriate exception path.
- Make every policy evaluation traceable to a policy version and outcome.
- Sanitize confidential disclosure data at the API boundary; only a restricted confidential queue may access its details.
