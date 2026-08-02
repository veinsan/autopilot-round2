"""Server-only adapter for Supervity Auto workflow-run streaming."""

from __future__ import annotations

import json
import os
import uuid
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
        return bool(self.base_url and self.api_key and self.org_id and self.workflow_id)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "x-source": "external",
            "x-active-org": self.org_id,
        }

    @staticmethod
    def _safe_event(event_type: str, data: dict[str, Any]) -> tuple[str, str, dict[str, Any], str | None] | None:
        """Translate Auto SSE without retaining thinking, outputs, or raw errors."""
        if event_type in {"ping", "thinking"}:
            return None
        if event_type in {"workflow-run", "activity-run"}:
            content = data.get("content", {}) if isinstance(data, dict) else {}
            run_id = content.get("workflowRunId")
            raw_status = str(content.get("status", "running"))
            command_status = {"scheduled": "queued", "waiting": "running"}.get(raw_status, raw_status)
            if command_status not in {"queued", "running", "completed", "failed", "cancelled"}:
                command_status = "running"
            return event_type, command_status, {}, run_id
        if event_type == "result":
            run = data.get("workflowRun", {}) if isinstance(data, dict) else {}
            return "result", "completed" if data.get("success") else "failed", {}, run.get("id") or run.get("workflowRunId")
        if event_type == "error":
            return "error", "failed", {"error_type": "auto_execution_error"}, None
        return "system_exception", "failed", {"error_type": "unknown_auto_event"}, None

    def execute_stream(self, command_id: str, inputs: dict[str, Any]) -> None:
        if not self.configured:
            return
        self.repo.patch("command_runs", {"command_id": f"eq.{command_id}"}, {"status": "running", "last_event_at": datetime.now(UTC).isoformat()})
        data = {"workflowId": self.workflow_id, "inputs": json.dumps(inputs), "envs": "{}"}
        try:
            with httpx.Client(timeout=httpx.Timeout(connect=15, read=120, write=15, pool=15)) as client:
                with client.stream("POST", f"{self.base_url}/api/v1/workflow-runs/execute/stream", headers=self._headers(), data=data) as response:
                    response.raise_for_status()
                    current_event = "message"
                    for line in response.iter_lines():
                        if line.startswith("event:"):
                            current_event = line[6:].strip()
                        elif line.startswith("data:"):
                            try:
                                payload = json.loads(line[5:].strip())
                            except json.JSONDecodeError:
                                continue
                            safe = self._safe_event(current_event, payload)
                            if safe is None:
                                continue
                            event_type, run_status, details, auto_run_id = safe
                            now = datetime.now(UTC).isoformat()
                            self.repo.insert("workflow_events", {"event_id": f"evt_{uuid.uuid4().hex}", "execution_id": command_id, "operator_id": "orchestrator", "event_type": event_type, "status": run_status, "details": details})
                            update: dict[str, Any] = {"status": run_status, "last_event_at": now}
                            if auto_run_id:
                                update["auto_run_id"] = auto_run_id
                            self.repo.patch("command_runs", {"command_id": f"eq.{command_id}"}, update)
        except (httpx.HTTPError, OSError):
            self.repo.insert("workflow_events", {"event_id": f"evt_{uuid.uuid4().hex}", "execution_id": command_id, "operator_id": "orchestrator", "event_type": "error", "status": "failed", "details": {"error_type": "auto_transport_error"}})
            self.repo.patch("command_runs", {"command_id": f"eq.{command_id}"}, {"status": "failed", "error_code": "AUTO_TRANSPORT_ERROR", "last_event_at": datetime.now(UTC).isoformat()})

    def cancel(self, auto_run_id: str, reason: str = "Cancelled from Command Center") -> None:
        if not self.configured:
            return
        response = httpx.post(f"{self.base_url}/api/v1/workflow-runs/cancel", headers={**self._headers(), "Content-Type": "application/json"}, json={"runIds": [auto_run_id], "reason": reason}, timeout=15)
        response.raise_for_status()
