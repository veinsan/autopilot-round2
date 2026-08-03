"""Bounded reconciliation for durable Command Center and Auto run state."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import uuid
from datetime import UTC, datetime
from typing import Any

from .auto import AutoWorkflowClient
from .hr import HROpsService, KNOWN_REASON_CODES, SupabaseRepository


TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


class AutoRunReconciler:
    """Repair interrupted SSE delivery without copying Auto's private payloads."""

    def __init__(
        self,
        repo: SupabaseRepository,
        auto: AutoWorkflowClient | None = None,
    ) -> None:
        self.repo = repo
        self.auto = auto or AutoWorkflowClient(repo)

    @staticmethod
    def _inputs(run: dict[str, Any]) -> dict[str, Any]:
        value = run.get("inputs") or run.get("input") or {}
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                return parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                return {}
        return {}

    @classmethod
    def _find_correlated(
        cls, command_id: str, candidates: list[dict[str, Any]]
    ) -> dict[str, Any] | None:
        for candidate in candidates:
            if cls._inputs(candidate).get("command_id") == command_id:
                return candidate
        return None

    @staticmethod
    def _auto_id(run: dict[str, Any]) -> str | None:
        value = run.get("id") or run.get("workflowRunId") or run.get("workflow_run_id")
        return str(value) if value else None

    def _record_status(
        self, command: dict[str, Any], auto_run: dict[str, Any]
    ) -> None:
        command_id = str(command["command_id"])
        auto_run_id = self._auto_id(auto_run) or command.get("auto_run_id")
        status_value = AutoWorkflowClient._status(auto_run.get("status"))
        fingerprint = hashlib.sha256(
            f"{command_id}:reconcile:{auto_run_id}:{status_value}".encode()
        ).hexdigest()
        AutoWorkflowClient(self.repo)._persist_event(
            command_id,
            fingerprint,
            "reconciliation",
            status_value,
            {"source": "auto_run_status"},
            str(auto_run_id) if auto_run_id else None,
        )
        self.repo.patch(
            "command_runs",
            {"command_id": f"eq.{command_id}", "status": f"eq.{status_value}"},
            {
                "last_reconciled_at": datetime.now(UTC).isoformat(),
                "reconciliation_status": (
                    "complete"
                    if status_value in TERMINAL_STATUSES
                    else (
                        "required"
                        if command.get("cancel_requested_at")
                        else "pending"
                    )
                ),
            },
        )

    def _health(self, status_value: str, success: bool) -> None:
        now = datetime.now(UTC).isoformat()
        payload: dict[str, Any] = {
            "integration_key": "auto",
            "category": "workflow",
            "status": status_value,
            "checked_at": now,
            "detail": None,
        }
        if success:
            payload["last_success_at"] = now
        self.repo.upsert("integration_health", payload, "integration_key")

    def _discover_external_runs(self, candidates: list[dict[str, Any]]) -> int:
        auto_ids = {
            auto_id
            for candidate in candidates
            if (auto_id := self._auto_id(candidate))
        }
        if not auto_ids:
            return 0
        existing = self.repo.select_all(
            "command_runs",
            {
                "auto_run_id": HROpsService._in_filter(auto_ids),
                "select": "auto_run_id",
            },
        )
        known = {str(row["auto_run_id"]) for row in existing if row.get("auto_run_id")}
        discovered = 0
        for candidate in candidates:
            auto_run_id = self._auto_id(candidate)
            inputs = self._inputs(candidate)
            if not auto_run_id or auto_run_id in known or inputs.get("command_id"):
                continue
            employee_id = inputs.get("employee_id")
            cohort = inputs.get("cohort")
            if employee_id:
                scope = "employee"
                cohort = None
            elif cohort:
                scope = "cohort"
                employee_id = None
            else:
                continue
            command_id = f"cmd_auto_{hashlib.sha256(auto_run_id.encode()).hexdigest()[:24]}"
            trigger = str(inputs.get("trigger_source") or "auto").lower()
            if trigger not in {"auto", "scheduled", "schedule", "typeform"}:
                trigger = "auto"
            reason_code = inputs.get("reason_code")
            record = {
                "command_id": command_id,
                "created_by": "auto",
                "status": "queued",
                "scope": scope,
                "employee_id": str(employee_id) if employee_id else None,
                "cohort": str(cohort) if cohort else None,
                "requested_reason": (
                    reason_code if reason_code in KNOWN_REASON_CODES else None
                ),
                "workflow_key": "hr_orchestrator",
                "trigger_source": trigger,
                "auto_run_id": auto_run_id,
                "reconciliation_status": "pending",
            }
            self.repo.upsert("command_runs", record, "command_id")
            self._record_status(record, candidate)
            known.add(auto_run_id)
            discovered += 1
        return discovered

    def reconcile_once(self, limit: int = 25) -> dict[str, int]:
        if not self.auto.configured:
            self._health("down", False)
            return {
                "checked": 0,
                "matched": 0,
                "unmatched": 0,
                "discovered": 0,
                "errors": 1,
            }

        commands = self.repo.select(
            "command_runs",
            {
                "reconciliation_status": "in.(pending,required)",
                "select": "command_id,status,auto_run_id,cancel_requested_at,cancel_dispatched_at,error_code",
                "order": "last_reconciled_at.asc.nullsfirst,created_at",
                "limit": str(max(1, min(limit, 100))),
            },
        )
        result = {
            "checked": len(commands),
            "matched": 0,
            "unmatched": 0,
            "discovered": 0,
            "errors": 0,
        }
        candidate_runs: list[dict[str, Any]] = []
        successful_auto_operation = False
        try:
            candidate_runs = self.auto.list_runs(limit=100)
            successful_auto_operation = True
            result["discovered"] = self._discover_external_runs(candidate_runs)
        except Exception:
            result["errors"] += 1
        for command in commands:
            try:
                auto_run_id = command.get("auto_run_id")
                if auto_run_id:
                    auto_run = self.auto.get_run(str(auto_run_id))
                    successful_auto_operation = True
                else:
                    auto_run = self._find_correlated(
                        str(command["command_id"]), candidate_runs
                    ) or {}
                if not auto_run:
                    result["unmatched"] += 1
                    self.repo.patch(
                        "command_runs",
                        {"command_id": f"eq.{command['command_id']}"},
                        {"last_reconciled_at": datetime.now(UTC).isoformat()},
                    )
                    continue
                if (
                    command.get("cancel_requested_at")
                    and not command.get("cancel_dispatched_at")
                    and AutoWorkflowClient._status(auto_run.get("status"))
                    not in TERMINAL_STATUSES
                ):
                    resolved_auto_id = self._auto_id(auto_run)
                    if resolved_auto_id:
                        self.auto.cancel(resolved_auto_id)
                        self.repo.patch(
                            "command_runs",
                            {"command_id": f"eq.{command['command_id']}"},
                            {
                                "cancel_dispatched_at": datetime.now(UTC).isoformat(),
                                "reconciliation_status": "required",
                            },
                        )
                self._record_status(command, auto_run)
                result["matched"] += 1
            except Exception:
                result["errors"] += 1
        if (
            successful_auto_operation
            and result["errors"] == 0
            and result["unmatched"] == 0
        ):
            self._health("healthy", True)
        else:
            self._health("degraded", False)
        return result


async def reconciliation_loop(stop_event: asyncio.Event) -> None:
    """Run one bounded reconciler across many web workers via a DB lease."""
    try:
        configured_interval = int(
            os.getenv("AUTO_RECONCILIATION_INTERVAL_SECONDS", "60")
        )
    except ValueError:
        configured_interval = 60
    interval = max(15, min(configured_interval, 3600))
    lease_seconds = min(max(interval * 3, 120), 3600)
    owner = f"api-{uuid.uuid4().hex}"
    while not stop_event.is_set():
        repo = SupabaseRepository()
        try:
            claimed = await asyncio.to_thread(
                repo.rpc,
                "claim_reconciliation_lease",
                {"lease_owner": owner, "lease_seconds": lease_seconds},
            )
            if claimed:
                await asyncio.to_thread(AutoRunReconciler(repo).reconcile_once)
        except Exception:
            # The next bounded interval retries; request handling stays available.
            pass
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval)
        except TimeoutError:
            continue
