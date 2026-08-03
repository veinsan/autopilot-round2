"""Offline unit tests for the HR Ops service and boundary helpers.

These tests deliberately use an in-memory repository.  They must never depend
on Supabase, Keycloak, or Auto being reachable.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.routers.hr import (
    act_on_case,
    dashboard as dashboard_endpoint,
    get_case,
    get_policy,
    insights as insights_endpoint,
    list_cases,
    record_manager_action_event,
)
from app.schemas.hr import CaseActionRequest, ManagerActionEventRequest, RunRequest
from app.services.auto import AutoWorkflowClient
from app.services.hr import (
    HROpsService,
    KNOWN_REASON_CODES,
    PolicyEvaluator,
    assert_manager_owns_employee,
    can_access_payroll_cases,
    case_domain_scope,
    require_hr_role,
    sanitize,
    sanitize_case_rows,
    sanitize_event_rows,
    snapshot_hash,
    user_roles,
)


def round2_policy() -> dict[str, Any]:
    path = Path(__file__).resolve().parents[1] / "config" / "policy_config.json"
    return json.loads(path.read_text(encoding="utf-8"))


class FakeRepository:
    """Small query-aware fake matching the repository methods used here."""

    def __init__(self, tables: dict[str, list[dict[str, Any]]] | None = None) -> None:
        self.tables = tables or {}
        self.inserts: list[tuple[str, dict[str, Any]]] = []
        self.patches: list[tuple[str, dict[str, str], dict[str, Any]]] = []
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []

    def select(
        self, table: str, params: dict[str, str] | None = None
    ) -> list[dict[str, Any]]:
        rows = [dict(row) for row in self.tables.get(table, [])]
        for key, expression in (params or {}).items():
            if key in {"select", "order", "limit", "offset"}:
                continue
            if expression.startswith("eq."):
                expected = expression[3:]
                rows = [
                    row
                    for row in rows
                    if str(row.get(key)).lower() == expected.lower()
                ]
            elif expression.startswith("in.("):
                expected = {
                    value.strip('"').replace('\\"', '"').replace("\\\\", "\\")
                    for value in expression[4:-1].split(",")
                }
                rows = [row for row in rows if str(row.get(key)) in expected]
            elif expression.startswith("neq."):
                expected = expression[4:]
                rows = [
                    row
                    for row in rows
                    if str(row.get(key)).lower() != expected.lower()
                ]
        return rows

    def select_all(
        self,
        table: str,
        params: dict[str, str] | None = None,
        page_size: int = 500,
    ) -> list[dict[str, Any]]:
        return self.select(table, params)

    def insert(self, table: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
        stored = dict(payload)
        self.inserts.append((table, stored))
        self.tables.setdefault(table, []).append(stored)
        return [stored]

    def patch(
        self, table: str, filters: dict[str, str], payload: dict[str, Any]
    ) -> list[dict[str, Any]]:
        self.patches.append((table, dict(filters), dict(payload)))
        rows = self.select(table, filters)
        for row in self.tables.get(table, []):
            if row in rows:
                row.update(payload)
        return rows

    def identity_profile(self, auth_subject: str) -> dict[str, Any] | None:
        rows = self.select(
            "identity_profiles", {"auth_subject": f"eq.{auth_subject}"}
        )
        return rows[0] if rows else None

    def direct_report_ids(self, manager_wid: str) -> set[str]:
        return {
            str(row["Employee_ID"])
            for row in self.select("Workers", {"Manager_WID": f"eq.{manager_wid}"})
            if row.get("Employee_ID")
        }

    def rpc(self, function: str, payload: dict[str, Any]) -> Any:
        self.rpc_calls.append((function, dict(payload)))
        if function == "record_manager_action_event":
            return {
                "case_id": payload["target_case_id"],
                "current_state": payload["new_event_type"],
                "source_event_id": payload["new_source_event_id"],
            }
        return "recorded"


def test_run_request_requires_exactly_one_matching_scope_target() -> None:
    employee = RunRequest(scope="employee", employee_id="EMP-1")
    cohort = RunRequest(scope="cohort", cohort="2026-08")

    assert employee.employee_id == "EMP-1"
    assert cohort.cohort == "2026-08"
    with pytest.raises(ValidationError):
        RunRequest(scope="employee", employee_id="EMP-1", cohort="2026-08")
    with pytest.raises(ValidationError):
        RunRequest(scope="cohort")
    with pytest.raises(ValidationError):
        RunRequest(scope="employee", employee_id="EMP-1", unexpected=True)


def test_policy_validator_accepts_registered_reason_codes() -> None:
    snapshot = round2_policy()

    assert PolicyEvaluator().validate(snapshot) == []


@pytest.mark.parametrize("snapshot", [{}, [], None])
def test_policy_validator_requires_non_empty_object(snapshot: Any) -> None:
    assert PolicyEvaluator().validate(snapshot) == [
        "Policy snapshot must be a non-empty object"
    ]


def test_policy_validator_reports_unknown_codes_in_stable_order() -> None:
    snapshot = round2_policy()
    snapshot["reason_codes"].extend(["UNKNOWN_Z", "UNKNOWN_A"])
    errors = PolicyEvaluator().validate(snapshot)

    assert errors == ["Unknown reason codes: UNKNOWN_A, UNKNOWN_Z"]


def test_policy_validator_rejects_confidential_manager_routing() -> None:
    snapshot = round2_policy()
    snapshot["routing"]["confidential_disclosure"] = "manager"
    errors = PolicyEvaluator().validate(snapshot)

    assert errors == ["Confidential routing cannot target a manager"]


def test_policy_validator_requires_every_round2_threshold() -> None:
    snapshot = round2_policy()
    del snapshot["thresholds"]["first_payroll_cutoff_days"]

    assert PolicyEvaluator().validate(snapshot) == [
        "Missing required thresholds: first_payroll_cutoff_days"
    ]


def test_policy_validator_rejects_non_string_reason_codes_without_crashing() -> None:
    snapshot = round2_policy()
    snapshot["reason_codes"] = [{"code": "WORK_AUTH_EXPIRED"}]

    errors = PolicyEvaluator().validate(snapshot)

    assert "reason_codes must contain only strings" in errors
    assert any(error.startswith("Missing registered reason codes:") for error in errors)


def test_policy_validator_requires_explicit_jurisdiction_default() -> None:
    snapshot = round2_policy()
    snapshot["thresholds"]["compliance_at_risk_days"] = {"SG": 10}

    assert PolicyEvaluator().validate(snapshot) == [
        "Threshold compliance_at_risk_days jurisdiction mapping requires a default"
    ]


def test_policy_validator_rejects_unsafe_retry_profiles() -> None:
    snapshot = round2_policy()
    snapshot["retry"] = {"max_attempts": 0, "backoff_seconds": [5, -1]}

    assert PolicyEvaluator().validate(snapshot) == [
        "retry.max_attempts must be a positive integer",
        "retry.backoff_seconds must contain non-negative numbers",
    ]


def test_confidential_approval_is_required_only_when_restricted_route_changes() -> None:
    repo = FakeRepository(
        {
            "policy_versions": [
                {
                    "version_id": "active-1",
                    "status": "active",
                    "config_snapshot": {
                        "routing": {
                            "confidential_channel": "restricted-a",
                            "it_channel": "it-a",
                        }
                    },
                }
            ]
        }
    )
    service = HROpsService(repo)  # type: ignore[arg-type]

    assert service.changes_confidential_routing(
        {
            "routing": {
                "confidential_channel": "restricted-a",
                "it_channel": "it-b",
            }
        }
    ) is False
    assert service.changes_confidential_routing(
        {
            "routing": {
                "confidential_channel": "restricted-b",
                "it_channel": "it-a",
            }
        }
    ) is True


@pytest.mark.parametrize(
    ("expiry", "expected"),
    [
        (
            "2026-07-31",
            {
                "reason_code": "WORK_AUTH_EXPIRED",
                "severity": "critical",
                "domain": "compliance",
            },
        ),
        (
            "2026-08-02",
            {
                "reason_code": "WORK_AUTH_EXPIRY_AT_RISK",
                "severity": "high",
                "domain": "compliance",
            },
        ),
        (
            "2026-09-01",
            {
                "reason_code": "WORK_AUTH_EXPIRY_AT_RISK",
                "severity": "high",
                "domain": "compliance",
            },
        ),
        (
            "not-a-date",
            {
                "reason_code": "COMPLIANCE_DEADLINE_AT_RISK",
                "severity": "medium",
                "domain": "data_quality",
            },
        ),
    ],
)
def test_work_authorization_boundary_findings(
    expiry: str, expected: dict[str, str]
) -> None:
    assert PolicyEvaluator().evaluate_worker(
        {"work_auth_expiry": expiry}, date(2026, 8, 2)
    ) == [expected]


@pytest.mark.parametrize("expiry", [None, "", "2026-09-02"])
def test_work_authorization_returns_no_finding_when_not_at_risk(expiry: Any) -> None:
    assert PolicyEvaluator().evaluate_worker(
        {"work_auth_expiry": expiry}, date(2026, 8, 2)
    ) == []


def test_candidate_threshold_changes_deterministic_work_authorization_result() -> None:
    evaluator = PolicyEvaluator()
    worker = {"work_auth_expiry": "2026-08-22"}

    assert evaluator.evaluate_worker(
        worker,
        date(2026, 8, 2),
        {"thresholds": {"work_auth_expiry_at_risk_days": 10}},
    ) == []
    assert evaluator.evaluate_worker(
        worker,
        date(2026, 8, 2),
        {"thresholds": {"work_auth_expiry_at_risk_days": 30}},
    )[0]["reason_code"] == "WORK_AUTH_EXPIRY_AT_RISK"


def test_jurisdiction_threshold_mapping_is_applied_with_explicit_default() -> None:
    evaluator = PolicyEvaluator()
    snapshot = {
        "thresholds": {
            "work_auth_expiry_at_risk_days": {"ID": 10, "default": 30}
        }
    }

    assert evaluator.evaluate_worker(
        {"work_auth_expiry": "2026-08-22", "jurisdiction": "ID"},
        date(2026, 8, 2),
        snapshot,
    ) == []
    assert evaluator.evaluate_worker(
        {"work_auth_expiry": "2026-08-22", "jurisdiction": "SG"},
        date(2026, 8, 2),
        snapshot,
    )[0]["reason_code"] == "WORK_AUTH_EXPIRY_AT_RISK"


def test_payroll_uses_status_and_cutoff_without_inferring_salary() -> None:
    evaluator = PolicyEvaluator()
    worker = {"Hire_Date": "2026-07-01"}
    snapshot = {"thresholds": {"first_payroll_cutoff_days": 20}}

    assert evaluator.evaluate_payroll(None, worker, date(2026, 8, 2), snapshot)[0][
        "reason_code"
    ] == "PAYROLL_RECORD_MISSING"
    assert evaluator.evaluate_payroll(
        {"status": "Error", "gross": None, "net": None},
        worker,
        date(2026, 8, 2),
        snapshot,
    )[0]["reason_code"] == "PAYROLL_ERROR_DETECTED"


def test_operational_domain_evaluators_are_deterministic() -> None:
    evaluator = PolicyEvaluator()

    assert evaluator.evaluate_compliance_item(
        {"due_date": "2026-08-01", "status": "pending"}, date(2026, 8, 2)
    )[0]["reason_code"] == "COMPLIANCE_LEGAL_BREACH"
    assert evaluator.evaluate_dependency(
        {"blocks_day_one": True, "status": "blocked"}
    )[0]["reason_code"] == "DAY_ONE_DEPENDENCY_BLOCKED"
    assert evaluator.evaluate_learning(
        {"due_day": "Day 30", "status": "pending"},
        {"Hire_Date": "2026-07-01"},
        date(2026, 8, 2),
    )[0]["reason_code"] == "LEARNING_MILESTONE_OVERDUE"


def test_snapshot_hash_is_order_independent_but_content_sensitive() -> None:
    first = {"routing": {"payroll": "people_ops"}, "threshold": 30}
    reordered = {"threshold": 30, "routing": {"payroll": "people_ops"}}
    changed = {"threshold": 31, "routing": {"payroll": "people_ops"}}

    assert snapshot_hash(first) == snapshot_hash(reordered)
    assert snapshot_hash(first) != snapshot_hash(changed)


def test_sanitize_removes_confidential_keys_recursively_and_case_insensitively() -> None:
    payload = {
        "Comment": "private",
        "safe": {
            "case_id": "case-1",
            "ERROR_REASON": "private payroll detail",
            "nested": [{"secure_payload": {"secret": True}, "status": "open"}],
        },
        "scalar": "preserved",
    }

    assert sanitize(payload) == {
        "safe": {"case_id": "case-1", "nested": [{"status": "open"}]},
        "scalar": "preserved",
    }


def test_case_and_event_contracts_use_positive_allowlists() -> None:
    cases = sanitize_case_rows(
        [
            {
                "case_id": "case-1",
                "sanitized_context": {
                    "reason_code": "DAY_ONE_DEPENDENCY_BLOCKED",
                    "severity": "high",
                    "innocent_name": "private narrative",
                },
            }
        ]
    )
    events = sanitize_event_rows(
        [
            {
                "event_id": "event-1",
                "reason_codes": ["DAY_ONE_DEPENDENCY_BLOCKED", "UNKNOWN"],
                "details": {
                    "source": "auto_run_status",
                    "innocent_name": "private narrative",
                },
            }
        ]
    )

    assert cases[0]["sanitized_context"] == {
        "reason_code": "DAY_ONE_DEPENDENCY_BLOCKED",
        "severity": "high",
    }
    assert events[0]["reason_codes"] == ["DAY_ONE_DEPENDENCY_BLOCKED"]
    assert events[0]["details"] == {"source": "auto_run_status"}


def test_user_roles_merges_realm_and_configured_client_roles(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KEYCLOAK_CLIENT_ID", "command-center")
    user = {
        "realm_access": {"roles": ["manager"]},
        "resource_access": {
            "command-center": {"roles": ["people_ops"]},
            "another-client": {"roles": ["ignored"]},
        },
    }

    assert user_roles(user) == {"manager", "people_ops"}
    assert user_roles(None) == set()


def test_require_hr_role_allows_matching_role_and_rejects_missing_role() -> None:
    user = {"realm_access": {"roles": ["people_ops"]}}

    assert require_hr_role(user, "admin", "people_ops") == {"people_ops"}
    with pytest.raises(HTTPException) as exc_info:
        require_hr_role(user, "admin")
    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "HR role is required"


def test_manager_relationship_accepts_direct_report() -> None:
    repo = FakeRepository(
        {
            "identity_profiles": [
                {"auth_subject": "manager-user", "manager_wid": "MGR-1"}
            ],
            "Workers": [
                {"Employee_ID": "EMP-1", "Manager_WID": "MGR-1"},
                {"Employee_ID": "EMP-2", "Manager_WID": "MGR-2"},
            ],
        }
    )
    service = HROpsService(repo)  # type: ignore[arg-type]
    user = {"sub": "manager-user", "realm_access": {"roles": ["manager"]}}

    assert_manager_owns_employee(service, user, "EMP-1")


def test_manager_relationship_rejects_non_report() -> None:
    repo = FakeRepository(
        {
            "identity_profiles": [
                {"auth_subject": "manager-user", "manager_wid": "MGR-1"}
            ],
            "Workers": [{"Employee_ID": "EMP-2", "Manager_WID": "MGR-2"}],
        }
    )
    service = HROpsService(repo)  # type: ignore[arg-type]
    user = {"sub": "manager-user", "realm_access": {"roles": ["manager"]}}

    with pytest.raises(HTTPException) as exc_info:
        assert_manager_owns_employee(service, user, "EMP-2")
    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Employee is not a direct report"


def test_manager_relationship_requires_identity_mapping() -> None:
    service = HROpsService(FakeRepository())  # type: ignore[arg-type]
    user = {"sub": "unmapped-manager", "realm_access": {"roles": ["manager"]}}

    with pytest.raises(HTTPException) as exc_info:
        assert_manager_owns_employee(service, user, "EMP-1")
    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Manager identity mapping is not configured"


def test_privileged_hr_role_is_not_restricted_by_manager_relationship() -> None:
    service = HROpsService(FakeRepository())  # type: ignore[arg-type]
    user = {
        "sub": "ops-manager",
        "realm_access": {"roles": ["manager", "people_ops"]},
    }

    assert_manager_owns_employee(service, user, "EMP-outside-team")


def test_confidential_role_does_not_upgrade_manager_standard_access() -> None:
    repo = FakeRepository(
        {
            "identity_profiles": [
                {"auth_subject": "mixed-user", "manager_wid": "MGR-1"}
            ],
            "Workers": [{"Employee_ID": "EMP-2", "Manager_WID": "MGR-2"}],
        }
    )
    service = HROpsService(repo)  # type: ignore[arg-type]
    user = {
        "sub": "mixed-user",
        "realm_access": {"roles": ["manager", "people_ops_confidential"]},
    }

    with pytest.raises(HTTPException):
        assert_manager_owns_employee(service, user, "EMP-2")


def test_manager_run_access_requires_own_run_and_current_direct_report() -> None:
    repo = FakeRepository(
        {
            "identity_profiles": [
                {"auth_subject": "manager-1", "manager_wid": "MGR-1"}
            ],
            "Workers": [
                {"Employee_ID": "EMP-1", "Manager_WID": "MGR-1"},
                {"Employee_ID": "EMP-2", "Manager_WID": "MGR-2"},
            ],
        }
    )
    service = HROpsService(repo)  # type: ignore[arg-type]
    user = {"sub": "manager-1", "realm_access": {"roles": ["manager"]}}

    service.assert_run_access(
        user, {"created_by": "manager-1", "employee_id": "EMP-1"}
    )
    with pytest.raises(HTTPException):
        service.assert_run_access(
            user, {"created_by": "another-user", "employee_id": "EMP-1"}
        )
    with pytest.raises(HTTPException):
        service.assert_run_access(
            user, {"created_by": "manager-1", "employee_id": "EMP-2"}
        )


def test_manager_dashboard_is_scoped_before_aggregation() -> None:
    repo = FakeRepository(
        {
            "Workers": [
                {"Employee_ID": "EMP-1", "cohort": "C-1"},
                {"Employee_ID": "EMP-2", "cohort": "C-2"},
            ],
            "workbench_cases": [
                {
                    "case_id": "CASE-1",
                    "employee_id": "EMP-1",
                    "status": "open",
                    "priority": "high",
                },
                {
                    "case_id": "CASE-2",
                    "employee_id": "EMP-2",
                    "status": "open",
                    "priority": "critical",
                },
            ],
            "integration_health": [],
        }
    )

    result = HROpsService(repo).dashboard({"EMP-1"})  # type: ignore[arg-type]

    assert result["workers"] == 1
    assert result["open_cases"] == 1
    assert result["critical_cases"] == 0


def test_dashboard_counts_only_open_critical_cases_and_distinct_cohorts() -> None:
    repo = FakeRepository(
        {
            "Workers": [
                {"Employee_ID": "EMP-1", "cohort": "2026-07"},
                {"Employee_ID": "EMP-2", "cohort": "2026-07"},
                {"Employee_ID": "EMP-3", "cohort": "2026-08"},
                {"Employee_ID": "EMP-4", "cohort": None},
            ],
            "workbench_cases": [
                {"case_id": "C-1", "status": "open", "priority": "critical"},
                {"case_id": "C-2", "status": "in_review", "priority": "medium"},
                {"case_id": "C-3", "status": "resolved", "priority": "critical"},
            ],
            "integration_health": [
                {
                    "integration_key": "auto",
                    "status": "degraded",
                    "detail": {"error_reason": "private transport detail"},
                }
            ],
        }
    )

    result = HROpsService(repo).dashboard()  # type: ignore[arg-type]

    assert result["workers"] == 4
    assert result["open_cases"] == 2
    assert result["critical_cases"] == 1
    assert result["cohorts"] == 2
    assert result["integrations"] == [
        {"integration_key": "auto", "status": "degraded", "detail": {}}
    ]
    assert result["refreshed_at"].endswith("+00:00")


def test_operational_twin_applies_count_percent_and_privacy_thresholds() -> None:
    repo = FakeRepository(
        {
            "Workers": [
                {"Employee_ID": "EMP-1", "cohort": "C-1"},
                {"Employee_ID": "EMP-2", "cohort": "C-1"},
                {"Employee_ID": "EMP-3", "cohort": "C-1"},
                {"Employee_ID": "EMP-4", "cohort": "C-1"},
            ],
            "policy_versions": [
                {
                    "version_id": "policy-1",
                    "status": "active",
                    "config_snapshot": {
                        "thresholds": {
                            "minimum_cohort_size": 3,
                            "bottleneck_min_workers": 2,
                            "bottleneck_min_percent": 40,
                        }
                    },
                }
            ],
            "Cross_Team_Dependencies": [
                {
                    "employee_id": "EMP-1",
                    "team": "IT",
                    "status": "blocked",
                    "blocks_day_one": True,
                },
                {
                    "employee_id": "EMP-2",
                    "team": "IT",
                    "status": "blocked",
                    "blocks_day_one": True,
                },
                {
                    "employee_id": "EMP-3",
                    "team": "Facilities",
                    "status": "blocked",
                    "blocks_day_one": True,
                },
            ],
        }
    )

    result = HROpsService(repo).operational_twin(cohort="C-1")  # type: ignore[arg-type]

    assert result["suppressed"] is False
    assert result["denominator"] == 4
    assert result["bottlenecks"] == [
        {
            "dependency_team": "IT",
            "reason_code": "COHORT_DEPENDENCY_BOTTLENECK",
            "affected_workers": 2,
            "affected_percent": 50.0,
            "recommended_action": "Prioritize the shared Day-1 dependency",
        }
    ]

    suppressed = HROpsService(repo).operational_twin(  # type: ignore[arg-type]
        cohort="C-1", employee_ids={"EMP-1", "EMP-2"}
    )
    assert suppressed["suppressed"] is True
    assert suppressed["bottlenecks"] == []


def test_create_run_persists_server_generated_queued_command() -> None:
    repo = FakeRepository()
    service = HROpsService(repo)  # type: ignore[arg-type]

    result = service.create_run(
        "person-b",
        {
            "scope": "employee",
            "employee_id": "EMP-1",
            "reason_code": "MISSING_DAY_ONE_ACCESS",
        },
        "request-0001",
    )

    assert result["command_id"].startswith("cmd_")
    assert result["status"] == "queued"
    assert result["created_at"].tzinfo is not None
    assert repo.inserts == [
        (
            "command_runs",
            {
                "command_id": result["command_id"],
                "created_by": "person-b",
                "status": "queued",
                "scope": "employee",
                "employee_id": "EMP-1",
                "cohort": None,
                "requested_reason": "MISSING_DAY_ONE_ACCESS",
                "workflow_key": "hr_orchestrator",
                "trigger_source": "command_center",
                "reconciliation_status": "pending",
                "request_key_hash": repo.inserts[0][1]["request_key_hash"],
                "request_fingerprint": repo.inserts[0][1]["request_fingerprint"],
            },
        )
    ]


def test_create_run_is_idempotent_and_rejects_key_reuse_for_other_payload() -> None:
    repo = FakeRepository()
    service = HROpsService(repo)  # type: ignore[arg-type]
    payload = {"scope": "employee", "employee_id": "EMP-1", "reason_code": None}

    first = service.create_run("person-b", payload, "request-0002")
    second = service.create_run("person-b", payload, "request-0002")

    assert first["command_id"] == second["command_id"]
    assert len(repo.inserts) == 1
    with pytest.raises(HTTPException) as exc_info:
        service.create_run(
            "person-b",
            {"scope": "employee", "employee_id": "EMP-2", "reason_code": None},
            "request-0002",
        )
    assert exc_info.value.status_code == 409


@pytest.mark.parametrize("event_type", ["ping", "thinking"])
def test_auto_event_normalizer_drops_non_operational_events(event_type: str) -> None:
    assert AutoWorkflowClient._safe_event(event_type, {"content": "private"}) is None


@pytest.mark.parametrize(
    ("raw_status", "expected_status"),
    [
        ("scheduled", "queued"),
        ("waiting", "running"),
        ("completed", "completed"),
        ("succeeded", "completed"),
        ("success", "completed"),
        ("canceled", "cancelled"),
        ("error", "failed"),
        ("unexpected", "running"),
    ],
)
def test_auto_run_event_normalizes_status_and_discards_outputs(
    raw_status: str, expected_status: str
) -> None:
    event = AutoWorkflowClient._safe_event(
        "activity-run",
        {
            "content": {
                "workflowRunId": "auto-run-1",
                "status": raw_status,
                "outputs": {"comment": "must not cross boundary"},
            }
        },
    )

    assert event == ("activity-run", expected_status, {}, "auto-run-1")


@pytest.mark.parametrize(
    ("success", "expected_status"), [(True, "completed"), (False, "failed")]
)
def test_auto_result_event_exposes_only_status_and_run_id(
    success: bool, expected_status: str
) -> None:
    event = AutoWorkflowClient._safe_event(
        "result",
        {
            "success": success,
            "workflowRun": {"id": "auto-run-2"},
            "output": {"raw_comment": "private"},
        },
    )

    assert event == ("result", expected_status, {}, "auto-run-2")


def test_auto_error_and_unknown_event_have_generic_details_only() -> None:
    assert AutoWorkflowClient._safe_event(
        "error", {"message": "secret upstream reason"}
    ) == ("error", "failed", {"error_type": "auto_execution_error"}, None)
    assert AutoWorkflowClient._safe_event(
        "new-platform-event", {"comment": "secret"}
    ) == (
        "system_exception",
        "running",
        {"error_type": "unknown_auto_event"},
        None,
    )


def test_sse_parser_supports_multiline_frames_and_final_frame() -> None:
    frames = list(
        AutoWorkflowClient._parse_sse(
            [
                "event: activity-run",
                'data: {"content":',
                'data: {"status":"running"}}',
                "",
                "event: result",
                'data: {"success":true}',
            ]
        )
    )

    assert frames == [
        ("activity-run", '{"content":\n{"status":"running"}}'),
        ("result", '{"success":true}'),
    ]


def test_source_event_id_is_stable_and_excludes_private_payload() -> None:
    first = AutoWorkflowClient._source_event_id(
        "cmd-1",
        "activity-run",
        {
            "content": {
                "activityRunId": "activity-1",
                "status": "running",
                "outputs": {"comment": "private-a"},
            }
        },
        "running",
    )
    second = AutoWorkflowClient._source_event_id(
        "cmd-1",
        "activity-run",
        {
            "content": {
                "activityRunId": "activity-1",
                "status": "running",
                "outputs": {"comment": "private-b"},
            }
        },
        "running",
    )

    assert first == second


def _gated_case_repository() -> FakeRepository:
    return FakeRepository(
        {
            "identity_profiles": [
                {"auth_subject": "manager-1", "manager_wid": "MGR-1"}
            ],
            "Workers": [
                {"Employee_ID": "EMP-1", "Manager_WID": "MGR-1", "cohort": "C-1"}
            ],
            "workbench_cases": [
                {
                    "case_id": "CASE-STANDARD",
                    "employee_id": "EMP-1",
                    "case_type": "day_one_readiness",
                    "priority": "high",
                    "status": "open",
                    "sanitized_context": {"reason_code": "DAY_ONE_DEPENDENCY_BLOCKED"},
                },
                {
                    "case_id": "CASE-PAYROLL",
                    "employee_id": "EMP-1",
                    "case_type": "payroll",
                    "priority": "critical",
                    "status": "open",
                    "sanitized_context": {
                        "reason_code": "PAYROLL_ERROR_DETECTED",
                        "error_reason": "PAYROLL_SECRET_XYZ",
                        "gross": 999999,
                        "net": 888888,
                    },
                },
            ],
            "integration_health": [],
            "policy_versions": [],
        }
    )


def test_payroll_capability_is_dedicated_and_manager_role_takes_precedence() -> None:
    assert can_access_payroll_cases({"admin"}) is True
    assert can_access_payroll_cases({"people_ops_payroll"}) is True
    assert can_access_payroll_cases({"people_ops"}) is False
    assert can_access_payroll_cases({"people_ops", "people_ops_payroll"}) is False
    assert can_access_payroll_cases({"manager", "people_ops_payroll"}) is False
    assert case_domain_scope({"people_ops_payroll"}) == "payroll_only"
    assert case_domain_scope({"manager", "people_ops_payroll"}) == "exclude_payroll"


def test_manager_list_detail_action_dashboard_and_insights_exclude_payroll() -> None:
    repo = _gated_case_repository()
    hr = HROpsService(repo)  # type: ignore[arg-type]
    manager = {
        "sub": "manager-1",
        "realm_access": {"roles": ["manager", "people_ops_payroll"]},
    }

    listed = list_cases(confidential=False, user=manager, hr=hr)
    assert [row["case_id"] for row in listed["cases"]] == ["CASE-STANDARD"]
    with pytest.raises(HTTPException) as detail_error:
        get_case("CASE-PAYROLL", user=manager, hr=hr)
    assert detail_error.value.status_code == 404
    with pytest.raises(HTTPException) as action_error:
        act_on_case(
            "CASE-PAYROLL",
            CaseActionRequest(decision="claim"),
            user=manager,
            hr=hr,
        )
    assert action_error.value.status_code == 404
    assert repo.rpc_calls == []

    dashboard_result = dashboard_endpoint(user=manager, hr=hr)
    insight_result = insights_endpoint(user=manager, hr=hr)
    assert dashboard_result["open_cases"] == 1
    assert dashboard_result["critical_cases"] == 0
    assert insight_result["open_case_count"] == 1
    assert "payroll" not in insight_result["open_cases_by_type"]
    assert "PAYROLL_SECRET_XYZ" not in str(listed)


def test_dedicated_payroll_reviewer_gets_only_safe_payroll_metadata() -> None:
    repo = _gated_case_repository()
    hr = HROpsService(repo)  # type: ignore[arg-type]
    reviewer = {
        "sub": "payroll-1",
        "realm_access": {"roles": ["people_ops_payroll"]},
    }

    listed = list_cases(confidential=False, user=reviewer, hr=hr)
    assert [row["case_id"] for row in listed["cases"]] == ["CASE-PAYROLL"]
    assert listed["cases"][0]["sanitized_context"] == {
        "reason_code": "PAYROLL_ERROR_DETECTED"
    }
    assert "PAYROLL_SECRET_XYZ" not in str(listed)
    assert "999999" not in str(listed)
    assert "888888" not in str(listed)

    dashboard_result = dashboard_endpoint(user=reviewer, hr=hr)
    insight_result = insights_endpoint(user=reviewer, hr=hr)
    assert dashboard_result["open_cases"] == 1
    assert dashboard_result["critical_cases"] == 1
    assert insight_result["open_cases_by_type"] == {"payroll": 1}


def test_manager_action_event_contract_requires_chronological_creation_deadlines() -> None:
    occurred_at = datetime(2026, 8, 3, 9, tzinfo=UTC)
    valid = ManagerActionEventRequest(
        source_event_id="slack-delivery-1",
        event_type="nudge_created",
        occurred_at=occurred_at,
        next_reminder_at=occurred_at + timedelta(days=1),
        acknowledgment_deadline=occurred_at + timedelta(days=2),
        action_deadline=occurred_at + timedelta(days=5),
    )
    assert valid.event_type == "nudge_created"

    with pytest.raises(ValidationError):
        ManagerActionEventRequest(
            source_event_id="slack-delivery-2",
            event_type="nudge_created",
            occurred_at=occurred_at,
            next_reminder_at=occurred_at + timedelta(days=3),
            acknowledgment_deadline=occurred_at + timedelta(days=2),
            action_deadline=occurred_at + timedelta(days=5),
        )


def test_manager_can_only_submit_acknowledgment_for_owned_action_state() -> None:
    repo = _gated_case_repository()
    repo.tables["manager_action_states"] = [
        {
            "case_id": "CASE-STANDARD",
            "employee_id": "EMP-1",
            "current_state": "delivered",
            "source_event_id": "delivery-1",
        }
    ]
    hr = HROpsService(repo)  # type: ignore[arg-type]
    manager = {"sub": "manager-1", "realm_access": {"roles": ["manager"]}}
    occurred_at = datetime(2026, 8, 3, 9, tzinfo=UTC)

    result = record_manager_action_event(
        "CASE-STANDARD",
        ManagerActionEventRequest(
            source_event_id="ack-1",
            event_type="acknowledged",
            occurred_at=occurred_at,
        ),
        user=manager,
        hr=hr,
    )
    assert result["source_event_id"] == "ack-1"
    with pytest.raises(HTTPException) as forbidden:
        record_manager_action_event(
            "CASE-STANDARD",
            ManagerActionEventRequest(
                source_event_id="delivery-2",
                event_type="delivery_succeeded",
                occurred_at=occurred_at,
            ),
            user=manager,
            hr=hr,
        )
    assert forbidden.value.status_code == 403


def test_policy_detail_returns_complete_snapshot_for_authorized_clone() -> None:
    snapshot = {
        "reason_codes": sorted(KNOWN_REASON_CODES),
        "thresholds": {"manager_max_reminders": {"default": 2}},
        "notification_templates": {"manager_nudge": "Template {{case_id}}"},
    }
    repo = FakeRepository(
        {
            "policy_versions": [
                {
                    "version_id": "policy-active",
                    "status": "active",
                    "config_snapshot": snapshot,
                }
            ]
        }
    )
    result = get_policy(
        "policy-active",
        user={"sub": "ops-1", "realm_access": {"roles": ["people_ops"]}},
        hr=HROpsService(repo),  # type: ignore[arg-type]
    )
    assert result["config_snapshot"] == snapshot
