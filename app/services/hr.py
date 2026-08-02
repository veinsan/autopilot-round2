"""Sanitized Supabase data access and deterministic HR policy evaluation."""

from __future__ import annotations

import hashlib
import os
import uuid
from datetime import UTC, date, datetime
from typing import Any

import httpx
from fastapi import HTTPException, status


CONFIDENTIAL_KEYS = {"comment", "error_reason", "raw_comment", "secure_payload"}
KNOWN_REASON_CODES = {
    "MISSING_DAY_ONE_ACCESS", "STALLED_COMPLIANCE_DOC", "TASK_ALREADY_ESCALATED",
    "PROVISIONING_DELAYED", "LOW_ENGAGEMENT_SCORE", "SENSITIVE_DISCLOSURE_DETECTED",
    "COMPLIANCE_DEADLINE_AT_RISK", "COMPLIANCE_LEGAL_BREACH", "WORK_AUTH_EXPIRY_AT_RISK",
    "WORK_AUTH_EXPIRED", "PAYROLL_ERROR_DETECTED", "PAYROLL_NOT_CONFIRMED",
    "PAYROLL_RECORD_MISSING", "DAY_ONE_DEPENDENCY_BLOCKED", "LEARNING_MILESTONE_OVERDUE",
    "MANAGER_ACKNOWLEDGMENT_OVERDUE", "MANAGER_ACTION_OVERDUE", "COHORT_DEPENDENCY_BOTTLENECK",
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
        return {key: sanitize(item) for key, item in value.items() if key.lower() not in CONFIDENTIAL_KEYS}
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    return value


class SupabaseRepository:
    """Small PostgREST client kept server-side behind FastAPI."""

    def __init__(self) -> None:
        self.url = os.getenv("SUPABASE_URL", "").rstrip("/")
        self.key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

    def _headers(self, prefer: str | None = None) -> dict[str, str]:
        if not self.url or not self.key:
            raise HTTPException(status_code=503, detail="HR data service is not configured")
        headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        return headers

    def select(self, table: str, params: dict[str, str] | None = None) -> list[dict[str, Any]]:
        response = httpx.get(f"{self.url}/rest/v1/{table}", headers=self._headers(), params=params, timeout=15)
        if response.is_error:
            raise HTTPException(status_code=502, detail="Unable to read HR data")
        return response.json()

    def insert(self, table: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
        response = httpx.post(f"{self.url}/rest/v1/{table}", headers=self._headers("return=representation"), json=payload, timeout=15)
        if response.is_error:
            raise HTTPException(status_code=502, detail="Unable to write HR data")
        return response.json()

    def patch(self, table: str, filters: dict[str, str], payload: dict[str, Any]) -> list[dict[str, Any]]:
        response = httpx.patch(f"{self.url}/rest/v1/{table}", headers=self._headers("return=representation"), params=filters, json=payload, timeout=15)
        if response.is_error:
            raise HTTPException(status_code=502, detail="Unable to update HR data")
        return response.json()

    def rpc(self, function: str, payload: dict[str, Any]) -> Any:
        response = httpx.post(f"{self.url}/rest/v1/rpc/{function}", headers=self._headers(), json=payload, timeout=15)
        if response.is_error:
            raise HTTPException(status_code=502, detail="Unable to apply HR policy change")
        return response.json() if response.content else None


class PolicyEvaluator:
    """Deterministic, side-effect-free policy evaluation used by simulation and runtime."""

    def validate(self, snapshot: dict[str, Any]) -> list[str]:
        errors: list[str] = []
        if not isinstance(snapshot, dict) or not snapshot:
            return ["Policy snapshot must be a non-empty object"]
        reason_codes = snapshot.get("reason_codes", [])
        unknown = set(reason_codes) - KNOWN_REASON_CODES if isinstance(reason_codes, list) else set()
        if unknown:
            errors.append(f"Unknown reason codes: {', '.join(sorted(unknown))}")
        routing = snapshot.get("routing", {})
        if isinstance(routing, dict) and any("manager" in str(value).lower() and "confidential" in str(key).lower() for key, value in routing.items()):
            errors.append("Confidential routing cannot target a manager")
        return errors

    def evaluate_worker(self, worker: dict[str, Any], as_of: date) -> list[dict[str, str]]:
        findings: list[dict[str, str]] = []
        expiry = worker.get("work_auth_expiry")
        if expiry:
            try:
                expiry_date = date.fromisoformat(str(expiry))
                days = (expiry_date - as_of).days
                if days < 0:
                    findings.append({"reason_code": "WORK_AUTH_EXPIRED", "severity": "critical", "domain": "compliance"})
                elif days <= 30:
                    findings.append({"reason_code": "WORK_AUTH_EXPIRY_AT_RISK", "severity": "high", "domain": "compliance"})
            except ValueError:
                findings.append({"reason_code": "COMPLIANCE_DEADLINE_AT_RISK", "severity": "medium", "domain": "data_quality"})
        return findings


def snapshot_hash(snapshot: dict[str, Any]) -> str:
    import json
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class HROpsService:
    def __init__(self, repo: SupabaseRepository | None = None) -> None:
        self.repo = repo or SupabaseRepository()
        self.evaluator = PolicyEvaluator()

    def dashboard(self) -> dict[str, Any]:
        workers = self.repo.select("Workers", {"select": "Employee_ID,cohort"})
        cases = self.repo.select("workbench_cases", {"select": "case_id,status,priority,case_type"})
        integrations = self.repo.select("integration_health", {"select": "integration_key,status,last_success_at,checked_at"})
        return {
            "workers": len(workers),
            "open_cases": sum(case.get("status") != "resolved" for case in cases),
            "critical_cases": sum(case.get("priority") == "critical" and case.get("status") != "resolved" for case in cases),
            "cohorts": len({worker.get("cohort") for worker in workers if worker.get("cohort")}),
            "integrations": sanitize(integrations),
            "refreshed_at": datetime.now(UTC).isoformat(),
        }

    def create_run(self, actor: str, payload: dict[str, Any]) -> dict[str, Any]:
        command_id = f"cmd_{uuid.uuid4().hex}"
        record = {"command_id": command_id, "created_by": actor, "status": "queued", "scope": payload["scope"], "employee_id": payload.get("employee_id"), "cohort": payload.get("cohort"), "requested_reason": payload.get("reason")}
        self.repo.insert("command_runs", record)
        return {**record, "created_at": datetime.now(UTC)}
