"""Human-facing HR Ops APIs with sanitized, role-scoped responses."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse

from ..schemas.hr import (
    CaseActionRequest,
    ManagerActionEventRequest,
    PolicyApprovalRequest,
    PolicyDraftRequest,
    PolicySimulationRequest,
    PolicyVisibilityRequest,
    RunRequest,
    RunResponse,
)
from ..security import get_current_user
from ..services.auto import AutoWorkflowClient
from ..services.hr import (
    HROpsService,
    KNOWN_REASON_CODES,
    assert_manager_owns_employee,
    can_access_payroll_cases,
    case_domain_scope,
    require_hr_role,
    sanitize,
    sanitize_case_rows,
    sanitize_event_rows,
    snapshot_hash,
)
from ..services.reconciliation import AutoRunReconciler

router = APIRouter(prefix="/hr", tags=["HR Operations"])


def service() -> HROpsService:
    return HROpsService()


def _is_manager_scoped(roles: set[str]) -> bool:
    """Confidential access never upgrades standard HR capabilities."""
    return "manager" in roles and not roles.intersection({"admin", "people_ops"})


def _employee_filter(hr: HROpsService, employee_ids: set[str]) -> str:
    return hr._in_filter(employee_ids)


@router.get("/dashboard")
def dashboard(
    user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)
):
    roles = require_hr_role(
        user, "admin", "people_ops", "people_ops_payroll", "manager"
    )
    employee_ids = hr.manager_report_ids(user) if _is_manager_scoped(roles) else None
    return hr.dashboard(employee_ids, case_scope=case_domain_scope(roles))


@router.get("/data-manager")
def data_manager(
    user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)
):
    require_hr_role(user, "admin", "people_ops")
    integrations = hr.repo.select(
        "integration_health",
        {
            "select": "integration_key,category,status,checked_at,last_success_at",
            "order": "integration_key",
        },
    )
    return {
        "integrations": sanitize(integrations),
        "refreshed_at": datetime.now(UTC).isoformat(),
    }


@router.get("/insights")
def insights(
    user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)
):
    roles = require_hr_role(
        user, "admin", "people_ops", "people_ops_payroll", "manager"
    )
    employee_ids = hr.manager_report_ids(user) if _is_manager_scoped(roles) else None
    return hr.case_metrics(employee_ids, case_scope=case_domain_scope(roles))


@router.get("/insights/operational-twin")
def operational_twin(
    cohort: str | None = None,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    roles = require_hr_role(
        user, "admin", "people_ops", "manager"
    )
    employee_ids = hr.manager_report_ids(user) if _is_manager_scoped(roles) else None
    return hr.operational_twin(cohort=cohort, employee_ids=employee_ids)


@router.get("/cases")
def list_cases(
    confidential: bool = False,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    if confidential:
        require_hr_role(user, "people_ops_confidential")
        rows = hr.repo.select_all(
            "Confidential_Cases",
            {
                "select": "case_id,created_at,employee_id,status,assigned_role,resolved_at",
                "order": "created_at.desc",
            },
        )
        return {"cases": sanitize(rows)}

    roles = require_hr_role(
        user, "admin", "people_ops", "people_ops_payroll", "manager"
    )
    params = {
        "select": "case_id,created_at,employee_id,case_type,priority,status,sanitized_context,assigned_to,resolved_at",
        "order": "created_at.desc",
    }
    scope = case_domain_scope(roles)
    if scope == "exclude_payroll":
        params["case_type"] = "neq.payroll"
    elif scope == "payroll_only":
        params["case_type"] = "eq.payroll"
    if _is_manager_scoped(roles):
        report_ids = hr.manager_report_ids(user)
        rows = (
            hr.repo.select_all(
                "workbench_cases",
                {**params, "employee_id": _employee_filter(hr, report_ids)},
            )
            if report_ids
            else []
        )
    else:
        rows = hr.repo.select_all("workbench_cases", params)
    return {"cases": sanitize_case_rows(rows)}


@router.get("/cases/{case_id}")
def get_case(
    case_id: str,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    roles = require_hr_role(
        user, "admin", "people_ops", "people_ops_payroll", "manager"
    )
    params = {
        "case_id": f"eq.{case_id}",
        "select": "case_id,created_at,employee_id,case_type,priority,status,sanitized_context,assigned_to,resolved_at",
    }
    scope = case_domain_scope(roles)
    if scope == "exclude_payroll":
        params["case_type"] = "neq.payroll"
    elif scope == "payroll_only":
        params["case_type"] = "eq.payroll"
    cases = hr.repo.select("workbench_cases", params)
    if not cases:
        raise HTTPException(status_code=404, detail="Case not found")
    if _is_manager_scoped(roles):
        employee_id = cases[0].get("employee_id")
        if not employee_id:
            raise HTTPException(status_code=404, detail="Case not found")
        assert_manager_owns_employee(hr, user, str(employee_id))
    return sanitize_case_rows(cases)[0]


@router.post("/cases/{case_id}/actions")
def act_on_case(
    case_id: str,
    request: CaseActionRequest,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    roles = require_hr_role(
        user, "admin", "people_ops", "people_ops_payroll", "manager"
    )
    cases = hr.repo.select(
        "workbench_cases",
        {
            "case_id": f"eq.{case_id}",
            "select": "case_id,employee_id,case_type,status",
        },
    )
    if not cases:
        raise HTTPException(status_code=404, detail="Case not found")
    is_payroll = str(cases[0].get("case_type") or "").lower() == "payroll"
    scope = case_domain_scope(roles)
    if (is_payroll and not can_access_payroll_cases(roles)) or (
        not is_payroll and scope == "payroll_only"
    ):
        # Hide restricted-case existence from a manager, including their report.
        raise HTTPException(status_code=404, detail="Case not found")
    if _is_manager_scoped(roles):
        employee_id = cases[0].get("employee_id")
        if not employee_id:
            raise HTTPException(status_code=404, detail="Case not found")
        assert_manager_owns_employee(hr, user, str(employee_id))
    status_value = hr.repo.rpc(
        "record_case_action",
        {
            "target_case_id": case_id,
            "case_table": "standard",
            "actor_subject": user.get("sub", "unknown"),
            "action_decision": request.decision,
            "safe_feedback": request.resolution_code,
        },
    )
    return {"case_id": case_id, "status": status_value or "recorded"}


@router.get("/manager-actions")
def list_manager_actions(
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    roles = require_hr_role(user, "admin", "people_ops", "manager")
    employee_ids = hr.manager_report_ids(user) if _is_manager_scoped(roles) else None
    return {"states": hr.manager_action_states(employee_ids=employee_ids)}


@router.get("/manager-actions/{case_id}")
def get_manager_action(
    case_id: str,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    roles = require_hr_role(user, "admin", "people_ops", "manager")
    employee_ids = hr.manager_report_ids(user) if _is_manager_scoped(roles) else None
    states = hr.manager_action_states(employee_ids=employee_ids, case_id=case_id)
    if not states:
        raise HTTPException(status_code=404, detail="Manager action state not found")
    return states[0]


@router.post("/manager-actions/{case_id}/events")
def record_manager_action_event(
    case_id: str,
    request: ManagerActionEventRequest,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    roles = require_hr_role(user, "admin", "people_ops", "manager")
    if _is_manager_scoped(roles):
        states = hr.manager_action_states(case_id=case_id)
        if not states:
            raise HTTPException(status_code=404, detail="Manager action state not found")
        assert_manager_owns_employee(hr, user, str(states[0]["employee_id"]))
        if request.event_type != "acknowledged":
            raise HTTPException(
                status_code=403,
                detail="Managers may only acknowledge an assigned action",
            )
    state = hr.repo.rpc(
        "record_manager_action_event",
        {
            "target_case_id": case_id,
            "new_source_event_id": request.source_event_id,
            "new_event_type": request.event_type,
            "event_occurred_at": request.occurred_at.isoformat(),
            "new_next_reminder_at": (
                request.next_reminder_at.isoformat()
                if request.next_reminder_at
                else None
            ),
            "new_acknowledgment_deadline": (
                request.acknowledgment_deadline.isoformat()
                if request.acknowledgment_deadline
                else None
            ),
            "new_action_deadline": (
                request.action_deadline.isoformat()
                if request.action_deadline
                else None
            ),
        },
    )
    return state


@router.post("/confidential-cases/{case_id}/actions")
def act_on_confidential_case(
    case_id: str,
    request: CaseActionRequest,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    require_hr_role(user, "people_ops_confidential")
    cases = hr.repo.select(
        "Confidential_Cases",
        {"case_id": f"eq.{case_id}", "select": "case_id,status"},
    )
    if not cases:
        raise HTTPException(status_code=404, detail="Case not found")
    status_value = hr.repo.rpc(
        "record_case_action",
        {
            "target_case_id": case_id,
            "case_table": "confidential",
            "actor_subject": user.get("sub", "unknown"),
            "action_decision": request.decision,
            "safe_feedback": request.resolution_code,
        },
    )
    return {"case_id": case_id, "status": status_value or "recorded"}


@router.get("/policies")
def list_policies(
    include_hidden: bool = Query(
        False, description="Include versions hidden from the dashboard."
    ),
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    require_hr_role(user, "admin", "people_ops", "people_ops_confidential")
    params = {
        "select": "version_id,status,created_at,created_by,change_summary,snapshot_hash,activated_at,parent_version_id,hidden_at,hidden_by",
        "order": "created_at.desc",
    }
    if not include_hidden:
        params["hidden_at"] = "is.null"
    rows = hr.repo.select_all("policy_versions", params)
    return {"policies": sanitize(rows)}


@router.get("/policies/{version_id}")
def get_policy(
    version_id: str,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    """Return the complete governed snapshot so Policy Studio can clone it."""
    require_hr_role(user, "admin", "people_ops", "people_ops_confidential")
    rows = hr.repo.select(
        "policy_versions",
        {
            "version_id": f"eq.{version_id}",
            "select": "version_id,status,created_at,created_by,change_summary,snapshot_hash,activated_at,parent_version_id,config_snapshot",
        },
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Policy version not found")
    # The snapshot is returned without lossy key filtering. Policy writes pass
    # the strict policy validator and this endpoint is restricted to governors.
    return rows[0]


@router.post("/policies")
def create_policy(
    request: PolicyDraftRequest,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    require_hr_role(user, "admin", "people_ops")
    errors = hr.evaluator.validate(request.config_snapshot)
    if errors:
        raise HTTPException(status_code=422, detail={"validation_errors": errors})
    version_id = f"policy_{uuid.uuid4().hex}"
    active = hr.active_policy()
    confidential = hr.changes_confidential_routing(request.config_snapshot)
    hr.repo.insert(
        "policy_versions",
        {
            "version_id": version_id,
            "created_by": user.get("sub"),
            "config_snapshot": request.config_snapshot,
            "change_summary": request.change_summary,
            "status": "draft",
            "snapshot_hash": snapshot_hash(request.config_snapshot),
            "is_confidential_routing": confidential,
            "parent_version_id": active.get("version_id") if active else None,
        },
    )
    return {"version_id": version_id, "status": "draft"}


@router.patch("/policies/{version_id}")
def update_policy_draft(
    version_id: str,
    request: PolicyDraftRequest,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    """Edit a draft in place; simulated and historical snapshots stay immutable."""
    require_hr_role(user, "admin", "people_ops")
    errors = hr.evaluator.validate(request.config_snapshot)
    if errors:
        raise HTTPException(status_code=422, detail={"validation_errors": errors})
    rows = hr.repo.patch(
        "policy_versions",
        {"version_id": f"eq.{version_id}", "status": "eq.draft"},
        {
            "config_snapshot": request.config_snapshot,
            "change_summary": request.change_summary,
            "snapshot_hash": snapshot_hash(request.config_snapshot),
            "is_confidential_routing": hr.changes_confidential_routing(
                request.config_snapshot
            ),
        },
    )
    if not rows:
        raise HTTPException(
            status_code=409, detail="Only draft policies can be edited"
        )
    return {"version_id": version_id, "status": "draft"}


@router.delete("/policies/{version_id}")
def delete_policy_draft(
    version_id: str,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    """Delete an unsubmitted draft without allowing lifecycle history removal."""
    require_hr_role(user, "admin", "people_ops")
    rows = hr.repo.delete(
        "policy_versions",
        {"version_id": f"eq.{version_id}", "status": "eq.draft"},
    )
    if not rows:
        raise HTTPException(
            status_code=409, detail="Only draft policies can be deleted"
        )
    return {"version_id": version_id, "deleted": True}


@router.patch("/policies/{version_id}/visibility")
def set_policy_visibility(
    version_id: str,
    request: PolicyVisibilityRequest,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    """Hide or restore a version in Policy Studio without touching the record.

    The row and its lifecycle history stay in Supabase; only the default
    dashboard listing is filtered. The active policy always stays visible so the
    governed baseline can never disappear from the studio.
    """
    require_hr_role(user, "admin", "people_ops")
    rows = hr.repo.select(
        "policy_versions",
        {"version_id": f"eq.{version_id}", "select": "version_id,status"},
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Policy version not found")
    if request.hidden and rows[0].get("status") == "active":
        raise HTTPException(
            status_code=409, detail="The active policy version cannot be hidden"
        )
    hidden_at = datetime.now(UTC).isoformat() if request.hidden else None
    hr.repo.patch(
        "policy_versions",
        {"version_id": f"eq.{version_id}"},
        {
            "hidden_at": hidden_at,
            "hidden_by": user.get("sub") if request.hidden else None,
        },
    )
    return {"version_id": version_id, "hidden": request.hidden}


@router.post("/policies/simulations")
def simulate_policy(
    request: PolicySimulationRequest,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    require_hr_role(user, "admin", "people_ops")
    versions = hr.repo.select(
        "policy_versions",
        {
            "version_id": f"eq.{request.version_id}",
            "select": "version_id,status,config_snapshot",
        },
    )
    if not versions:
        raise HTTPException(status_code=404, detail="Policy version not found")
    if versions[0].get("status") != "draft":
        raise HTTPException(status_code=409, detail="Only draft policies can be simulated")
    candidate = versions[0]["config_snapshot"]
    errors = hr.evaluator.validate(candidate)
    if errors:
        raise HTTPException(status_code=422, detail={"validation_errors": errors})
    params = {"select": "Employee_ID,cohort,work_auth_expiry,Hire_Date"}
    if request.cohort:
        params["cohort"] = f"eq.{request.cohort}"
    workers = hr.repo.select_all("Workers", params)
    as_of = (request.as_of or datetime.now(UTC)).date()
    result = hr.compare_policy(candidate, workers, as_of)
    simulation_id = f"sim_{uuid.uuid4().hex}"
    hr.repo.rpc(
        "record_policy_simulation",
        {
            "new_simulation_id": simulation_id,
            "target_version_id": request.version_id,
            "actor_subject": user.get("sub", "unknown"),
            "evaluation_date": as_of.isoformat(),
            "target_cohort": request.cohort,
            "simulation_result": result,
        },
    )
    return {"simulation_id": simulation_id, "as_of": as_of, "result": result}


@router.post("/policies/{version_id}/approvals")
def approve_policy(
    version_id: str,
    request: PolicyApprovalRequest,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    roles = require_hr_role(user, "admin", "people_ops_confidential")
    approver_role = "admin" if "admin" in roles else "people_ops_confidential"
    policy_status = hr.repo.rpc(
        "record_policy_approval",
        {
            "target_version_id": version_id,
            "actor_subject": user.get("sub", "unknown"),
            "actor_role": approver_role,
            "approval_decision": request.decision,
            "approval_note": request.note,
        },
    )
    return {
        "version_id": version_id,
        "decision": request.decision,
        "status": policy_status or "simulated",
    }


@router.post("/policies/{version_id}/activate")
def activate_policy(
    version_id: str,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    require_hr_role(user, "admin")
    hr.repo.rpc(
        "activate_policy_version",
        {
            "target_version_id": version_id,
            "actor_subject": user.get("sub", "unknown"),
        },
    )
    return {"version_id": version_id, "status": "active"}


@router.post("/policies/{version_id}/rollback")
def prepare_policy_rollback(
    version_id: str,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    """Clone an old policy as a draft; it must pass simulation and approval again."""
    require_hr_role(user, "admin")
    sources = hr.repo.select(
        "policy_versions",
        {
            "version_id": f"eq.{version_id}",
            "select": "version_id,config_snapshot,is_confidential_routing",
        },
    )
    if not sources:
        raise HTTPException(status_code=404, detail="Policy version not found")
    rollback_id = f"policy_{uuid.uuid4().hex}"
    snapshot = sources[0]["config_snapshot"]
    hr.repo.insert(
        "policy_versions",
        {
            "version_id": rollback_id,
            "parent_version_id": version_id,
            "created_by": user.get("sub"),
            "config_snapshot": snapshot,
            "change_summary": f"Rollback candidate from {version_id}",
            "status": "draft",
            "snapshot_hash": snapshot_hash(snapshot),
            "is_confidential_routing": hr.changes_confidential_routing(snapshot),
        },
    )
    return {"version_id": rollback_id, "status": "draft", "source": version_id}


@router.post("/runs/reconcile")
def reconcile_runs(
    user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)
):
    require_hr_role(user, "admin", "people_ops")
    return AutoRunReconciler(hr.repo).reconcile_once()


@router.post("/runs", response_model=RunResponse)
def create_run(
    request: RunRequest,
    background_tasks: BackgroundTasks,
    idempotency_key: str = Header(
        ..., alias="Idempotency-Key", min_length=8, max_length=128
    ),
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    roles = require_hr_role(user, "admin", "people_ops", "manager")
    auto = AutoWorkflowClient(hr.repo)
    if not auto.configured:
        raise HTTPException(status_code=503, detail="Auto workflow is not configured")
    if request.reason_code and request.reason_code not in KNOWN_REASON_CODES:
        raise HTTPException(status_code=422, detail="Unknown run reason code")
    if _is_manager_scoped(roles) and request.scope != "employee":
        raise HTTPException(
            status_code=403, detail="Managers may only reassess a direct report"
        )
    if request.employee_id:
        hr.assert_employee_access(user, request.employee_id)
    else:
        cohorts = hr.repo.select(
            "Workers",
            {"cohort": f"eq.{request.cohort}", "select": "cohort", "limit": "1"},
        )
        if not cohorts:
            raise HTTPException(status_code=404, detail="Cohort not found")
    run = hr.create_run(
        user.get("sub", "unknown"), request.model_dump(), idempotency_key
    )
    inputs = {
        "scope": request.scope,
        "employee_id": request.employee_id,
        "cohort": request.cohort,
        "reason_code": request.reason_code,
        "command_id": run["command_id"],
    }
    if run.get("status") == "queued":
        background_tasks.add_task(auto.execute_stream, run["command_id"], inputs)
    return run


@router.get("/runs/{command_id}")
def get_run(
    command_id: str,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    require_hr_role(user, "admin", "people_ops", "manager")
    rows = hr.repo.select(
        "command_runs",
        {
            "command_id": f"eq.{command_id}",
            "select": "command_id,created_at,created_by,status,scope,employee_id,cohort,requested_reason,workflow_key,trigger_source,last_event_at,last_reconciled_at,reconciliation_status,error_code",
        },
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Command run not found")
    hr.assert_run_access(user, rows[0])
    return sanitize(rows[0])


@router.get("/runs/{command_id}/events")
def run_events(
    command_id: str,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    require_hr_role(user, "admin", "people_ops", "manager")
    runs = hr.repo.select(
        "command_runs",
        {
            "command_id": f"eq.{command_id}",
            "select": "command_id,created_by,status,scope,employee_id",
        },
    )
    if not runs:
        raise HTTPException(status_code=404, detail="Command run not found")
    hr.assert_run_access(user, runs[0])
    event_params = {
        "execution_id": f"eq.{command_id}",
        "select": "event_id,sequence_no,occurred_at,operator_id,event_type,status,reason_codes,details",
        "order": "sequence_no",
    }
    reset_cursor = False
    cursor_sequence = 0
    if last_event_id:
        cursor_rows = hr.repo.select(
            "workflow_events",
            {
                "execution_id": f"eq.{command_id}",
                "event_id": f"eq.{last_event_id}",
                "select": "sequence_no",
                "limit": "1",
            },
        )
        if cursor_rows and cursor_rows[0].get("sequence_no") is not None:
            cursor_sequence = int(cursor_rows[0]["sequence_no"])
            event_params["sequence_no"] = f"gt.{cursor_sequence}"
        else:
            reset_cursor = True
    events = hr.repo.select_all("workflow_events", event_params)

    async def event_stream():
        if reset_cursor:
            yield 'event: cursor_reset\ndata: {"reason":"cursor_not_found"}\n\n'
        safe_events = sanitize_event_rows(events)
        for event in safe_events:
            yield f"id: {event['event_id']}\nevent: hr_event\ndata: {json.dumps(event)}\n\n"
        last_sequence = max(
            (int(event.get("sequence_no") or 0) for event in events),
            default=cursor_sequence,
        )
        terminal = {"completed", "failed", "cancelled"}
        if runs[0].get("status") in terminal:
            yield "event: complete\ndata: {}\n\n"
            return
        for _ in range(10):
            await asyncio.sleep(2)
            new_params = {**event_params, "sequence_no": f"gt.{last_sequence}"}
            new_events = await asyncio.to_thread(
                hr.repo.select_all, "workflow_events", new_params
            )
            for event in sanitize_event_rows(new_events):
                yield f"id: {event['event_id']}\nevent: hr_event\ndata: {json.dumps(event)}\n\n"
            if new_events:
                last_sequence = max(
                    int(event.get("sequence_no") or 0) for event in new_events
                )
            latest = await asyncio.to_thread(
                hr.repo.select,
                "command_runs",
                {
                    "command_id": f"eq.{command_id}",
                    "select": "status",
                    "limit": "1",
                },
            )
            if latest and latest[0].get("status") in terminal:
                yield "event: complete\ndata: {}\n\n"
                return
            yield ": heartbeat\n\n"
        yield 'retry: 3000\nevent: waiting\ndata: {"reconnect":true}\n\n'

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/runs/{command_id}/cancel")
def cancel_run(
    command_id: str,
    user: dict = Depends(get_current_user),
    hr: HROpsService = Depends(service),
):
    require_hr_role(user, "admin", "people_ops")
    runs = hr.repo.select(
        "command_runs",
        {
            "command_id": f"eq.{command_id}",
            "select": "command_id,status,auto_run_id",
        },
    )
    if not runs:
        raise HTTPException(status_code=404, detail="Command run not found")
    if runs[0].get("status") not in {"queued", "running"}:
        raise HTTPException(status_code=409, detail="Run cannot be cancelled")
    now = datetime.now(UTC).isoformat()
    cancelled_before_start = hr.repo.patch(
        "command_runs",
        {"command_id": f"eq.{command_id}", "status": "eq.queued"},
        {
            "status": "cancelled",
            "cancel_requested_at": now,
            "last_event_at": now,
            "reconciliation_status": "complete",
        },
    )
    if cancelled_before_start:
        return {"command_id": command_id, "status": "cancelled"}

    current = hr.repo.select(
        "command_runs",
        {
            "command_id": f"eq.{command_id}",
            "select": "status,auto_run_id",
        },
    )
    if not current or current[0].get("status") != "running":
        raise HTTPException(
            status_code=409,
            detail="Run reached a terminal state before cancellation completed",
        )
    requested = hr.repo.patch(
        "command_runs",
        {
            "command_id": f"eq.{command_id}",
            "status": "eq.running",
            "cancel_requested_at": "is.null",
        },
        {
            "cancel_requested_at": now,
            "reconciliation_status": "pending",
        },
    )
    if not requested:
        raise HTTPException(
            status_code=409,
            detail="Cancellation was already requested or the run became terminal",
        )
    auto_run_id = current[0].get("auto_run_id")
    if not auto_run_id:
        return {"command_id": command_id, "status": "cancellation_requested"}
    try:
        AutoWorkflowClient(hr.repo).cancel(str(auto_run_id))
    except Exception as exc:
        hr.repo.patch(
            "command_runs",
            {"command_id": f"eq.{command_id}"},
            {"error_code": "AUTO_CANCEL_FAILED", "reconciliation_status": "required"},
        )
        raise HTTPException(
            status_code=502, detail="Auto cancellation could not be confirmed"
        ) from exc
    dispatched = hr.repo.patch(
        "command_runs",
        {"command_id": f"eq.{command_id}", "status": "eq.running"},
        {
            "cancel_dispatched_at": now,
            "reconciliation_status": "required",
        },
    )
    if not dispatched:
        raise HTTPException(
            status_code=409,
            detail="Run reached a terminal state before cancellation completed",
        )
    return {"command_id": command_id, "status": "cancellation_requested"}
