"""Human-facing HR Ops APIs. All responses are sanitized before leaving the server."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import json

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import StreamingResponse

from ..schemas.hr import CaseActionRequest, PolicyApprovalRequest, PolicyDraftRequest, PolicySimulationRequest, RunRequest, RunResponse
from ..security import get_current_user
from ..services.auto import AutoWorkflowClient
from ..services.hr import HROpsService, require_hr_role, sanitize, user_roles

router = APIRouter(prefix="/hr", tags=["HR Operations"])


def service() -> HROpsService:
    return HROpsService()


def assert_manager_owns_employee(hr: HROpsService, user: dict, employee_id: str) -> None:
    """Enforce relationship-based access from server-owned identity mapping."""
    roles = user_roles(user)
    if not ("manager" in roles and not roles.intersection({"admin", "people_ops", "people_ops_confidential"})):
        return
    profiles = hr.repo.select("identity_profiles", {"auth_subject": f"eq.{user.get('sub')}", "select": "manager_wid"})
    manager_wid = profiles[0].get("manager_wid") if profiles else None
    if not manager_wid:
        raise HTTPException(status_code=403, detail="Manager identity mapping is not configured")
    reports = hr.repo.select("Workers", {"Employee_ID": f"eq.{employee_id}", "Manager_WID": f"eq.{manager_wid}", "select": "Employee_ID"})
    if not reports:
        raise HTTPException(status_code=403, detail="Employee is not a direct report")


@router.get("/dashboard")
def dashboard(user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    require_hr_role(user, "admin", "people_ops", "people_ops_confidential", "manager")
    return hr.dashboard()


@router.get("/data-manager")
def data_manager(user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    require_hr_role(user, "admin", "people_ops", "people_ops_confidential")
    integrations = hr.repo.select("integration_health", {"select": "integration_key,category,status,checked_at,last_success_at,detail", "order": "integration_key"})
    return {"integrations": sanitize(integrations), "refreshed_at": datetime.now(UTC).isoformat()}


@router.get("/insights")
def insights(user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    require_hr_role(user, "admin", "people_ops", "people_ops_confidential", "manager")
    cases = hr.repo.select("workbench_cases", {"select": "case_type,priority,status"})
    open_cases = [case for case in cases if case.get("status") != "resolved"]
    by_type: dict[str, int] = {}
    for case in open_cases:
        key = case.get("case_type", "unknown")
        by_type[key] = by_type.get(key, 0) + 1
    return {"as_of": datetime.now(UTC).isoformat(), "open_case_count": len(open_cases), "open_cases_by_type": by_type}


@router.get("/cases")
def list_cases(confidential: bool = False, user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    roles = require_hr_role(user, "admin", "people_ops", "people_ops_confidential", "manager")
    if confidential:
        require_hr_role(user, "admin", "people_ops_confidential")
        return {"cases": sanitize(hr.repo.select("Confidential_Cases", {"select": "case_id,created_at,employee_id,status,assigned_role,resolved_at"}))}
    cases = hr.repo.select("workbench_cases", {"select": "case_id,created_at,employee_id,case_type,priority,status,recommended_action,sanitized_context,assigned_to,resolved_at", "order": "created_at.desc"})
    if "manager" in roles and not roles.intersection({"admin", "people_ops", "people_ops_confidential"}):
        profiles = hr.repo.select("identity_profiles", {"auth_subject": f"eq.{user.get('sub')}", "select": "manager_wid"})
        manager_wid = profiles[0].get("manager_wid") if profiles else None
        if not manager_wid:
            return {"cases": []}
        reports = hr.repo.select("Workers", {"select": "Employee_ID", "Manager_WID": f"eq.{manager_wid}"})
        allowed = {row.get("Employee_ID") for row in reports}
        cases = [case for case in cases if case.get("employee_id") in allowed]
    return {"cases": sanitize(cases)}


@router.post("/cases/{case_id}/actions")
def act_on_case(case_id: str, request: CaseActionRequest, user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    roles = require_hr_role(user, "admin", "people_ops", "people_ops_confidential", "manager")
    if "manager" in roles and not roles.intersection({"admin", "people_ops", "people_ops_confidential"}):
        cases = hr.repo.select("workbench_cases", {"case_id": f"eq.{case_id}", "select": "employee_id"})
        if not cases or not cases[0].get("employee_id"):
            raise HTTPException(status_code=404, detail="Case not found")
        assert_manager_owns_employee(hr, user, cases[0]["employee_id"])
    if request.decision == "resolve":
        hr.repo.patch("workbench_cases", {"case_id": f"eq.{case_id}"}, {"status": "resolved", "resolved_at": datetime.now(UTC).isoformat()})
    elif request.decision == "await_external_update":
        hr.repo.patch("workbench_cases", {"case_id": f"eq.{case_id}"}, {"status": "awaiting_external_update"})
    elif request.decision == "claim":
        hr.repo.patch("workbench_cases", {"case_id": f"eq.{case_id}"}, {"status": "in_review", "assigned_to": user.get("sub")})
    hr.repo.insert("case_resolutions", {"resolution_id": f"res_{uuid.uuid4().hex}", "case_id": case_id, "resolved_by": user.get("sub", "unknown"), "decision": request.decision, "sanitized_feedback": request.sanitized_feedback})
    return {"case_id": case_id, "status": "recorded"}


@router.get("/policies")
def list_policies(user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    require_hr_role(user, "admin", "people_ops", "people_ops_confidential")
    return {"policies": sanitize(hr.repo.select("policy_versions", {"select": "version_id,status,created_at,created_by,change_summary,snapshot_hash,activated_at", "order": "created_at.desc"}))}


@router.post("/policies")
def create_policy(request: PolicyDraftRequest, user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    require_hr_role(user, "admin", "people_ops")
    errors = hr.evaluator.validate(request.config_snapshot)
    if errors:
        raise HTTPException(status_code=422, detail={"validation_errors": errors})
    from ..services.hr import snapshot_hash
    version_id = f"policy_{uuid.uuid4().hex}"
    routing = request.config_snapshot.get("routing", {})
    is_confidential_routing = isinstance(routing, dict) and any("confidential" in f"{key} {value}".lower() for key, value in routing.items())
    hr.repo.insert("policy_versions", {"version_id": version_id, "created_by": user.get("sub"), "config_snapshot": request.config_snapshot, "change_summary": request.change_summary, "status": "draft", "snapshot_hash": snapshot_hash(request.config_snapshot), "is_confidential_routing": is_confidential_routing})
    return {"version_id": version_id, "status": "draft"}


@router.post("/policies/simulations")
def simulate_policy(request: PolicySimulationRequest, user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    require_hr_role(user, "admin", "people_ops")
    versions = hr.repo.select("policy_versions", {"version_id": f"eq.{request.version_id}", "select": "version_id,config_snapshot"})
    if not versions:
        raise HTTPException(status_code=404, detail="Policy version not found")
    errors = hr.evaluator.validate(versions[0]["config_snapshot"])
    if errors:
        raise HTTPException(status_code=422, detail={"validation_errors": errors})
    params = {"select": "Employee_ID,cohort,work_auth_expiry"}
    if request.cohort:
        params["cohort"] = f"eq.{request.cohort}"
    workers = hr.repo.select("Workers", params)
    as_of = (request.as_of or datetime.now(UTC)).date()
    findings = [(worker.get("Employee_ID"), finding) for worker in workers for finding in hr.evaluator.evaluate_worker(worker, as_of)]
    simulation_id = f"sim_{uuid.uuid4().hex}"
    result = {"workers_evaluated": len(workers), "findings_by_code": {code: sum(item[1]["reason_code"] == code for item in findings) for code in sorted({item[1]["reason_code"] for item in findings})}}
    hr.repo.insert("policy_simulations", {"simulation_id": simulation_id, "version_id": request.version_id, "created_by": user.get("sub"), "as_of": as_of.isoformat(), "cohort": request.cohort, "result": result})
    hr.repo.patch("policy_versions", {"version_id": f"eq.{request.version_id}", "status": "eq.draft"}, {"status": "simulated"})
    return {"simulation_id": simulation_id, "as_of": as_of, "result": result}


@router.post("/policies/{version_id}/approvals")
def approve_policy(version_id: str, request: PolicyApprovalRequest, user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    roles = require_hr_role(user, "admin", "people_ops_confidential")
    approver_role = "admin" if "admin" in roles else "people_ops_confidential"
    hr.repo.insert("policy_approvals", {"approval_id": f"approval_{uuid.uuid4().hex}", "version_id": version_id, "approved_by": user.get("sub"), "approver_role": approver_role, "decision": request.decision, "note": request.note})
    if request.decision == "approve":
        updated = hr.repo.patch("policy_versions", {"version_id": f"eq.{version_id}", "status": "eq.simulated"}, {"status": "approved", "approved_at": datetime.now(UTC).isoformat()})
        if not updated:
            raise HTTPException(status_code=409, detail="Policy must be simulated before approval")
    return {"version_id": version_id, "decision": request.decision}


@router.post("/policies/{version_id}/activate")
def activate_policy(version_id: str, user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    roles = require_hr_role(user, "admin")
    versions = hr.repo.select("policy_versions", {"version_id": f"eq.{version_id}", "select": "version_id,status,is_confidential_routing"})
    if not versions:
        raise HTTPException(status_code=404, detail="Policy version not found")
    approvals = hr.repo.select("policy_approvals", {"version_id": f"eq.{version_id}", "decision": "eq.approve", "select": "approved_by,approver_role"})
    if not any(row.get("approver_role") == "admin" for row in approvals):
        raise HTTPException(status_code=409, detail="An Admin approval is required")
    if versions[0].get("is_confidential_routing"):
        approvers = {row.get("approved_by") for row in approvals}
        if not any(row.get("approver_role") == "people_ops_confidential" for row in approvals) or len(approvers) < 2:
            raise HTTPException(status_code=409, detail="Confidential routing requires independent confidential approval")
    hr.repo.rpc("activate_policy_version", {"target_version_id": version_id, "actor_subject": user.get("sub", "unknown")})
    return {"version_id": version_id, "status": "active"}


@router.post("/runs", response_model=RunResponse)
def create_run(request: RunRequest, background_tasks: BackgroundTasks, user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    roles = require_hr_role(user, "admin", "people_ops", "manager")
    if request.scope == "employee" and not request.employee_id:
        raise HTTPException(status_code=422, detail="employee_id is required for employee scope")
    if request.scope == "cohort" and not request.cohort:
        raise HTTPException(status_code=422, detail="cohort is required for cohort scope")
    if "manager" in roles and not roles.intersection({"admin", "people_ops"}) and request.scope != "employee":
        raise HTTPException(status_code=403, detail="Managers may only reassess a direct report")
    if request.scope == "employee" and request.employee_id:
        assert_manager_owns_employee(hr, user, request.employee_id)
    run = hr.create_run(user.get("sub", "unknown"), request.model_dump())
    auto = AutoWorkflowClient(hr.repo)
    if auto.configured:
        background_tasks.add_task(auto.execute_stream, run["command_id"], {"scope": request.scope, "employee_id": request.employee_id, "cohort": request.cohort, "command_id": run["command_id"]})
    return run


@router.get("/runs/{command_id}")
def get_run(command_id: str, user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    require_hr_role(user, "admin", "people_ops", "manager")
    rows = hr.repo.select("command_runs", {"command_id": f"eq.{command_id}"})
    if not rows:
        raise HTTPException(status_code=404, detail="Command run not found")
    return sanitize(rows[0])


@router.get("/runs/{command_id}/events")
def run_events(command_id: str, user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    require_hr_role(user, "admin", "people_ops", "manager")
    events = hr.repo.select("workflow_events", {"execution_id": f"eq.{command_id}", "select": "event_id,occurred_at,operator_id,event_type,status,reason_codes,details", "order": "occurred_at"})

    def event_stream():
        for event in sanitize(events):
            yield f"id: {event['event_id']}\nevent: hr_event\ndata: {json.dumps(event)}\n\n"
        yield "event: complete\ndata: {}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/runs/{command_id}/cancel")
def cancel_run(command_id: str, user: dict = Depends(get_current_user), hr: HROpsService = Depends(service)):
    require_hr_role(user, "admin", "people_ops")
    runs = hr.repo.select("command_runs", {"command_id": f"eq.{command_id}", "select": "auto_run_id"})
    updated = hr.repo.patch("command_runs", {"command_id": f"eq.{command_id}", "status": "in.(queued,running)"}, {"status": "cancelled"})
    if not updated:
        raise HTTPException(status_code=409, detail="Run cannot be cancelled")
    auto_run_id = runs[0].get("auto_run_id") if runs else None
    if auto_run_id:
        try:
            AutoWorkflowClient(hr.repo).cancel(auto_run_id)
        except Exception:
            # Local cancellation remains durable; reconciliation can surface an
            # upstream cancellation failure without exposing transport details.
            pass
    return {"command_id": command_id, "status": "cancelled"}
