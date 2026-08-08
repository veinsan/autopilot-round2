"""Server-only adapter for Supervity Auto workflow-run streaming."""

from __future__ import annotations

import json
import hashlib
import os
from datetime import UTC, datetime
from typing import Any

import httpx

from .hr import SupabaseRepository


class AutoWorkflowClient:
    """Execute only the configured HR workflow and persist sanitized events."""

    def __init__(self, repo: SupabaseRepository | None = None) -> None:
        self.base_url = os.getenv("AUTO_BASE_URL", "").rstrip("/")
        self.api_key = os.getenv("AUTO_API_KEY", "")
        self.org_id = os.getenv("AUTO_ACTIVE_ORG", "")
        self.workflow_id = os.getenv("AUTO_HR_WORKFLOW_ID", "")
        self.repo = repo or SupabaseRepository()

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key and self.workflow_id)

    def _headers(self) -> dict[str, str]:
        """Auth headers for Auto.

        ``x-active-org`` is only sent when configured. Auto rejects a request
        carrying an organization the key is not scoped to with 403, while the
        same key without the header authenticates normally — so an unset value
        is workable, but a wrong one silently fails every run.
        """
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "x-source": "external",
        }
        if self.org_id:
            headers["x-active-org"] = self.org_id
        return headers

    @staticmethod
    def _status(value: Any) -> str:
        raw_status = str(value or "running").lower()
        normalized = {
            "scheduled": "queued",
            "waiting": "running",
            "canceled": "cancelled",
            "succeeded": "completed",
            "success": "completed",
            "error": "failed",
        }.get(raw_status, raw_status)
        return (
            normalized
            if normalized in {"queued", "running", "completed", "failed", "cancelled"}
            else "running"
        )

    @staticmethod
    def _safe_event(event_type: str, data: dict[str, Any]) -> tuple[str, str, dict[str, Any], str | None] | None:
        """Translate Auto SSE without retaining thinking, outputs, or raw errors."""
        if event_type in {"ping", "thinking"} or not isinstance(data, dict):
            return None
        if event_type in {"workflow-run", "activity-run"}:
            content = data.get("content", {})
            if not isinstance(content, dict):
                return (
                    "system_exception",
                    "running",
                    {"error_type": "invalid_auto_event_shape"},
                    None,
                )
            run_id = content.get("workflowRunId")
            return event_type, AutoWorkflowClient._status(content.get("status")), {}, run_id
        if event_type == "result":
            run = data.get("workflowRun", {})
            if not isinstance(run, dict):
                run = {}
            return "result", "completed" if data.get("success") else "failed", {}, run.get("id") or run.get("workflowRunId")
        if event_type == "error":
            return "error", "failed", {"error_type": "auto_execution_error"}, None
        return "system_exception", "running", {"error_type": "unknown_auto_event"}, None

    @staticmethod
    def _parse_sse(lines: Any):
        event_type = "message"
        data_lines: list[str] = []
        for raw_line in lines:
            line = raw_line.decode() if isinstance(raw_line, bytes) else str(raw_line)
            if not line:
                if data_lines:
                    yield event_type, "\n".join(data_lines)
                event_type, data_lines = "message", []
            elif line.startswith("event:"):
                event_type = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
        if data_lines:
            yield event_type, "\n".join(data_lines)

    @staticmethod
    def _source_event_id(
        command_id: str,
        event_type: str,
        payload: dict[str, Any],
        status: str,
    ) -> str:
        content = payload.get("content", {}) if isinstance(payload, dict) else {}
        source_parts = {
            "activity": content.get("activityRunId") if isinstance(content, dict) else None,
            "run": content.get("workflowRunId") if isinstance(content, dict) else None,
            "step": content.get("stepId") if isinstance(content, dict) else None,
            "event": event_type,
            "status": status,
        }
        fingerprint = json.dumps(source_parts, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(f"{command_id}:{fingerprint}".encode()).hexdigest()

    def _persist_event(
        self,
        command_id: str,
        source_event_id: str,
        event_type: str,
        run_status: str,
        details: dict[str, Any],
        auto_run_id: str | None = None,
    ) -> None:
        event_id = f"evt_{source_event_id[:32]}"
        self.repo.rpc(
            "persist_workflow_event",
            {
                "target_command_id": command_id,
                "new_event_id": event_id,
                "new_source_event_id": source_event_id,
                "new_event_type": event_type,
                "new_status": run_status,
                "safe_details": details,
                "resolved_auto_run_id": auto_run_id,
            },
        )

    def execute_stream(self, command_id: str, inputs: dict[str, Any]) -> None:
        if not self.configured:
            return
        claimed = self.repo.patch(
            "command_runs",
            {
                "command_id": f"eq.{command_id}",
                "status": "eq.queued",
                "cancel_requested_at": "is.null",
            },
            {
                "status": "running",
                "last_event_at": datetime.now(UTC).isoformat(),
                "reconciliation_status": "pending",
            },
        )
        if not claimed:
            return
        # Auto's execute endpoint takes a JSON body, not the multipart form its
        # published docs describe, and it rejects a serialized string for
        # `inputs` with "expected record, received string". Sending form data
        # here failed every run with a transport error.
        payload = {"workflowId": self.workflow_id, "inputs": inputs, "envs": {}}
        saw_terminal = False
        try:
            with httpx.Client(timeout=httpx.Timeout(connect=15, read=120, write=15, pool=15)) as client:
                with client.stream("POST", f"{self.base_url}/api/v1/workflow-runs/execute/stream", headers=self._headers(), json=payload) as response:
                    response.raise_for_status()
                    for current_event, raw_data in self._parse_sse(response.iter_lines()):
                        try:
                            payload = json.loads(raw_data)
                        except json.JSONDecodeError:
                            payload = {}
                            current_event = "malformed-event"
                        safe = self._safe_event(current_event, payload)
                        if safe is None:
                            continue
                        event_type, run_status, details, auto_run_id = safe
                        source_id = self._source_event_id(
                            command_id, current_event, payload, run_status
                        )
                        self._persist_event(
                            command_id,
                            source_id,
                            event_type,
                            run_status,
                            details,
                            auto_run_id,
                        )
                        saw_terminal = saw_terminal or run_status in {
                            "completed",
                            "failed",
                            "cancelled",
                        }
                        if auto_run_id:
                            current = self.repo.select(
                                "command_runs",
                                {
                                    "command_id": f"eq.{command_id}",
                                    "select": "cancel_requested_at,cancel_dispatched_at,status",
                                },
                            )
                            if (
                                current
                                and current[0].get("cancel_requested_at")
                                and not current[0].get("cancel_dispatched_at")
                                and current[0].get("status") == "running"
                            ):
                                self.repo.patch(
                                    "command_runs",
                                    {"command_id": f"eq.{command_id}"},
                                    {"auto_run_id": auto_run_id},
                                )
                                self.cancel(auto_run_id)
                                self.repo.patch(
                                    "command_runs",
                                    {
                                        "command_id": f"eq.{command_id}",
                                        "status": "eq.running",
                                    },
                                    {
                                        "cancel_dispatched_at": datetime.now(UTC).isoformat(),
                                        "reconciliation_status": "required",
                                    },
                                )
                        if saw_terminal:
                            break
            if not saw_terminal:
                self.repo.patch(
                    "command_runs",
                    {"command_id": f"eq.{command_id}", "status": "eq.running"},
                    {
                        "error_code": "STREAM_INTERRUPTED",
                        "reconciliation_status": "required",
                        "last_event_at": datetime.now(UTC).isoformat(),
                    },
                )
        except Exception:
            source_id = hashlib.sha256(f"{command_id}:transport-error".encode()).hexdigest()
            try:
                self._persist_event(
                    command_id,
                    source_id,
                    "error",
                    "running",
                    {"error_type": "auto_transport_error"},
                )
                self.repo.patch(
                    "command_runs",
                    {"command_id": f"eq.{command_id}", "status": "in.(queued,running)"},
                    {
                        "error_code": "AUTO_TRANSPORT_ERROR",
                        "reconciliation_status": "required",
                        "last_event_at": datetime.now(UTC).isoformat(),
                    },
                )
            except Exception:
                return

    def list_runs(self, limit: int = 100) -> list[dict[str, Any]]:
        response = httpx.get(
            f"{self.base_url}/api/v1/workflow-runs",
            headers=self._headers(),
            params={"workflowId": self.workflow_id, "limit": min(limit, 100)},
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, list):
            return payload
        if not isinstance(payload, dict):
            return []
        for key in ("runs", "data", "workflowRuns"):
            if isinstance(payload.get(key), list):
                return payload[key]
        nested = payload.get("data")
        if isinstance(nested, dict):
            for key in ("runs", "workflowRuns", "items"):
                if isinstance(nested.get(key), list):
                    return nested[key]
        return []

    def get_run(self, auto_run_id: str) -> dict[str, Any]:
        response = httpx.get(
            f"{self.base_url}/api/v1/workflow-runs/{auto_run_id}",
            headers=self._headers(),
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            return {}
        for key in ("data", "workflowRun", "run"):
            if isinstance(payload.get(key), dict):
                return payload[key]
        return payload

    def cancel(self, auto_run_id: str, reason: str = "Cancelled from Command Center") -> None:
        if not self.configured:
            return
        response = httpx.post(f"{self.base_url}/api/v1/workflow-runs/cancel", headers={**self._headers(), "Content-Type": "application/json"}, json={"runIds": [auto_run_id], "reason": reason}, timeout=15)
        response.raise_for_status()
