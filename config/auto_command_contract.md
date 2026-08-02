# Auto ↔ Command Center contract

This repository does not create or publish Auto workflows. Configure the Auto
Orchestrator and Operators with this contract after the server environment is
set. Never place Auto or Supabase credentials in frontend variables.

## Safe finding payload

Every operator emits a structured finding and the legacy `reasons` projection:

```json
{
  "employee_id": "EMP-001",
  "operator_id": "OP-05",
  "reason_code": "COMPLIANCE_DEADLINE_AT_RISK",
  "reasons": ["COMPLIANCE_DEADLINE_AT_RISK"],
  "domain": "compliance",
  "severity": "high",
  "policy_version_id": "policy_x",
  "evaluated_at": "2026-08-02T09:00:00Z",
  "evidence_refs": ["compliance-item:CI-001"],
  "recommended_action": "Request document update"
}
```

Do not include Peakon comments, payroll `error_reason`, LLM thinking, access
tokens, email bodies, or unredacted evidence in any finding or event.

## Event ledger

Write only sanitized events to `workflow_events`. Use a stable `event_id` when
available; set `execution_id` to the internal command ID for UI-triggered runs.
The browser consumes `GET /api/hr/runs/{command_id}/events`, never Supabase
Realtime or Auto directly.

## Required Auto configuration

- Keep Auto URL, API key, organization ID, and workflow IDs in server-only
  environment variables.
- Allow only configured workflow IDs; the browser cannot choose a workflow or
  environment.
- For UI runs, FastAPI creates `command_runs` before invoking Auto streaming.
- For scheduled and Typeform runs, Auto writes an event ledger row and FastAPI
  reconciles run state through Auto's run-list/status API.
- Schedule the daily cohort sweep at 09:00 UTC. Apply due-date calculations in
  the worker jurisdiction timezone.
