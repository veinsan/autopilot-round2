#!/usr/bin/env python3
"""Create an immutable Round 2 policy candidate from live policy_config rows.

The script never mutates an existing version. If an older policy is active, the
Round 2 snapshot is created as a draft so it can pass simulation and approval.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

import requests


REPO_ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = REPO_ROOT / ".env"
POLICY_CONFIG_PATH = REPO_ROOT / "config" / "policy_config.json"
ROUND2_VERSION_ID = "policy_round2_v1"


def load_env() -> None:
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"'))


def decode_value(field_key: str, value: str | None):
    if value is None:
        return None
    if field_key == "version":
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def build_snapshot(rows: list[dict]) -> dict:
    snapshot: dict = {
        "thresholds": {},
        "normalization": {},
        "routing": {},
        "templates": {},
    }
    for row in rows:
        field_key, category = row["field_key"], row.get("category")
        value = decode_value(field_key, row.get("value"))
        if category == "top-level":
            snapshot[field_key] = value
        elif category == "retry":
            snapshot[field_key] = value
        elif category in snapshot:
            snapshot[category][field_key] = value
        else:
            raise ValueError(f"Unknown policy category {category!r}")
    return snapshot


def validate_round2_snapshot(snapshot: dict, canonical: dict) -> list[str]:
    errors: list[str] = []
    required_codes = set(canonical.get("reason_codes", []))
    actual_codes = snapshot.get("reason_codes")
    if not isinstance(actual_codes, list) or not required_codes.issubset(actual_codes):
        errors.append("registered Round 1 and Round 2 reason_codes are incomplete")
    required_thresholds = set(canonical.get("thresholds", {}))
    actual_thresholds = snapshot.get("thresholds")
    if not isinstance(actual_thresholds, dict) or not required_thresholds.issubset(
        actual_thresholds
    ):
        errors.append("editable Round 1 and Round 2 thresholds are incomplete")
    for key in ("retry", "retry_demo_profile"):
        if snapshot.get(key) != canonical.get(key):
            errors.append(f"{key} does not match the reviewed configuration")
    if snapshot != canonical:
        errors.append("live policy_config does not match config/policy_config.json")
    return errors


def snapshot_hash(snapshot: dict) -> str:
    serialized = json.dumps(snapshot, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode()).hexdigest()


def confidential_routing(snapshot: dict) -> dict:
    routing = snapshot.get("routing", {})
    if not isinstance(routing, dict):
        return {}
    return {
        key: value
        for key, value in routing.items()
        if "confidential" in str(key).lower()
    }


def main() -> int:
    load_env()
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required", file=sys.stderr)
        return 1
    root = f"{url}/rest/v1"
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    existing = requests.get(
        f"{root}/policy_versions",
        headers=headers,
        params={
            "select": "version_id,status,config_snapshot,snapshot_hash",
            "order": "created_at.desc",
        },
        timeout=30,
    )
    existing.raise_for_status()
    versions = existing.json()

    response = requests.get(f"{root}/policy_config", headers=headers, params={"select": "field_key,category,value"}, timeout=30)
    response.raise_for_status()
    rows = response.json()
    if not rows:
        print("policy_config is empty; refusing to infer a baseline.", file=sys.stderr)
        return 1

    try:
        snapshot = build_snapshot(rows)
    except ValueError as exc:
        print(f"{exc}; refusing to infer a Round 2 policy.", file=sys.stderr)
        return 1

    canonical = json.loads(POLICY_CONFIG_PATH.read_text(encoding="utf-8"))
    validation_errors = validate_round2_snapshot(snapshot, canonical)
    if validation_errors:
        print(
            "Live policy_config is not ready for G-01: "
            + "; ".join(validation_errors)
            + ". Run scripts/seed_loader/seed_policy_config.py first, then retry.",
            file=sys.stderr,
        )
        return 1

    desired_hash = snapshot_hash(snapshot)
    target = next(
        (row for row in versions if row.get("version_id") == ROUND2_VERSION_ID),
        None,
    )
    if target:
        if target.get("snapshot_hash") != desired_hash:
            print(
                f"{ROUND2_VERSION_ID} already exists with different content; "
                "refusing to mutate an immutable policy version.",
                file=sys.stderr,
            )
            return 1
        print(f"Policy version {ROUND2_VERSION_ID} already exists; no write performed.")
        return 0

    active = next((row for row in versions if row.get("status") == "active"), None)
    target_status = "draft" if active else "active"
    record = {
        "version_id": ROUND2_VERSION_ID,
        "parent_version_id": active.get("version_id") if active else None,
        "created_by": "system_seed",
        "config_snapshot": snapshot,
        "change_summary": "Round 2 policy candidate preserving the reviewed Round 1 configuration.",
        "status": target_status,
        "snapshot_hash": desired_hash,
        "activated_at": datetime.now(UTC).isoformat() if target_status == "active" else None,
        "is_confidential_routing": (
            confidential_routing(snapshot)
            != confidential_routing(active.get("config_snapshot", {}))
            if active
            else bool(confidential_routing(snapshot))
        ),
    }
    written = requests.post(f"{root}/policy_versions", headers={**headers, "Prefer": "return=representation"}, json=record, timeout=30)
    written.raise_for_status()
    print(
        f"Created {target_status} policy {ROUND2_VERSION_ID} from "
        f"{len(rows)} live policy_config rows."
    )
    if target_status == "draft":
        print("Simulate, approve, and activate it through Policy Studio to pass G-01.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except requests.RequestException as exc:
        print(f"Supabase request failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
