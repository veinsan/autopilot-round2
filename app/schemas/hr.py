"""Contracts for the HR & People Ops Command Center.

These models intentionally contain only sanitized operational metadata.  Raw
engagement comments and payroll error details never cross this boundary.
"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


CaseStatus = Literal["open", "in_review", "awaiting_external_update", "resolved"]
PolicyStatus = Literal["draft", "simulated", "approved", "active", "retired"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CaseActionRequest(StrictModel):
    decision: Literal["claim", "acknowledge", "await_external_update", "resolve"]
    resolution_code: Literal[
        "DATA_CORRECTED",
        "EMPLOYEE_SUPPORTED",
        "DEPENDENCY_CLEARED",
        "POLICY_EXCEPTION_APPROVED",
        "NO_ACTION_REQUIRED",
        "ESCALATED_EXTERNALLY",
    ] | None = None


class PolicyDraftRequest(StrictModel):
    config_snapshot: dict[str, Any]
    change_summary: str = Field(min_length=3, max_length=1000)


class PolicySimulationRequest(StrictModel):
    version_id: str
    cohort: str | None = Field(default=None, max_length=120)
    as_of: datetime | None = None


class PolicyApprovalRequest(StrictModel):
    decision: Literal["approve", "reject"]
    note: str | None = Field(default=None, max_length=1000)


class RunRequest(StrictModel):
    scope: Literal["employee", "cohort"]
    employee_id: str | None = Field(default=None, max_length=120)
    cohort: str | None = Field(default=None, max_length=120)
    reason_code: str | None = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def validate_scope(self):
        if self.scope == "employee":
            if not self.employee_id or self.cohort:
                raise ValueError("employee scope requires only employee_id")
        elif not self.cohort or self.employee_id:
            raise ValueError("cohort scope requires only cohort")
        return self


class RunResponse(StrictModel):
    command_id: str
    status: str
    created_at: datetime
    scope: str
    employee_id: str | None = None
    cohort: str | None = None
