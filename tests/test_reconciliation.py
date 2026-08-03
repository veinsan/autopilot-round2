"""Offline tests for bounded Auto run reconciliation."""

from __future__ import annotations

from typing import Any

from app.services.reconciliation import AutoRunReconciler


class FakeRepository:
    def __init__(self, commands: list[dict[str, Any]]) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "command_runs": commands,
            "workflow_events": [],
            "integration_health": [],
        }

    def select(
        self, table: str, params: dict[str, str] | None = None
    ) -> list[dict[str, Any]]:
        rows = [dict(row) for row in self.tables.get(table, [])]
        for key, expression in (params or {}).items():
            if key in {"select", "order", "limit"}:
                continue
            if expression.startswith("eq."):
                rows = [
                    row
                    for row in rows
                    if str(row.get(key)).lower() == expression[3:].lower()
                ]
            elif expression.startswith("in.("):
                values = {value.strip('"') for value in expression[4:-1].split(",")}
                rows = [row for row in rows if str(row.get(key)) in values]
        return rows

    def patch(
        self, table: str, filters: dict[str, str], payload: dict[str, Any]
    ) -> list[dict[str, Any]]:
        selected = self.select(table, filters)
        for row in self.tables.get(table, []):
            if row in selected:
                row.update(payload)
        return selected

    def select_all(
        self,
        table: str,
        params: dict[str, str] | None = None,
        page_size: int = 500,
    ) -> list[dict[str, Any]]:
        return self.select(table, params)

    def upsert(
        self, table: str, payload: dict[str, Any], conflict_column: str
    ) -> list[dict[str, Any]]:
        existing = next(
            (
                row
                for row in self.tables.setdefault(table, [])
                if row.get(conflict_column) == payload.get(conflict_column)
            ),
            None,
        )
        if existing:
            existing.update(payload)
            return [dict(existing)]
        self.tables[table].append(dict(payload))
        return [dict(payload)]

    def rpc(self, function: str, payload: dict[str, Any]) -> Any:
        assert function == "persist_workflow_event"
        command = self.select(
            "command_runs",
            {"command_id": f"eq.{payload['target_command_id']}"},
        )[0]
        if command.get("status") in {"completed", "failed", "cancelled"}:
            return False
        self.upsert(
            "workflow_events",
            {
                "event_id": payload["new_event_id"],
                "source_event_id": payload["new_source_event_id"],
                "execution_id": payload["target_command_id"],
                "event_type": payload["new_event_type"],
                "status": payload["new_status"],
                "details": payload["safe_details"],
            },
            "event_id",
        )
        update = {
            "status": payload["new_status"],
            "reconciliation_status": (
                "complete"
                if payload["new_status"] in {"completed", "failed", "cancelled"}
                else "pending"
            ),
        }
        if payload.get("resolved_auto_run_id"):
            update["auto_run_id"] = payload["resolved_auto_run_id"]
        self.patch(
            "command_runs",
            {"command_id": f"eq.{payload['target_command_id']}"},
            update,
        )
        return True


class FakeAuto:
    configured = True

    def __init__(
        self,
        listed: list[dict[str, Any]] | None = None,
        detailed: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.listed = listed or []
        self.detailed = detailed or {}
        self.cancelled: list[str] = []

    def list_runs(self, limit: int = 100) -> list[dict[str, Any]]:
        return self.listed

    def get_run(self, auto_run_id: str) -> dict[str, Any]:
        return self.detailed.get(auto_run_id, {})

    def cancel(self, auto_run_id: str) -> None:
        self.cancelled.append(auto_run_id)


def test_reconciler_correlates_command_id_and_persists_safe_terminal_event() -> None:
    repo = FakeRepository(
        [
            {
                "command_id": "cmd-1",
                "status": "running",
                "auto_run_id": None,
                "cancel_requested_at": None,
                "reconciliation_status": "pending",
            }
        ]
    )
    auto = FakeAuto(
        listed=[
            {
                "id": "auto-1",
                "status": "completed",
                "inputs": '{"command_id":"cmd-1","comment":"private"}',
                "outputs": {"comment": "private"},
            }
        ]
    )

    result = AutoRunReconciler(repo, auto).reconcile_once()  # type: ignore[arg-type]

    assert result == {
        "checked": 1,
        "matched": 1,
        "unmatched": 0,
        "discovered": 0,
        "errors": 0,
    }
    assert repo.tables["command_runs"][0]["status"] == "completed"
    assert repo.tables["workflow_events"][0]["details"] == {
        "source": "auto_run_status"
    }
    assert "comment" not in str(repo.tables["workflow_events"])
    assert repo.tables["integration_health"][0]["status"] == "healthy"


def test_reconciler_uses_known_auto_run_id_and_deduplicates_status_event() -> None:
    repo = FakeRepository(
        [
            {
                "command_id": "cmd-2",
                "status": "running",
                "auto_run_id": "auto-2",
                "cancel_requested_at": None,
                "reconciliation_status": "pending",
            }
        ]
    )
    auto = FakeAuto(detailed={"auto-2": {"id": "auto-2", "status": "waiting"}})
    reconciler = AutoRunReconciler(repo, auto)  # type: ignore[arg-type]

    reconciler.reconcile_once()
    reconciler.reconcile_once()

    assert len(repo.tables["workflow_events"]) == 1
    assert repo.tables["command_runs"][0]["status"] == "running"


def test_unconfigured_reconciler_marks_health_down_without_reading_runs() -> None:
    repo = FakeRepository([])
    auto = FakeAuto()
    auto.configured = False

    result = AutoRunReconciler(repo, auto).reconcile_once()  # type: ignore[arg-type]

    assert result == {
        "checked": 0,
        "matched": 0,
        "unmatched": 0,
        "discovered": 0,
        "errors": 1,
    }
    assert repo.tables["integration_health"][0]["status"] == "down"


def test_empty_reconciliation_performs_real_auto_probe_before_healthy() -> None:
    repo = FakeRepository([])

    result = AutoRunReconciler(repo, FakeAuto()).reconcile_once()  # type: ignore[arg-type]

    assert result == {
        "checked": 0,
        "matched": 0,
        "unmatched": 0,
        "discovered": 0,
        "errors": 0,
    }
    assert repo.tables["integration_health"][0]["status"] == "healthy"


def test_reconciler_repairs_running_transport_interruption_from_auto_status() -> None:
    repo = FakeRepository(
        [
            {
                "command_id": "cmd-3",
                "status": "running",
                "error_code": "AUTO_TRANSPORT_ERROR",
                "auto_run_id": "auto-3",
                "cancel_requested_at": None,
                "reconciliation_status": "required",
            }
        ]
    )
    auto = FakeAuto(detailed={"auto-3": {"id": "auto-3", "status": "completed"}})

    AutoRunReconciler(repo, auto).reconcile_once()  # type: ignore[arg-type]

    assert repo.tables["command_runs"][0]["status"] == "completed"
    assert repo.tables["command_runs"][0]["reconciliation_status"] == "complete"


def test_reconciler_dispatches_pending_cancellation_when_run_is_discovered() -> None:
    repo = FakeRepository(
        [
            {
                "command_id": "cmd-4",
                "status": "running",
                "auto_run_id": None,
                "cancel_requested_at": "2026-08-03T10:00:00Z",
                "reconciliation_status": "pending",
            }
        ]
    )
    auto = FakeAuto(
        listed=[
            {
                "id": "auto-4",
                "status": "running",
                "inputs": {"command_id": "cmd-4"},
            }
        ]
    )

    AutoRunReconciler(repo, auto).reconcile_once()  # type: ignore[arg-type]

    assert auto.cancelled == ["auto-4"]
    assert repo.tables["command_runs"][0]["status"] == "running"
    assert repo.tables["command_runs"][0]["cancel_dispatched_at"]
    assert repo.tables["command_runs"][0]["reconciliation_status"] == "required"


def test_reconciler_discovers_scheduled_run_with_safe_scope_only() -> None:
    repo = FakeRepository([])
    auto = FakeAuto(
        listed=[
            {
                "id": "auto-scheduled-1",
                "status": "completed",
                "inputs": {
                    "cohort": "2026-08",
                    "trigger_source": "scheduled",
                    "reason_code": "DAY_ONE_DEPENDENCY_BLOCKED",
                    "comment": "private",
                },
                "outputs": {"comment": "private"},
            }
        ]
    )

    result = AutoRunReconciler(repo, auto).reconcile_once()  # type: ignore[arg-type]

    assert result["discovered"] == 1
    command = repo.tables["command_runs"][0]
    assert command["trigger_source"] == "scheduled"
    assert command["cohort"] == "2026-08"
    assert command["status"] == "completed"
    assert "comment" not in str(repo.tables["workflow_events"])
