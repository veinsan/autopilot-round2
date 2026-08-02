#!/usr/bin/env python3
"""Create the immutable Round 2 baseline from live legacy policy_config rows.

This is intentionally a one-time, idempotent bootstrap: it preserves the
currently operative values before Policy Studio begins versioned changes.
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
BASELINE_ID = "policy_baseline_v1"


def load_env() -> None:
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


def main() -> int:
    load_env()
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required", file=sys.stderr)
        return 1
    root = f"{url}/rest/v1"
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    existing = requests.get(f"{root}/policy_versions", headers=headers, params={"select": "version_id,status"}, timeout=30)
    existing.raise_for_status()
    if existing.json():
        print("Policy baseline already exists; no write performed.")
        return 0

    response = requests.get(f"{root}/policy_config", headers=headers, params={"select": "field_key,category,value"}, timeout=30)
    response.raise_for_status()
    rows = response.json()
    if not rows:
        print("policy_config is empty; refusing to infer a baseline.", file=sys.stderr)
        return 1

    snapshot: dict = {"thresholds": {}, "normalization": {}, "routing": {}, "templates": {}}
    for row in rows:
        field_key, category = row["field_key"], row.get("category")
        value = decode_value(field_key, row.get("value"))
        if category == "top-level":
            snapshot[field_key] = value
        elif category in snapshot:
            snapshot[category][field_key] = value
        elif category == "retry":
            snapshot[field_key] = value
        else:
            print(f"Unknown policy category {category!r}; refusing to infer a baseline.", file=sys.stderr)
            return 1

    serialized = json.dumps(snapshot, sort_keys=True, separators=(",", ":"))
    record = {
        "version_id": BASELINE_ID,
        "created_by": "system_seed",
        "config_snapshot": snapshot,
        "change_summary": "Imported immutable baseline from live legacy policy_config.",
        "status": "active",
        "snapshot_hash": hashlib.sha256(serialized.encode()).hexdigest(),
        "activated_at": datetime.now(UTC).isoformat(),
        "is_confidential_routing": True,
    }
    written = requests.post(f"{root}/policy_versions", headers={**headers, "Prefer": "return=representation"}, json=record, timeout=30)
    written.raise_for_status()
    print(f"Created active baseline {BASELINE_ID} from {len(rows)} live policy_config rows.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except requests.RequestException as exc:
        print(f"Supabase request failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
