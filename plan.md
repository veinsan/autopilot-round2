# HR & People Ops Command Center Plan

## Summary

This project extends the Round 1 onboarding workflow into a governed Round 2 Command Center. Supabase remains the HR system of record and event ledger; the browser communicates only with FastAPI.

## Architecture decisions

- Auto by Supervity owns all Orchestrator and Operator execution.
- FastAPI triggers Auto with a Custom API Key, `x-source: external`, and `x-active-org` headers.
- UI-initiated runs use Auto's `execute/stream` endpoint. FastAPI sanitizes and relays the SSE stream to the UI while persisting safe events to Supabase.
- Typeform- and schedule-initiated runs write sanitized activity to `workflow_events`; FastAPI uses the Auto Workflow Runs API only for reconciliation of active or stale runs.
- Do not implement outbound Auto webhooks. Auto's documented webhook capability is an inbound trigger.
- Never forward or persist Auto `thinking` events, raw pulse comments, or confidential payloads outside the restricted confidential path.
- Supabase access is server-side only. FastAPI enforces RBAC for Admin, People Ops, People Ops Confidential, and Manager.

## Scope

### Auto workforce

- Retain the Round 1 Orchestrator and OP-01 through OP-04.
- Add OP-05 Compliance & Work Authorization, OP-06 First-Payroll Verification, and OP-07 Cross-Team Provisioning & Manager Accountability.
- Run a daily cohort sweep at 09:00 UTC. Policies calculate deadlines from each worker's jurisdiction and timezone.

### Compliance design decisions

- Store validated `compliance_rules` as a versioned policy object keyed by jurisdiction and document type; Auto reads the active policy and FastAPI validates every edit.
- Keep compliance decisions deterministic. An LLM may narrate a sanitized result but never decide deadline, severity, or routing.
- Classify each finding as `ON_TRACK`, `AT_RISK`, or `LEGAL_BREACH`. A legal breach always routes directly to the People Ops/compliance owner and overrides lower-priority risk routing.
- Compute due dates as the end of the jurisdiction's local day. Resolve timezone from `Locations_Entities`, then `Workers.time_zone`; mismatches become a People Ops exception.
- Maintain one active compliance case per employee and jurisdiction, containing all current document findings. Update the case on each sweep; reopen it if a resolved risk recurs.
- Make the simulator a read-only current-cohort impact preview. It compares a draft policy with the active policy using the same deterministic evaluator and never claims unrecorded historical outcomes.

### Payroll design decisions

- Store editable first-payroll cutoff rules per jurisdiction in the versioned policy configuration. Use conservative demo defaults until an authoritative payroll calendar is available.
- Treat `Error` as a confirmed payroll case. Treat `Pending` as a case only after the applicable jurisdiction cutoff; a missing record after cutoff becomes a data-integrity case.
- Do not calculate an expected gross/net amount. Payroll status is authoritative; numeric checks are non-decisive sanity checks only.
- Create one active payroll case per `payroll_id`. Route confirmed errors to a restricted People Ops/payroll reviewer path, never to a manager nudge.
- Keep raw payroll error reasons out of Dashboard, Insights, standard events, and manager views. Payroll issues are explainable operational retention-risk modifiers, never individual resignation predictions.

### Cross-team and manager-accountability decisions

- OP-07 reads only standard operational data: cross-team dependencies, learning milestones, sanitized engagement metadata, and case/action state. It never reads raw pulse comments or confidential records.
- Model manager accountability as a system-managed state machine: `nudge_created` → `delivered` → `acknowledged` → `action_verified` or `escalated`. A Slack delivery or blank source field alone never proves a manager ignored a case.
- Make nudge cadence, acknowledgment deadline, action deadline, and maximum reminders editable per jurisdiction. A notification failure does not consume a reminder attempt; it creates an operational exception.
- Keep one active Day-1 readiness case per employee with all blocking dependencies. Create cohort-level bottleneck insights only when both a minimum affected-worker count and affected-cohort percentage cross editable thresholds.
- Route learning delays through the standard manager-to-People-Ops escalation path. Keep confidential and payroll cases outside OP-07's manager flow.

### Governance, Workbench, event, and KPI decisions

- Use policy lifecycle `draft` → `simulate` → `approved` → `active` → `retired`. Admin activates standard policies; confidential-routing changes require both Admin and People Ops Confidential approval. Every activation is versioned and reversible.
- Apply non-overridable safety guardrails before policy routing. A confidential signal creates a separate confidential case; it never suppresses a simultaneous compliance, payroll, or Day-1 case.
- Keep all Workbench cases human-closed: `open` → `in_review` → `awaiting_external_update` → `resolved`; a recurring signal reopens the same active-domain case. The system may mark a signal cleared, but never auto-resolves a human case.
- Treat the SSE stream as at-least-once delivery. Persist only a normalized, sanitized envelope keyed by `event_id`; discard `thinking` and private payloads; deduplicate retries at the database boundary.
- Define core KPIs from unresolved reason codes and policy state, not opaque model scores: Day-1 readiness, compliance exposure, provisioning SLA, manager-response rate, and operational retention-risk signals.
- Define integration health from the last successful required operation: Supabase read/write, Auto authenticated run/status call, Slack notification, and Typeform poll. Mark a connection `degraded` when stale and `down` on auth/error or extended staleness; never send test messages solely for a health check.

### Reason-code and Operator-contract decisions

- Keep existing Round 1 reason codes unchanged. Add domain-specific codes for compliance (`COMPLIANCE_DEADLINE_AT_RISK`, `COMPLIANCE_LEGAL_BREACH`, `WORK_AUTH_EXPIRY_AT_RISK`, `WORK_AUTH_EXPIRED`), payroll (`PAYROLL_ERROR_DETECTED`, `PAYROLL_NOT_CONFIRMED`, `PAYROLL_RECORD_MISSING`), and OP-07 (`DAY_ONE_DEPENDENCY_BLOCKED`, `LEARNING_MILESTONE_OVERDUE`, `MANAGER_ACKNOWLEDGMENT_OVERDUE`, `MANAGER_ACTION_OVERDUE`, `COHORT_DEPENDENCY_BOTTLENECK`).
- Maintain a versioned reason-code registry shared by Auto specifications, FastAPI validation, frontend labels, tests, and Insights. Reason-code meaning changes through engineering review, not a business-policy edit.
- Every Operator returns a structured finding with code, domain, severity, policy version, evaluated time, safe evidence references, owner, and recommended action. It also returns a backward-compatible `reasons[]` code projection for the existing Orchestrator.
- Route only from known reason codes and fixed safety guardrails. Severity is explanatory, never the sole routing authority. An unrecognized code becomes a Workbench/system exception and never silently triggers an action.
- Never include raw comments, payroll reasons, LLM reasoning, or direct sensitive evidence in findings, `reasons[]`, SSE events, or standard logs. Restricted cases carry a secure reference only.

### Auto and FastAPI event-contract decisions

- Add a durable `command_runs` record before invoking Auto. It stores the internal command ID, server-side workflow key, Auto run ID when known, safe scope metadata, trigger source, status, timestamps, and last reconciliation state.
- Expose `POST /api/hr/runs` to create a run request, `GET /api/hr/runs/{command_id}` for status, `GET /api/hr/runs/{command_id}/events` for sanitized SSE, and `POST /api/hr/runs/{command_id}/cancel` for authorized cancellation. The client never supplies an Auto workflow ID, environment override, or credential.
- Resolve only allowlisted workflow keys and inputs server-side. Admin and People Ops may run cohort or employee operations; Managers may request reassessment only for their direct reports and never a cohort sweep.
- Run Auto `execute/stream` in a supervised server task. Persist normalized stream events, then serve UI SSE from durable events so a browser reconnect does not decide whether an Auto run continues.
- Treat stream delivery as at-least-once. Deduplicate source events when a stable Auto activity ID is present; otherwise collapse repeated run-status events and let the reconciler enrich step-level history from the Auto run-detail API.
- Reconcile only active/stale runs at a bounded cadence. Auto-initiated schedule and Typeform runs are discovered through the run-list API and correlated with sanitized Auto-to-Supabase events.
- Configure the integration only through local server environment variables: Auto base URL, API key, active organization, allowlisted workflow IDs, and reconciliation interval. Never expose these to Next.js or permit caller-provided Auto environment overrides.

### KPI and cohort-operational-twin decisions

- Calculate every Dashboard, Insight, and simulator metric from the same explicit `as_of` timestamp. Use live server time by default and a pinned policy-configured date only for deterministic demo/test runs.
- Define active cohort workers as hires from Day 0 through Day 90 at `as_of`. Report Day-1 readiness only for workers within the Day-1 eligibility window; otherwise show `not applicable` rather than inventing a retrospective readiness result.
- Measure onboarding completion from tasks due on or before `as_of`; measure provisioning SLA from eligible provisioning events fulfilled within the policy grace window; measure compliance exposure from unresolved `AT_RISK` or `LEGAL_BREACH` findings; and measure manager-response rate from standard cases with an action deadline.
- Define operational retention risk as an explainable count of unresolved operational signals, not a personal probability of resignation. Use aggregate attrition history only for cohort-level context and recommendations.
- Implement the cohort operational twin as a deterministic dependency map: employee findings aggregate by reason code, dependency team, milestone, and jurisdiction. Surface a bottleneck only when configurable absolute-count and percentage thresholds are both met.
- Keep engagement aggregates separate from confidential records. Exclude confidential responses from standard Dashboard and Insights; suppress sensitive aggregate breakdowns below the configured minimum cohort size.
- Attach policy version, `as_of`, cohort filter, numerator, denominator, and last-refresh time to every KPI/Insight response so each displayed number is reproducible.

### Policies and insights

- Implement editable, versioned policies for compliance deadlines, risk/escalation thresholds, nudge cadence/manager accountability, and confidential routing.
- Keep confidentiality enforcement non-negotiable: routing may change, exposure may not.
- Generate deterministic metrics and risk clusters from sanitized operational data; use an LLM only to narrate aggregate findings and recommendations.
- Add a policy impact simulator that evaluates a proposed policy version against historical, sanitized cohort outcomes before activation.
- Add a cohort operational twin that highlights Day 1/30/90 milestone exposure, cross-team root causes, and highest-impact actions.
- Record human Workbench resolutions as governed feedback for policy recommendations; never modify a policy automatically.

### Command Center

- Replace template demo data with FastAPI-backed Dashboard, Workbench, Data Manager, AI Manager, Policies, and Insights views.
- Provide separate standard and confidential Workbench queues. Managers see only cases for their `Manager_WID`.

## Evaluation and demo strategy

- Cover intake ambiguity, compliance/work authorization, first-payroll error, day-one dependency blockers, learning delays, engagement risk, manager non-response, sensitive disclosure, and integration failure in the test suite.
- Demonstrate three complementary live paths: a cohort sweep with compliance and dependency risk, manager non-response escalating to People Ops, and a confidential disclosure with zero leakage.
- Use the policy impact simulator and cohort operational twin as the innovation moments in the demo; every claim must be backed by live data, policy evaluation logs, or workflow events.

## Implementation sequence

1. Add Auto configuration for the API key, active organization, and workflow IDs to local `.env`; never commit them.
2. Build/publish the three Round 2 Operators and add the daily cohort schedule in Auto.
3. Add FastAPI Auto client, sanitized SSE relay, durable event persistence, and active-run reconciliation.
4. Add FastAPI HR APIs for Dashboard data, policies, Workbench resolution, Data Manager health, and Insights.
5. Add controlled demo RBAC with explicit personas and Manager-to-`Manager_WID` mapping; keep interfaces ready for an SSO replacement.
6. Replace frontend demo surfaces with live API data and protected confidential UX.
7. Run privacy, policy-change, integration, and end-to-end workflow verification before the demo.

## Verification

- Test policy version/evaluation logging and confirm a changed threshold changes the Auto outcome.
- Test SSE status updates, duplicate events, stream interruption, and reconciliation.
- Test all Operator signals: legal deadline, payroll error, blocked dependency, manager non-response, ambiguous data, and confidential disclosure.
- Verify that standard APIs, Dashboard, Insights, and SSE never return confidential comments or payloads.
- Validate backend tests, frontend production build, and Supabase seeded record counts.

## Status tracker

Person A owns the Auto workspace and frontend. Person B owns FastAPI, server-side Supabase access, RBAC, and automated verification. The only intentional shared dependency is the versioned API/event contract; both tracks then proceed independently against mocks and fixtures.

| ID | Task | Person A | Person B | Dependency / parallelization | Status |
|---|---|---|---|---|---|
| F-01 | Agent guidance and project skill | — | — | Completed foundation | Done |
| F-02 | Supabase Round 2 schema | — | — | Completed foundation | Done |
| F-03 | Round 2 loader and boolean normalization | — | — | Completed foundation; 59/59 tests | Done |
| F-04 | Source data and policy seed | — | — | 11 tables, 33 canonical policy rows, active Stage 1 baseline, and live `policy_round2_v1` draft | Done (activation pending) |
| D-01 | SSE, event ledger, reconciliation, role, and policy decisions | Agree contract fields | Agree API representation | Short joint design task; freezes mocks before parallel work | Done |
| D-02 | Evaluation coverage, demo paths, and innovation choices | — | — | Eight core case classes; simulator, cohort twin, governed feedback | Done |
| D-03 | OP-05 compliance design decisions | — | — | Deterministic, jurisdiction-aware rules; grouped cases; transparent simulator | Done |
| D-04 | OP-06 payroll design decisions | — | — | Editable jurisdiction cutoff; restricted case routing; no salary inference | Done |
| D-05 | OP-07 cross-team and manager-accountability decisions | — | — | System-managed action state; grouped Day-1 cases; cohort bottleneck thresholds | Done |
| D-06 | Governance and Workbench lifecycle decisions | — | — | Versioned policy lifecycle; human-close cases; separate confidential handling | Done |
| D-07 | Event, KPI, and Data Manager decisions | — | — | Sanitized idempotent events; rule-based KPIs; non-invasive health checks | Done |
| D-08 | Reason code and Operator output contract | — | — | Stable registry; structured findings; legacy `reasons[]` compatibility | Done |
| D-09 | Auto/FastAPI event and API contract | — | — | Durable command run; sanitized reconnectable SSE; bounded reconciliation | Done |
| D-10 | KPI and cohort operational twin definitions | — | — | As-of consistency; explainable risk; privacy-safe deterministic bottlenecks | Done |
| A-01 | Capture Auto configuration | Store workflow IDs, active org, and API key in local `.env` | Review non-secret key names and config loader | Values are configured server-side; Auto run-list endpoint still needs contract validation before it is a health proof | Done (configured) |
| A-02 | Build OP-05, OP-06, OP-07 and daily cohort schedule | Build, publish, and live-verify Auto workflows | — | Independent of backend implementation after D-01 | Not started |
| A-03 | Add sanitized Auto event writes | Add `workflow_events` write step to each workflow | Provide event schema examples and validate payloads | Parallel; integration check occurs after both sides finish | Not started |
| A-04 | Replace frontend demo pages | Dashboard, Workbench, Policy Studio, and Data Manager use live FastAPI endpoints with English UI, non-lossy policy cloning, restricted payroll, and authoritative manager state | Publish stable API response examples | Production host and Docker builds pass | Done (code) |
| B-01 | Build server-side Supabase data layer | — | Paginated server-only PostgREST repository, allowlisted response contracts, jurisdiction-aware deterministic evaluator, bulk simulator dataset | Independent of Auto credentials; additive SQL must still be applied to Supabase | Done (code) |
| B-02 | Build FastAPI HR APIs and demo RBAC | — | Adds dedicated payroll isolation, safe case detail, non-lossy policy detail, and durable manager-action state/event APIs to the role-scoped Command Center | Live Supabase still needs the latest additive schema and `people_ops_payroll` role provisioning | Done (code) |
| B-03 | Build Auto SSE client and reconciler | Provide run IDs and live smoke-test access | Idempotent sanitized event transaction, monotonic reconnect cursor, idempotent run creation, confirmed cancellation state, leased automatic reconciliation, scheduled/Typeform discovery, and genuine Auto health probe | Offline reconciliation checks pass; live Auto validation still depends on A-01/A-02 | Done (mock) |
| B-04 | Automated quality and privacy checks | Supply live Auto test cases | Expanded policy seed, payroll mixed-role isolation, manager-state idempotency, payload guards, evaluator, reconciliation, and API tests | Full backend suite passes in Docker: 137 tests; clean-install SQL and RPC smoke tests also pass | Done (offline) |
| I-01 | Connect frontend to live FastAPI | Dashboard, Workbench, Policy Studio, and Data Manager are API-backed and production-built in English | Candidate simulation retains `findings_by_code` compatibility; backend publishes complete policy and manager-state contracts | Latest Supabase schema and role provisioning are still required for live G-02/G-03 | Done (code) |
| I-02 | Auto-to-Command-Center live validation | Run triggered, scheduled, and confidential cases | Verify event persistence, reconciliation, and API sanitization | Depends on A-02/A-03/B-03 | Not started |
| Q-01 | E2E, privacy audit, and demo rehearsal | Validate Auto behavior and UI demo flow | Validate API, RBAC, data correctness, and test evidence | Final joint acceptance | Not started |
