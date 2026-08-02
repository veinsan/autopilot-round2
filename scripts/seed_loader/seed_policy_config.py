#!/usr/bin/env python3
"""Seed the `policy_config` Supabase table from config/policy_config.json.

Keeps the two copies in sync per config/README.md: the JSON is the reviewed record (with one-line
justifications), the Supabase table is the runtime surface a business user edits (TASKS.md 0.2.1).
Idempotent via upsert on `field_key` (DECISIONS.md ADR-001 amendment — policy_config moved off Airtable
alongside Workers/Manager_Directory), same pattern as loader.py's Supabase-routed tables.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from supabase_client import SupabaseClient, SupabaseError

REPO_ROOT = Path(__file__).resolve().parents[2]
POLICY_CONFIG_PATH = REPO_ROOT / "config" / "policy_config.json"
ENV_PATH = REPO_ROOT / ".env"

# One-line justification per key, transcribed from config/README.md (not re-derived).
JUSTIFICATIONS = {
    "version": "Versioned so any change can be diffed and audited (ARCHITECTURE.md §9).",
    "as_of_date": "null = live wall-clock now (production). Pinned only for tests/demo recording, never an implicit now() inside Operator logic (ADR-014).",
    "demo_mode": "When true, write-side Operators read retry_demo_profile instead of retry, eliminating up to 85s of backoff dead air during a live take (RISKS.md R-23).",
    "provisioning_blocked_grace_days": "Day-one access should exist by end of Day 1; 1 day grace absorbs timezone/EOD ambiguity. Owner: OP-02.",
    "task_stalled_overdue_days": "3 days past due is late enough to be a real signal, short enough to still be actionable. Owner: OP-02.",
    "compliance_step_terms": "Explicit list, not substring match, so the rule survives a hidden dataset that renames/adds compliance steps (ADR-016). Owner: OP-02.",
    "engagement_low_score": "Below the midpoint (0-10 scale); conservative enough to avoid flagging normal variance. Owner: OP-03.",
    "disclosure_classifier_min_confidence": "High bar to auto-confirm; below it, fail-safe to human review rather than a coin-flip auto-decision. Owner: OP-03.",
    "dedup_confidence_threshold": "High bar - a false merge (two real people treated as one) is worse than an extra escalation (ADR-012). Owner: OP-01.",
    "dedup_flag_band_low": "Below this, confidently a new hire, no escalation. Between the two bands -> escalate for human confirmation. Owner: OP-01.",
    "dedup_hire_date_proximity_days": "Tight window catching an accidental re-submission of the same intake event, not 'hired in the same cohort'. Empirically validated: EMP7032/EMP7059 and EMP7038/EMP7043 share a name 17-18 days apart in the public sample - a 30-day default would have false-merged both. Owner: OP-01.",
    "catch_rate_sla_days": "Matches task_stalled_overdue_days, keeping the 'did we act in time' bar consistent with the 'is this task late' bar. Owner: OP-05.",
    "date_formats_accepted": "13 strptime patterns covering the 3 formats in the public sample plus unseen formats (ADR-011). Never guess a date.",
    "ambiguous_numeric_date_order": "DMY - CONTEXT.md §12.4 documents the sample's slash format as DD/MM/YYYY. A value invalid under this order but valid under MDY escalates as AMBIGUOUS, never silently reinterpreted (ADR-011).",
    "manager_channel_by_org": "One Slack channel per Manager_Directory.Org value (Finance/Sales/Ops/Engineering/People) - never keyed on Workers.Job_Family, a different taxonomy (ARCHITECTURE.md §6).",
    "confidential_channel": "A single, access-restricted channel, deliberately not routed by Org - fragmenting confidential routing multiplies who can see sensitive material (ADR-002).",
    "it_escalation_channel": "Single IT-provisioning escalation channel (TASKS.md 0.1.2).",
    "manager_nudge": "OP-04 template. Interpolates only non-sensitive fields - _internal_case_payload must never appear here.",
    "it_escalation": "OP-04 template. Interpolates only non-sensitive fields.",
    "confidential_alert": "OP-04 template. Deliberately contains no disclosure content - the actual comment is reachable only through the linked Workbench case (INTEGRATIONS.md §2).",
    "retry": "Production default; absorbs Airtable/Slack rate limits and transient failures. Exhausted retries always escalate, never silently drop.",
    "retry_demo_profile": "Used only when demo_mode is on: a live demo cannot afford up to 85s of dead air per failed write chain (RISKS.md R-23).",
}


def load_env(env_path: Path) -> None:
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def build_rows(policy: dict) -> list:
    rows = []

    def add(field_key, category, value):
        serialized = value if isinstance(value, str) else json.dumps(value)
        rows.append({
            "field_key": field_key,
            "category": category,
            "value": serialized,
            "justification": JUSTIFICATIONS.get(field_key, ""),
        })

    for key in ("version", "as_of_date", "demo_mode"):
        add(key, "top-level", policy[key])
    for key, value in policy["thresholds"].items():
        add(key, "thresholds", value)
    for key, value in policy["normalization"].items():
        add(key, "normalization", value)
    for key, value in policy["routing"].items():
        add(key, "routing", value)
    for key, value in policy["templates"].items():
        add(key, "templates", value)
    add("retry", "retry", policy["retry"])
    add("retry_demo_profile", "retry", policy["retry_demo_profile"])
    return rows


def main() -> int:
    load_env(ENV_PATH)
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        print("ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (check .env)", file=sys.stderr)
        return 1

    with open(POLICY_CONFIG_PATH, encoding="utf-8") as f:
        policy = json.load(f)

    rows = build_rows(policy)
    client = SupabaseClient(supabase_url, supabase_key)
    try:
        written = client.upsert_batch("policy_config", "field_key", rows)
    except SupabaseError as exc:
        print(f"ERROR: Supabase write failed: {exc}", file=sys.stderr)
        return 1
    print(f"Wrote {len(written)} policy_config rows.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
