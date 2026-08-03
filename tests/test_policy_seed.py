"""Policy seed contract tests that do not access Supabase."""

from __future__ import annotations

import json
from pathlib import Path

from app.services.hr import (
    KNOWN_REASON_CODES,
    REQUIRED_POLICY_THRESHOLD_KEYS,
    PolicyEvaluator,
)
from scripts.seed_loader.seed_policy_config import build_rows
from scripts.seed_policy_version import (
    build_snapshot,
    snapshot_hash,
    validate_round2_snapshot,
)


REPO_ROOT = Path(__file__).resolve().parents[1]


def load_policy() -> dict:
    return json.loads(
        (REPO_ROOT / "config" / "policy_config.json").read_text(encoding="utf-8")
    )


def test_round2_policy_config_is_complete_and_valid() -> None:
    policy = load_policy()

    assert policy["version"] == "2.0"
    assert set(policy["reason_codes"]) == KNOWN_REASON_CODES
    assert REQUIRED_POLICY_THRESHOLD_KEYS <= set(policy["thresholds"])
    assert PolicyEvaluator().validate(policy) == []


def test_legacy_rows_reconstruct_the_exact_round2_snapshot() -> None:
    policy = load_policy()
    rows = build_rows(policy)

    assert build_snapshot(rows) == policy
    assert len({row["field_key"] for row in rows}) == len(rows)
    assert all(row["justification"] for row in rows)


def test_snapshot_hash_is_stable_across_object_key_order() -> None:
    policy = load_policy()
    reordered = dict(reversed(list(policy.items())))

    assert snapshot_hash(policy) == snapshot_hash(reordered)


def test_old_live_policy_rows_are_rejected_before_version_creation() -> None:
    canonical = load_policy()
    old_policy = json.loads(json.dumps(canonical))
    del old_policy["reason_codes"]
    for key in (
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
    ):
        del old_policy["thresholds"][key]

    errors = validate_round2_snapshot(old_policy, canonical)

    assert "registered Round 1 and Round 2 reason_codes are incomplete" in errors
    assert "editable Round 1 and Round 2 thresholds are incomplete" in errors
