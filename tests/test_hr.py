from datetime import date

from app.services.hr import KNOWN_REASON_CODES, PolicyEvaluator, sanitize
from app.services.auto import AutoWorkflowClient


def test_policy_validator_rejects_unknown_reason_code():
    errors = PolicyEvaluator().validate({"reason_codes": ["NOT_A_REASON"], "routing": {}})
    assert errors


def test_policy_validator_blocks_confidential_manager_route():
    errors = PolicyEvaluator().validate({"reason_codes": [], "routing": {"confidential_case": "manager"}})
    assert "Confidential routing cannot target a manager" in errors


def test_work_authorization_findings_are_deterministic():
    findings = PolicyEvaluator().evaluate_worker({"work_auth_expiry": "2026-07-01"}, date(2026, 8, 2))
    assert findings == [{"reason_code": "WORK_AUTH_EXPIRED", "severity": "critical", "domain": "compliance"}]
    assert findings[0]["reason_code"] in KNOWN_REASON_CODES


def test_sanitize_removes_confidential_content_recursively():
    payload = {"comment": "secret", "safe": {"error_reason": "secret", "case_id": "case-1"}, "items": [{"raw_comment": "secret", "status": "open"}]}
    assert sanitize(payload) == {"safe": {"case_id": "case-1"}, "items": [{"status": "open"}]}


def test_auto_sse_sanitizer_drops_thinking_and_outputs():
    assert AutoWorkflowClient._safe_event("thinking", {"content": "private reasoning"}) is None
    assert AutoWorkflowClient._safe_event("activity-run", {"content": {"workflowRunId": "run-1", "status": "running", "outputs": {"comment": "secret"}}}) == ("activity-run", "running", {}, "run-1")
