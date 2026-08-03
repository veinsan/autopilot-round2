"""Sanitized Supabase data access and deterministic HR policy evaluation."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
from fastapi import HTTPException, status


CONFIDENTIAL_KEY_MARKERS = (
    "comment",
    "error_reason",
    "raw_",
    "secure_payload",
    "thinking",
    "authorization",
    "api_key",
    "token",
    "outputs",
)
KNOWN_REASON_CODES = {
    "MISSING_DAY_ONE_ACCESS", "STALLED_COMPLIANCE_DOC", "TASK_ALREADY_ESCALATED",
    "PROVISIONING_DELAYED", "LOW_ENGAGEMENT_SCORE", "SENSITIVE_DISCLOSURE_DETECTED",
    "COMPLIANCE_DEADLINE_AT_RISK", "COMPLIANCE_LEGAL_BREACH", "WORK_AUTH_EXPIRY_AT_RISK",
    "WORK_AUTH_EXPIRED", "PAYROLL_ERROR_DETECTED", "PAYROLL_NOT_CONFIRMED",
    "PAYROLL_RECORD_MISSING", "DAY_ONE_DEPENDENCY_BLOCKED", "LEARNING_MILESTONE_OVERDUE",
    "MANAGER_ACKNOWLEDGMENT_OVERDUE", "MANAGER_ACTION_OVERDUE", "COHORT_DEPENDENCY_BOTTLENECK",
}
REQUIRED_POLICY_THRESHOLD_KEYS = {
    "work_auth_expiry_at_risk_days",
    "compliance_at_risk_days",
    "first_payroll_cutoff_days",
    "nudge_cadence_days",
    "manager_acknowledgment_deadline_days",
    "manager_action_deadline_days",
    "manager_max_reminders",
    "bottleneck_min_workers",
    "bottleneck_min_percent",
    "minimum_cohort_size",
}
JURISDICTION_THRESHOLD_KEYS = {
    "work_auth_expiry_at_risk_days",
    "compliance_at_risk_days",
    "first_payroll_cutoff_days",
    "nudge_cadence_days",
    "manager_acknowledgment_deadline_days",
    "manager_action_deadline_days",
    "manager_max_reminders",
}


def user_roles(user: dict | None) -> set[str]:
    if not user:
        return set()
    realm = user.get("realm_access", {}).get("roles", [])
    client_id = os.getenv("KEYCLOAK_CLIENT_ID", "")
    client = user.get("resource_access", {}).get(client_id, {}).get("roles", [])
    return set(realm + client)


def require_hr_role(user: dict | None, *allowed: str) -> set[str]:
    roles = user_roles(user)
    if not roles.intersection(allowed):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="HR role is required")
    return roles


def sanitize(value: Any) -> Any:
    """Remove fields that may contain confidential narrative or payroll details."""
    if isinstance(value, dict):
        return {
            key: sanitize(item)
            for key, item in value.items()
            if not any(marker in key.lower() for marker in CONFIDENTIAL_KEY_MARKERS)
        }
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    return value


CASE_CONTEXT_FIELDS = {
    "reason_code",
    "domain",
    "severity",
    "policy_version_id",
    "evaluated_at",
    "owner",
    "recommended_action",
}
EVENT_DETAIL_FIELDS = {"error_type", "source"}
SAFE_OPERATOR_IDS = {"orchestrator", *(f"OP-{number:02d}" for number in range(1, 8))}
SAFE_EVENT_TYPES = {
    "workflow-run",
    "activity-run",
    "result",
    "error",
    "system_exception",
    "reconciliation",
    "cancellation",
    "finding",
    "case_created",
    "case_updated",
}
SAFE_CASE_TYPES = {
    "onboarding",
    "provisioning",
    "compliance",
    "work_authorization",
    "payroll",
    "day_one_readiness",
    "learning",
    "manager_accountability",
    "engagement",
    "data_quality",
    "system_exception",
}
CASE_ACTION_LABELS = {
    "compliance": "Review the compliance deadline and owner",
    "work_authorization": "Review the restricted compliance record",
    "payroll": "Route to the restricted payroll reviewer",
    "provisioning": "Confirm the external dependency owner",
    "day_one_readiness": "Prioritize the blocking Day-1 dependency",
    "learning": "Review the learning milestone with the owner",
    "manager_accountability": "Review the governed acknowledgment state",
    "engagement": "Review the sanitized operational signal",
    "data_quality": "Correct the source-system record",
    "onboarding": "Review the outstanding onboarding milestone",
    "system_exception": "Review the operational exception",
}
PAYROLL_CASE_TYPE = "payroll"
MANAGER_ACTION_STATE_FIELDS = (
    "case_id,employee_id,current_state,nudge_created_at,delivered_at,"
    "acknowledged_at,action_verified_at,escalated_at,"
    "successful_reminder_count,next_reminder_at,acknowledgment_deadline,"
    "action_deadline,source_event_id,updated_at"
)


def can_access_payroll_cases(roles: set[str]) -> bool:
    """Payroll access is isolated from manager and general People Ops roles."""
    return "admin" in roles or (
        "people_ops_payroll" in roles
        and not roles.intersection({"manager", "people_ops"})
    )


def case_domain_scope(roles: set[str]) -> str:
    """Return the server-enforced standard-case domain scope for a role set."""
    if "admin" in roles:
        return "all"
    if "people_ops_payroll" in roles and not roles.intersection(
        {"manager", "people_ops"}
    ):
        return "payroll_only"
    return "exclude_payroll"


def sanitize_case_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    safe_rows: list[dict[str, Any]] = []
    for row in rows:
        safe = {
            key: value
            for key, value in row.items()
            if key not in {"sanitized_context", "recommended_action"}
        }
        context = row.get("sanitized_context")
        safe["sanitized_context"] = (
            {
                key: value
                for key, value in context.items()
                if key in CASE_CONTEXT_FIELDS
                and isinstance(value, (str, int, float, bool, type(None)))
            }
            if isinstance(context, dict)
            else {}
        )
        raw_case_type = str(row.get("case_type") or "").lower()
        case_type = (
            raw_case_type if raw_case_type in SAFE_CASE_TYPES else "system_exception"
        )
        safe["case_type"] = case_type
        safe["recommended_action"] = CASE_ACTION_LABELS[case_type]
        safe_rows.append(sanitize(safe))
    return safe_rows


def sanitize_event_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    safe_rows: list[dict[str, Any]] = []
    for row in rows:
        safe = {key: value for key, value in row.items() if key != "details"}
        details = row.get("details")
        safe["details"] = (
            {key: value for key, value in details.items() if key in EVENT_DETAIL_FIELDS}
            if isinstance(details, dict)
            else {}
        )
        codes = safe.get("reason_codes")
        safe["reason_codes"] = (
            [code for code in codes if code in KNOWN_REASON_CODES]
            if isinstance(codes, list)
            else []
        )
        if safe.get("operator_id") not in SAFE_OPERATOR_IDS:
            safe["operator_id"] = "orchestrator"
        if safe.get("event_type") not in SAFE_EVENT_TYPES:
            safe["event_type"] = "system_exception"
        safe_rows.append(sanitize(safe))
    return safe_rows


class SupabaseRepository:
    """Small PostgREST client kept server-side behind FastAPI."""

    def __init__(
        self,
        url: str | None = None,
        key: str | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        self.url = (url if url is not None else os.getenv("SUPABASE_URL", "")).rstrip("/")
        self.key = key if key is not None else os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
        self.client = client

    def _headers(self, prefer: str | None = None) -> dict[str, str]:
        if not self.url or not self.key:
            raise HTTPException(status_code=503, detail="HR data service is not configured")
        headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        return headers

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        target = f"{self.url}/rest/v1/{path}"
        try:
            if self.client:
                response = self.client.request(method, target, timeout=15, **kwargs)
            else:
                response = httpx.request(method, target, timeout=15, **kwargs)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail="HR data service is unavailable") from exc
        return response

    def select(self, table: str, params: dict[str, str] | None = None) -> list[dict[str, Any]]:
        response = self._request("GET", table, headers=self._headers(), params=params)
        if response.is_error:
            raise HTTPException(status_code=502, detail="Unable to read HR data")
        return response.json()

    def select_all(
        self,
        table: str,
        params: dict[str, str] | None = None,
        page_size: int = 500,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        offset = 0
        requested_limit = int(params["limit"]) if params and params.get("limit") else None
        while True:
            remaining = requested_limit - len(rows) if requested_limit is not None else None
            if remaining is not None and remaining <= 0:
                return rows
            current_page_size = min(page_size, remaining) if remaining is not None else page_size
            page_params = {
                **(params or {}),
                "limit": str(current_page_size),
                "offset": str(offset),
            }
            page = self.select(table, page_params)
            rows.extend(page)
            if len(page) < current_page_size:
                return rows
            offset += current_page_size

    def insert(self, table: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
        response = self._request(
            "POST",
            table,
            headers=self._headers("return=representation"),
            json=payload,
        )
        if response.is_error:
            raise HTTPException(status_code=502, detail="Unable to write HR data")
        return response.json()

    def patch(self, table: str, filters: dict[str, str], payload: dict[str, Any]) -> list[dict[str, Any]]:
        response = self._request(
            "PATCH",
            table,
            headers=self._headers("return=representation"),
            params=filters,
            json=payload,
        )
        if response.is_error:
            raise HTTPException(status_code=502, detail="Unable to update HR data")
        return response.json()

    def delete(self, table: str, filters: dict[str, str]) -> list[dict[str, Any]]:
        if not filters:
            raise ValueError("Delete requires an explicit filter")
        response = self._request(
            "DELETE",
            table,
            headers=self._headers("return=representation"),
            params=filters,
        )
        if response.is_error:
            raise HTTPException(status_code=502, detail="Unable to delete HR data")
        return response.json()

    def rpc(self, function: str, payload: dict[str, Any]) -> Any:
        response = self._request(
            "POST",
            f"rpc/{function}",
            headers=self._headers(),
            json=payload,
        )
        if response.is_error:
            if response.status_code == 400:
                raise HTTPException(
                    status_code=409, detail="HR state transition was rejected"
                )
            raise HTTPException(status_code=502, detail="Unable to apply HR policy change")
        return response.json() if response.content else None

    def upsert(
        self,
        table: str,
        payload: dict[str, Any],
        conflict_column: str,
    ) -> list[dict[str, Any]]:
        response = self._request(
            "POST",
            table,
            headers=self._headers("resolution=merge-duplicates,return=representation"),
            params={"on_conflict": conflict_column},
            json=payload,
        )
        if response.is_error:
            raise HTTPException(status_code=502, detail="Unable to persist HR data")
        return response.json()

    def identity_profile(self, auth_subject: str) -> dict[str, Any] | None:
        rows = self.select(
            "identity_profiles",
            {"auth_subject": f"eq.{auth_subject}", "select": "auth_subject,employee_id,manager_wid"},
        )
        return rows[0] if rows else None

    def direct_report_ids(self, manager_wid: str) -> set[str]:
        rows = self.select_all(
            "Workers",
            {"Manager_WID": f"eq.{manager_wid}", "select": "Employee_ID"},
        )
        return {row["Employee_ID"] for row in rows if row.get("Employee_ID")}


class PolicyEvaluator:
    """Deterministic, side-effect-free policy evaluation used by simulation and runtime."""

    def validate(self, snapshot: dict[str, Any]) -> list[str]:
        errors: list[str] = []
        if not isinstance(snapshot, dict) or not snapshot:
            return ["Policy snapshot must be a non-empty object"]
        reason_codes = snapshot.get("reason_codes", [])
        if not isinstance(reason_codes, list):
            errors.append("reason_codes must be a list")
            unknown: set[str] = set()
            missing_codes: set[str] = set()
        elif not all(isinstance(code, str) for code in reason_codes):
            errors.append("reason_codes must contain only strings")
            unknown = set()
            missing_codes = KNOWN_REASON_CODES
        else:
            unknown = set(reason_codes) - KNOWN_REASON_CODES
            missing_codes = KNOWN_REASON_CODES - set(reason_codes)
            if len(reason_codes) != len(set(reason_codes)):
                errors.append("reason_codes must not contain duplicates")
        if unknown:
            errors.append(f"Unknown reason codes: {', '.join(sorted(unknown))}")
        if missing_codes:
            errors.append(
                f"Missing registered reason codes: {', '.join(sorted(missing_codes))}"
            )
        routing = snapshot.get("routing", {})
        if isinstance(routing, dict) and any("manager" in str(value).lower() and "confidential" in str(key).lower() for key, value in routing.items()):
            errors.append("Confidential routing cannot target a manager")
        thresholds = snapshot.get("thresholds", {})
        if thresholds is not None and not isinstance(thresholds, dict):
            errors.append("thresholds must be an object")
        elif isinstance(thresholds, dict):
            missing_thresholds = REQUIRED_POLICY_THRESHOLD_KEYS - set(thresholds)
            if missing_thresholds:
                errors.append(
                    "Missing required thresholds: "
                    + ", ".join(sorted(missing_thresholds))
                )
            for key, value in thresholds.items():
                if key.endswith(("_days", "_score", "_threshold", "_workers", "_percent", "_size", "_reminders")):
                    if isinstance(value, bool) or not isinstance(value, (int, float, dict)):
                        errors.append(
                            f"Threshold {key} must be numeric or jurisdiction-mapped"
                        )
                    elif isinstance(value, dict) and any(
                        isinstance(mapped, bool)
                        or not isinstance(mapped, (int, float))
                        or mapped < 0
                        for mapped in value.values()
                    ):
                        errors.append(
                            f"Threshold {key} jurisdiction values must be non-negative numbers"
                        )
                    elif isinstance(value, (int, float)) and value < 0:
                        errors.append(f"Threshold {key} must be non-negative")
                if (
                    key in JURISDICTION_THRESHOLD_KEYS
                    and isinstance(value, dict)
                    and "default" not in value
                ):
                    errors.append(
                        f"Threshold {key} jurisdiction mapping requires a default"
                    )
        if not isinstance(snapshot.get("demo_mode"), bool):
            errors.append("demo_mode must be a boolean")
        for retry_key in ("retry", "retry_demo_profile"):
            retry = snapshot.get(retry_key)
            if not isinstance(retry, dict):
                errors.append(f"{retry_key} must be an object")
                continue
            attempts = retry.get("max_attempts")
            backoff = retry.get("backoff_seconds")
            if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts < 1:
                errors.append(f"{retry_key}.max_attempts must be a positive integer")
            if (
                not isinstance(backoff, list)
                or any(
                    isinstance(delay, bool)
                    or not isinstance(delay, (int, float))
                    or delay < 0
                    for delay in backoff
                )
            ):
                errors.append(
                    f"{retry_key}.backoff_seconds must contain non-negative numbers"
                )
        return errors

    @staticmethod
    def _date(value: Any) -> date | None:
        if isinstance(value, date):
            return value
        if not value:
            return None
        try:
            return date.fromisoformat(str(value)[:10])
        except ValueError:
            return None

    @staticmethod
    def _threshold(
        snapshot: dict[str, Any] | None,
        key: str,
        default: int,
        jurisdiction: str | None = None,
    ) -> int:
        value = (snapshot or {}).get("thresholds", {}).get(key, default)
        if isinstance(value, dict):
            value = value.get(jurisdiction) if jurisdiction else None
            if value is None:
                mapping = (snapshot or {}).get("thresholds", {}).get(key, {})
                value = mapping.get("default", mapping.get("*", default))
        return int(value) if isinstance(value, (int, float)) else default

    def evaluate_worker(
        self,
        worker: dict[str, Any],
        as_of: date,
        snapshot: dict[str, Any] | None = None,
    ) -> list[dict[str, str]]:
        findings: list[dict[str, str]] = []
        expiry = worker.get("work_auth_expiry")
        if expiry:
            expiry_date = self._date(expiry)
            if expiry_date:
                days = (expiry_date - as_of).days
                if days < 0:
                    findings.append({"reason_code": "WORK_AUTH_EXPIRED", "severity": "critical", "domain": "compliance"})
                elif days <= self._threshold(
                    snapshot,
                    "work_auth_expiry_at_risk_days",
                    30,
                    str(worker.get("jurisdiction") or ""),
                ):
                    findings.append({"reason_code": "WORK_AUTH_EXPIRY_AT_RISK", "severity": "high", "domain": "compliance"})
            else:
                findings.append({"reason_code": "COMPLIANCE_DEADLINE_AT_RISK", "severity": "medium", "domain": "data_quality"})
        return findings

    def evaluate_compliance_item(
        self,
        item: dict[str, Any],
        as_of: date,
        snapshot: dict[str, Any] | None = None,
    ) -> list[dict[str, str]]:
        if str(item.get("status", "")).lower() in {"completed", "complete", "verified"}:
            return []
        due_date = self._date(item.get("due_date"))
        if not due_date:
            return [{"reason_code": "COMPLIANCE_DEADLINE_AT_RISK", "severity": "medium", "domain": "data_quality"}]
        warning_days = self._threshold(
            snapshot,
            "compliance_at_risk_days",
            14,
            str(item.get("jurisdiction") or ""),
        )
        days = (due_date - as_of).days
        if days < 0:
            return [{"reason_code": "COMPLIANCE_LEGAL_BREACH", "severity": "critical", "domain": "compliance"}]
        if days <= warning_days:
            return [{"reason_code": "COMPLIANCE_DEADLINE_AT_RISK", "severity": "high", "domain": "compliance"}]
        return []

    def evaluate_payroll(
        self,
        record: dict[str, Any] | None,
        worker: dict[str, Any],
        as_of: date,
        snapshot: dict[str, Any] | None = None,
    ) -> list[dict[str, str]]:
        hire_date = self._date(worker.get("Hire_Date"))
        cutoff_days = self._threshold(
            snapshot,
            "first_payroll_cutoff_days",
            30,
            str(worker.get("jurisdiction") or ""),
        )
        past_cutoff = bool(hire_date and as_of > hire_date + timedelta(days=cutoff_days))
        if record is None:
            return (
                [{"reason_code": "PAYROLL_RECORD_MISSING", "severity": "high", "domain": "payroll"}]
                if past_cutoff
                else []
            )
        payroll_status = str(record.get("status", "")).lower()
        if payroll_status == "error":
            return [{"reason_code": "PAYROLL_ERROR_DETECTED", "severity": "critical", "domain": "payroll"}]
        if payroll_status in {"pending", "unconfirmed", ""} and past_cutoff:
            return [{"reason_code": "PAYROLL_NOT_CONFIRMED", "severity": "high", "domain": "payroll"}]
        return []

    def evaluate_dependency(self, dependency: dict[str, Any]) -> list[dict[str, str]]:
        status_value = str(dependency.get("status", "")).lower()
        if dependency.get("blocks_day_one") is True and status_value not in {"completed", "complete", "fulfilled"}:
            return [{"reason_code": "DAY_ONE_DEPENDENCY_BLOCKED", "severity": "high", "domain": "dependency"}]
        return []

    def evaluate_learning(
        self,
        milestone: dict[str, Any],
        worker: dict[str, Any],
        as_of: date,
    ) -> list[dict[str, str]]:
        if str(milestone.get("status", "")).lower() in {"completed", "complete"}:
            return []
        hire_date = self._date(worker.get("Hire_Date"))
        try:
            due_day = int(str(milestone.get("due_day", "")).lower().replace("day", "").strip())
        except ValueError:
            return [{"reason_code": "LEARNING_MILESTONE_OVERDUE", "severity": "medium", "domain": "data_quality"}]
        if hire_date and as_of > hire_date + timedelta(days=due_day):
            return [{"reason_code": "LEARNING_MILESTONE_OVERDUE", "severity": "medium", "domain": "learning"}]
        return []


def snapshot_hash(snapshot: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class HROpsService:
    def __init__(self, repo: SupabaseRepository | None = None) -> None:
        self.repo = repo or SupabaseRepository()
        self.evaluator = PolicyEvaluator()

    @staticmethod
    def _in_filter(values: set[str]) -> str:
        quoted = [
            '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
            for value in sorted(values)
        ]
        return f"in.({','.join(quoted)})"

    def manager_report_ids(self, user: dict[str, Any]) -> set[str]:
        profile = self.repo.identity_profile(str(user.get("sub", "")))
        manager_wid = profile.get("manager_wid") if profile else None
        return self.repo.direct_report_ids(manager_wid) if manager_wid else set()

    def assert_employee_access(self, user: dict[str, Any], employee_id: str) -> None:
        roles = user_roles(user)
        if roles.intersection({"admin", "people_ops"}):
            rows = self.repo.select(
                "Workers",
                {"Employee_ID": f"eq.{employee_id}", "select": "Employee_ID"},
            )
            if not rows:
                raise HTTPException(status_code=404, detail="Employee not found")
            return
        if "manager" not in roles or employee_id not in self.manager_report_ids(user):
            raise HTTPException(status_code=403, detail="Employee is not a direct report")

    def assert_run_access(self, user: dict[str, Any], run: dict[str, Any]) -> None:
        roles = user_roles(user)
        if roles.intersection({"admin", "people_ops"}):
            return
        if "manager" not in roles or run.get("created_by") != user.get("sub"):
            raise HTTPException(status_code=403, detail="Command run is not accessible")
        employee_id = run.get("employee_id")
        if not employee_id or employee_id not in self.manager_report_ids(user):
            raise HTTPException(status_code=403, detail="Command run is not accessible")

    def active_policy(self) -> dict[str, Any] | None:
        rows = self.repo.select(
            "policy_versions",
            {
                "status": "eq.active",
                "select": "version_id,config_snapshot,activated_at",
                "order": "activated_at.desc",
                "limit": "1",
            },
        )
        return rows[0] if rows else None

    @staticmethod
    def confidential_routing(snapshot: dict[str, Any]) -> dict[str, Any]:
        routing = snapshot.get("routing", {})
        if not isinstance(routing, dict):
            return {}
        return {
            key: value
            for key, value in routing.items()
            if "confidential" in str(key).lower()
        }

    def changes_confidential_routing(self, snapshot: dict[str, Any]) -> bool:
        active = self.active_policy()
        candidate = self.confidential_routing(snapshot)
        if not active:
            return bool(candidate)
        return candidate != self.confidential_routing(active["config_snapshot"])

    def case_metrics(
        self,
        employee_ids: set[str] | None = None,
        *,
        case_scope: str = "all",
    ) -> dict[str, Any]:
        params = {"select": "case_type,status,employee_id"}
        if case_scope == "exclude_payroll":
            params["case_type"] = f"neq.{PAYROLL_CASE_TYPE}"
        elif case_scope == "payroll_only":
            params["case_type"] = f"eq.{PAYROLL_CASE_TYPE}"
        if employee_ids is not None:
            if not employee_ids:
                cases: list[dict[str, Any]] = []
            else:
                cases = self.repo.select_all(
                    "workbench_cases",
                    {**params, "employee_id": self._in_filter(employee_ids)},
                )
        else:
            cases = self.repo.select_all("workbench_cases", params)
        open_cases = [row for row in cases if row.get("status") != "resolved"]
        by_type: dict[str, int] = {}
        for row in open_cases:
            raw_case_type = str(row.get("case_type") or "").lower()
            case_type = (
                raw_case_type
                if raw_case_type in SAFE_CASE_TYPES
                else "system_exception"
            )
            by_type[case_type] = by_type.get(case_type, 0) + 1
        active = self.active_policy()
        now = datetime.now(UTC).isoformat()
        return {
            "as_of": now,
            "refreshed_at": now,
            "policy_version": active.get("version_id") if active else None,
            "cohort": None,
            "open_case_count": len(open_cases),
            "open_cases_by_type": by_type,
            "numerator": len(open_cases),
            "denominator": len(cases),
        }

    def manager_action_states(
        self,
        *,
        employee_ids: set[str] | None = None,
        case_id: str | None = None,
    ) -> list[dict[str, Any]]:
        params = {
            "select": MANAGER_ACTION_STATE_FIELDS,
            "order": "updated_at.desc",
        }
        if case_id:
            params["case_id"] = f"eq.{case_id}"
        if employee_ids is not None:
            if not employee_ids:
                return []
            params["employee_id"] = self._in_filter(employee_ids)
        return self.repo.select_all("manager_action_states", params)

    def finding_counts(
        self,
        snapshot: dict[str, Any],
        workers: list[dict[str, Any]],
        as_of: date,
        dataset: dict[str, dict[str, list[dict[str, Any]]]] | None = None,
    ) -> dict[str, int]:
        dataset = dataset or self._evaluation_dataset(workers)
        counts: dict[str, int] = {}
        for worker in workers:
            employee_id = str(worker.get("Employee_ID") or "")
            findings = self.evaluator.evaluate_worker(worker, as_of, snapshot)
            compliance = dataset["compliance"].get(employee_id, [])
            payroll = dataset["payroll"].get(employee_id, [])
            dependencies = dataset["dependencies"].get(employee_id, [])
            learning = dataset["learning"].get(employee_id, [])
            findings.extend(
                finding
                for item in compliance
                for finding in self.evaluator.evaluate_compliance_item(
                    item, as_of, snapshot
                )
            )
            findings.extend(
                self.evaluator.evaluate_payroll(
                    payroll[0] if payroll else None, worker, as_of, snapshot
                )
            )
            findings.extend(
                finding
                for item in dependencies
                for finding in self.evaluator.evaluate_dependency(item)
            )
            findings.extend(
                finding
                for item in learning
                for finding in self.evaluator.evaluate_learning(item, worker, as_of)
            )
            for finding in findings:
                code = finding["reason_code"]
                counts[code] = counts.get(code, 0) + 1
        return dict(sorted(counts.items()))

    def _evaluation_dataset(
        self, workers: list[dict[str, Any]]
    ) -> dict[str, dict[str, list[dict[str, Any]]]]:
        employee_ids = {
            str(worker["Employee_ID"])
            for worker in workers
            if worker.get("Employee_ID")
        }
        grouped: dict[str, dict[str, list[dict[str, Any]]]] = {
            "compliance": {},
            "payroll": {},
            "dependencies": {},
            "learning": {},
        }
        if not employee_ids:
            return grouped
        employee_filter = self._in_filter(employee_ids)
        sources = {
            "compliance": (
                "Compliance_Items",
                "employee_id,item_id,doc_type,jurisdiction,due_date,status",
                None,
            ),
            "payroll": (
                "Payroll_Records",
                "employee_id,payroll_id,cycle,status",
                "cycle.desc",
            ),
            "dependencies": (
                "Cross_Team_Dependencies",
                "employee_id,dep_id,team,task,status,blocks_day_one",
                None,
            ),
            "learning": (
                "Learning_Milestones",
                "employee_id,milestone_id,course,due_day,status",
                None,
            ),
        }
        for domain, (table, fields, order) in sources.items():
            params = {"employee_id": employee_filter, "select": fields}
            if order:
                params["order"] = order
            for row in self.repo.select_all(table, params):
                employee_id = row.get("employee_id")
                if employee_id:
                    grouped[domain].setdefault(str(employee_id), []).append(row)
        return grouped

    def compare_policy(
        self,
        candidate: dict[str, Any],
        workers: list[dict[str, Any]],
        as_of: date,
    ) -> dict[str, Any]:
        active = self.active_policy()
        dataset = self._evaluation_dataset(workers)
        candidate_counts = self.finding_counts(candidate, workers, as_of, dataset)
        active_counts = (
            self.finding_counts(
                active["config_snapshot"], workers, as_of, dataset
            )
            if active
            else {}
        )
        codes = sorted(set(active_counts) | set(candidate_counts))
        return {
            "workers_evaluated": len(workers),
            "active_policy_version": active.get("version_id") if active else None,
            "active_findings_by_code": active_counts,
            "candidate_findings_by_code": candidate_counts,
            # Compatibility projection for the current Policy Studio UI.
            "findings_by_code": candidate_counts,
            "delta_by_code": {
                code: candidate_counts.get(code, 0) - active_counts.get(code, 0)
                for code in codes
            },
        }

    def operational_twin(
        self,
        cohort: str | None = None,
        employee_ids: set[str] | None = None,
    ) -> dict[str, Any]:
        """Return privacy-safe cohort bottlenecks without individual predictions."""
        worker_params = {"select": "Employee_ID,cohort"}
        if cohort:
            worker_params["cohort"] = f"eq.{cohort}"
        if employee_ids is not None:
            if not employee_ids:
                workers: list[dict[str, Any]] = []
            else:
                worker_params["Employee_ID"] = self._in_filter(employee_ids)
                workers = self.repo.select_all("Workers", worker_params)
        else:
            workers = self.repo.select_all("Workers", worker_params)

        scoped_ids = {
            str(worker["Employee_ID"])
            for worker in workers
            if worker.get("Employee_ID")
        }
        active = self.active_policy()
        snapshot = active.get("config_snapshot", {}) if active else {}
        minimum_size = self.evaluator._threshold(
            snapshot, "minimum_cohort_size", 3
        )
        now = datetime.now(UTC).isoformat()
        base = {
            "as_of": now,
            "refreshed_at": now,
            "policy_version": active.get("version_id") if active else None,
            "cohort": cohort,
            "denominator": len(scoped_ids),
            "minimum_cohort_size": minimum_size,
        }
        if len(scoped_ids) < minimum_size:
            return {**base, "suppressed": True, "bottlenecks": []}

        employee_filter = self._in_filter(scoped_ids)
        dependencies = self.repo.select_all(
            "Cross_Team_Dependencies",
            {
                "employee_id": employee_filter,
                "blocks_day_one": "eq.true",
                "select": "employee_id,team,status,blocks_day_one",
            },
        )
        blocked_by_team: dict[str, set[str]] = {}
        for dependency in dependencies:
            if str(dependency.get("status", "")).lower() in {
                "completed",
                "complete",
                "fulfilled",
            }:
                continue
            team = str(dependency.get("team") or "unknown")
            employee_id = dependency.get("employee_id")
            if employee_id:
                blocked_by_team.setdefault(team, set()).add(str(employee_id))

        minimum_workers = self.evaluator._threshold(
            snapshot, "bottleneck_min_workers", 2
        )
        minimum_percent = self.evaluator._threshold(
            snapshot, "bottleneck_min_percent", 25
        )
        bottlenecks = []
        for team, affected_ids in sorted(blocked_by_team.items()):
            affected = len(affected_ids)
            percentage = round(affected * 100 / len(scoped_ids), 1)
            if affected >= minimum_workers and percentage >= minimum_percent:
                bottlenecks.append(
                    {
                        "dependency_team": team,
                        "reason_code": "COHORT_DEPENDENCY_BOTTLENECK",
                        "affected_workers": affected,
                        "affected_percent": percentage,
                        "recommended_action": "Prioritize the shared Day-1 dependency",
                    }
                )
        return {
            **base,
            "suppressed": False,
            "thresholds": {
                "minimum_workers": minimum_workers,
                "minimum_percent": minimum_percent,
            },
            "bottlenecks": bottlenecks,
        }

    def dashboard(
        self,
        employee_ids: set[str] | None = None,
        *,
        case_scope: str = "all",
    ) -> dict[str, Any]:
        worker_params = {"select": "Employee_ID,cohort"}
        case_params = {"select": "case_id,status,priority,case_type"}
        if case_scope == "exclude_payroll":
            case_params["case_type"] = f"neq.{PAYROLL_CASE_TYPE}"
        elif case_scope == "payroll_only":
            case_params["case_type"] = f"eq.{PAYROLL_CASE_TYPE}"
        if employee_ids is not None:
            if not employee_ids:
                workers: list[dict[str, Any]] = []
                cases: list[dict[str, Any]] = []
            else:
                employee_filter = self._in_filter(employee_ids)
                workers = self.repo.select_all(
                    "Workers",
                    {**worker_params, "Employee_ID": employee_filter},
                )
                cases = self.repo.select_all(
                    "workbench_cases",
                    {**case_params, "employee_id": employee_filter},
                )
        else:
            workers = self.repo.select_all("Workers", worker_params)
            cases = self.repo.select_all("workbench_cases", case_params)
        integrations = self.repo.select("integration_health", {"select": "integration_key,status,last_success_at,checked_at"})
        return {
            "workers": len(workers),
            "open_cases": sum(case.get("status") != "resolved" for case in cases),
            "critical_cases": sum(case.get("priority") == "critical" and case.get("status") != "resolved" for case in cases),
            "cohorts": len({worker.get("cohort") for worker in workers if worker.get("cohort")}),
            "integrations": sanitize(integrations),
            "refreshed_at": datetime.now(UTC).isoformat(),
        }

    def create_run(
        self, actor: str, payload: dict[str, Any], idempotency_key: str
    ) -> dict[str, Any]:
        request_key_hash = hashlib.sha256(idempotency_key.encode()).hexdigest()
        request_fingerprint = snapshot_hash(
            {
                "scope": payload["scope"],
                "employee_id": payload.get("employee_id"),
                "cohort": payload.get("cohort"),
                "reason_code": payload.get("reason_code"),
            }
        )
        existing = self.repo.select(
            "command_runs",
            {
                "created_by": f"eq.{actor}",
                "request_key_hash": f"eq.{request_key_hash}",
                "select": "command_id,created_at,status,scope,employee_id,cohort,requested_reason,request_fingerprint",
                "limit": "1",
            },
        )
        if existing:
            if existing[0].get("request_fingerprint") != request_fingerprint:
                raise HTTPException(
                    status_code=409,
                    detail="Idempotency key was already used for a different run",
                )
            return existing[0]
        command_id = f"cmd_{hashlib.sha256(f'{actor}:{request_key_hash}'.encode()).hexdigest()[:32]}"
        record = {
            "command_id": command_id,
            "created_by": actor,
            "status": "queued",
            "scope": payload["scope"],
            "employee_id": payload.get("employee_id"),
            "cohort": payload.get("cohort"),
            "requested_reason": payload.get("reason_code"),
            "workflow_key": "hr_orchestrator",
            "trigger_source": "command_center",
            "reconciliation_status": "pending",
            "request_key_hash": request_key_hash,
            "request_fingerprint": request_fingerprint,
        }
        try:
            self.repo.insert("command_runs", record)
        except HTTPException:
            concurrent = self.repo.select(
                "command_runs",
                {
                    "command_id": f"eq.{command_id}",
                    "select": "command_id,created_at,status,scope,employee_id,cohort,requested_reason,request_fingerprint",
                },
            )
            if not concurrent or concurrent[0].get("request_fingerprint") != request_fingerprint:
                raise
            return concurrent[0]
        return {**record, "created_at": datetime.now(UTC)}


def assert_manager_owns_employee(
    hr: HROpsService, user: dict[str, Any], employee_id: str
) -> None:
    """Enforce standard-data access without confidential-role privilege uplift."""
    roles = user_roles(user)
    manager_scoped = "manager" in roles and not roles.intersection(
        {"admin", "people_ops"}
    )
    if not manager_scoped:
        return
    profile = hr.repo.identity_profile(str(user.get("sub", "")))
    if not profile or not profile.get("manager_wid"):
        raise HTTPException(
            status_code=403, detail="Manager identity mapping is not configured"
        )
    if employee_id not in hr.repo.direct_report_ids(str(profile["manager_wid"])):
        raise HTTPException(status_code=403, detail="Employee is not a direct report")
