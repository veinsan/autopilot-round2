# HR & People Ops AI Command Center

Round 2 command center built for the **Supervity AutoPilot Asia Hackathon 2026**. The project focuses on governed HR and People Ops operations across onboarding, compliance, payroll, manager accountability, and employee-risk workflows.

> The multi-agent orchestration itself runs on [Auto by Supervity](https://auto.supervity.ai/). This repository contains the companion dashboard, backend APIs, policy and workbench flows, identity layer, local infrastructure, and integration code used around that orchestration.

## What is in this repository

- **Command Center dashboard** for operational HR metrics and integration health
- **Human-in-the-loop Workbench** for reviewing and resolving escalated cases
- **Policy Studio** for governed policy versions, simulations, approvals, activation, and rollback
- **Run monitoring and reconciliation** for commands executed through Auto by Supervity
- **Operational insights** and cohort-level monitoring
- **Data Manager** for the HR datasets used by the command center
- **Role-based access control** with Keycloak
- **Audit logging** for administrative and application actions
- **FastAPI backend** with PostgreSQL persistence and Supabase integration

## Architecture

```text
┌──────────────────────────────┐
│      Auto by Supervity       │
│ Orchestrator + Operators     │
└──────────────┬───────────────┘
               │ API / run state
               ▼
┌──────────────────────────────┐
│         FastAPI API          │
│ policies · workbench · runs  │
│ insights · audit · admin     │
└───────┬───────────┬──────────┘
        │           │
        │           └──────────────► Supabase HR system of record
        │
        ▼
┌───────────────┐      ┌────────────────┐
│  PostgreSQL   │      │    Keycloak    │
│ local state   │      │ auth + roles   │
└───────┬───────┘      └────────────────┘
        │
        ▼
┌──────────────────────────────┐
│       Next.js Frontend       │
│      Command Center UI       │
└──────────────────────────────┘
```

## Tech stack

**Frontend**
- Next.js 15
- React 19
- TypeScript
- Tailwind CSS
- Radix UI
- Recharts
- NextAuth

**Backend & infrastructure**
- FastAPI
- PostgreSQL
- SQLAlchemy + Alembic
- Keycloak 26
- Supabase REST integration
- Docker Compose
- Pytest

**Agent platform**
- Auto by Supervity

## Repository structure

```text
.
├── app/                  # FastAPI application, routers, services, models
├── frontend/             # Next.js command center
├── alembic/              # Database migrations
├── config/               # Policy registry and Supabase schema
├── dataset/csv/          # Local/demo HR seed data used by the project
├── keycloak/             # Local realm import and identity configuration
├── scripts/              # Database, policy, and seed utilities
├── tests/                # Backend tests
├── docs/                  # Hackathon context
├── docker-compose.yml
└── .env.example
```

## Local setup

### Prerequisites

- Docker Desktop with Docker Compose
- Git

### 1. Clone the repository

```bash
git clone <your-repository-url>
cd autopilot-round2
```

### 2. Create the environment file

macOS / Linux:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Before starting the stack, replace the placeholder local credentials in `.env` and generate a `NEXTAUTH_SECRET`.

Example on macOS / Linux:

```bash
openssl rand -base64 32
```

The external integration values below can remain blank if you only want to inspect the local application, but they are required for the corresponding live integrations:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
AUTO_API_KEY=
AUTO_ACTIVE_ORG=
AUTO_HR_WORKFLOW_ID=
```

### 3. Start the application

```bash
docker compose up --build -d
```

### 4. Open the services

| Service | Local URL |
| --- | --- |
| Command Center | http://localhost:3001 |
| FastAPI docs | http://localhost:8001/api/docs |
| Keycloak | http://localhost:8080 |
| PostgreSQL | localhost:5432 |

Check container status with:

```bash
docker compose ps
```

Stop everything with:

```bash
docker compose down
```

## Main application areas

The frontend includes dedicated views for:

- Command Center dashboard
- Workbench cases
- Policy management
- Run monitoring
- Operational insights
- Data management
- User, role, group, session, event, and audit administration

The backend exposes the corresponding APIs under `/api`, including dashboard data, cases, policies, runs, reconciliation, insights, administration, and audit endpoints.

## Auto by Supervity integration

The Round 2 architecture intentionally keeps **agent orchestration outside this repository**. Orchestrator and Operator workflows are configured and executed in Auto by Supervity, while this application provides the surrounding command-center experience and governed backend services.

The backend integration is configured through:

```env
AUTO_BASE_URL=https://auto.supervity.ai
AUTO_API_KEY=
AUTO_ACTIVE_ORG=
AUTO_HR_WORKFLOW_ID=
AUTO_RECONCILIATION_ENABLED=true
AUTO_RECONCILIATION_INTERVAL_SECONDS=60
```

See [`docs/hackathon-brief.md`](docs/hackathon-brief.md) for the Round 2 platform requirements and challenge context.

## Security notes

- Real `.env` files are ignored by Git.
- Do not commit Supabase service-role keys, Auto API keys, NextAuth secrets, or production identity credentials.
- The checked-in Keycloak realm uses environment-variable placeholders rather than production passwords.
- Replace all example credentials before any shared or production deployment.

## Development commands

Run backend tests inside the backend container:

```bash
docker compose exec backend pytest
```

Apply migrations:

```bash
docker compose exec backend alembic upgrade head
```

Reset and reseed the local database:

```bash
docker compose exec backend python scripts/reset_db.py
```

For additional commands, see the included `Makefile` and scripts under `scripts/`.

## Context

This repository represents the **Round 2 dashboard and supporting application layer** of the project. The core AI Employee workflows, orchestration logic, and Operator execution remain hosted on the Auto by Supervity platform rather than being exported as local source code.
