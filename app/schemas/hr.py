"""Contracts for the HR & People Ops Command Center.

These models intentionally contain only sanitized operational metadata.  Raw
engagement comments and payroll error details never cross this boundary.
"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


CaseStatus = Literal["open", "in_review", "awaiting_external_update", "resolved"]
PolicyStatus = Literal["draft", "simulated", "approved", "active", "retired"]


class CaseActionRequest(BaseModel):
    decision: Literal["claim", "acknowledge", "await_external_update", "resolve"]
    sanitized_feedback: str | None = Field(default=None, max_length=1000)


class PolicyDraftRequest(BaseModel):
    config_snapshot: dict[str, Any]
    change_summary: str = Field(min_length=3, max_length=1000)


class PolicySimulationRequest(BaseModel):
    version_id: str
    cohort: str | None = Field(default=None, max_length=120)
    as_of: datetime | None = None


class PolicyApprovalRequest(BaseModel):
    decision: Literal["approve", "reject"]
    note: str | None = Field(default=None, max_length=1000)


class RunRequest(BaseModel):
    scope: Literal["employee", "cohort"]
    employee_id: str | None = Field(default=None, max_length=120)
    cohort: str | None = Field(default=None, max_length=120)
    reason: str | None = Field(default=None, max_length=500)


class RunResponse(BaseModel):
    command_id: str
    status: str
    created_at: datetime
    scope: str
    employee_id: str | None = None
    cohort: str | None = None
