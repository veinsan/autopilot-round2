#!/usr/bin/env python3
"""Reseeding utility — TASKS.md 3.1/3.2, contract in docs/DATA_FLOW.md §6.

Loads the 11 source CSVs into their destination tables, schema-driven (column-name-mapped, ADR-006) so
the same code runs unchanged against the hidden judging dataset. Applies DATA_FLOW.md §3 steps 1/2/4
(whitespace+casing, date parsing, numeric coercion) per row — never step 3 (fuzzy-dedup): the seed
file's workers are already distinct, verified records, so a fuzzy pass over them only risks a false
merge for no benefit (fuzzy_dedup.py is OP-01's live Typeform intake path only).

Airtable is fully deprecated (`DECISIONS.md` ADR-001's second amendment) — every table, including
`Cases_Audit_Log` (--reset only, not one of the 11 CSV-driven TABLES, written at runtime by OP-04
instead), now writes through Supabase. `schema.py`'s per-table `TableSchema.backend` is kept for a
possible future re-split, not because anything currently routes elsewhere.

Usage:
    python3 loader.py                 # reseed from dataset/csv against the live Supabase project
    python3 loader.py --dry-run       # validate + normalize only, no writes
    python3 loader.py --reset         # also clear Cases_Audit_Log first (never source tables)
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

from normalize import ParseStatus, load_policy_config, normalize_name, normalize_text, parse_date
from schema import TABLES
from supabase_client import SupabaseClient, SupabaseError

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET_DIR = REPO_ROOT / "dataset" / "csv"
DEFAULT_ENV_PATH = REPO_ROOT / ".env"


def load_env(env_path: Path) -> None:
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def validate_schema(dataset_dir: Path) -> list:
    """Schema layer (DATA_FLOW.md §4): required columns present, correctly named.
    Returns [(csv_file, [missing_or_renamed_columns])] — non-empty means abort, no partial load."""
    errors = []
    for table in TABLES:
        path = dataset_dir / table.csv_file
        if not path.exists():
            errors.append((table.csv_file, ["<file not found>"]))
            continue
        with open(path, encoding="utf-8", newline="") as f:
            header = next(csv.reader(f), [])
        missing = [c for c in table.columns if c not in header]
        if missing:
            errors.append((table.csv_file, missing))
    return errors


def normalize_row(table, row: dict, policy: dict) -> tuple:
    """Apply DATA_FLOW.md §3 steps 1/2/4 to one row. Never invents a value: an unparseable date is
    preserved as normalized raw text (never silently dropped or guessed), and a numeric field that
    fails to coerce is omitted (never written into a Number field with a mismatched type) — both are
    surfaced in the returned flags for the load report instead."""
    fields = {}
    flags = []
    norm = policy["normalization"]
    for col in table.columns:
        raw = row.get(col, "")
        if col in table.date_fields:
            result = parse_date(raw, norm["date_formats_accepted"], norm["ambiguous_numeric_date_order"])
            if result.status is ParseStatus.OK:
                fields[col] = result.value.isoformat()
            elif result.status is ParseStatus.BLANK:
                pass  # blank = meaningful non-response state, not an error (DATA_FLOW.md §3/§4)
            else:
                fields[col] = normalize_text(raw)
                flags.append(f"{col}: {result.status.value} date {raw!r} ({result.detail})")
        elif col in table.numeric_fields:
            text = normalize_text(raw)
            if not text:
                continue
            try:
                value = float(text)
            except ValueError:
                flags.append(f"{col}: not numeric {text!r}; field left blank")
            else:
                fields[col] = int(value) if value.is_integer() else value
        elif col in table.boolean_fields:
            text = normalize_text(raw).lower()
            if not text:
                continue
            if text in {"true", "1"}:
                fields[col] = True
            elif text in {"false", "0"}:
                fields[col] = False
            else:
                flags.append(f"{col}: not boolean {text!r}; field left blank")
        elif col in table.name_fields:
            fields[col] = normalize_name(raw)
        else:
            fields[col] = normalize_text(raw)
    return fields, flags


def load_table(table, dataset_dir: Path, policy: dict, report: dict) -> list:
    path = dataset_dir / table.csv_file
    with open(path, encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))

    seen = set()
    deduped = 0
    missing_key = 0
    records = []
    for row in rows:
        key = normalize_text(row.get(table.natural_key, ""))
        fields, flags = normalize_row(table, row, policy)
        if not key:
            missing_key += 1
            report["flagged"][table.airtable_table].append(
                {table.natural_key: "<blank>", "issues": ["missing natural key value; row excluded"]}
            )
            continue
        if key in seen:
            deduped += 1
            continue
        seen.add(key)
        if flags:
            report["flagged"][table.airtable_table].append({table.natural_key: key, "issues": flags})
        records.append(fields)

    report["deduped"][table.airtable_table] = deduped
    report["missing_key"][table.airtable_table] = missing_key
    report["row_count"][table.airtable_table] = len(records)
    return records


def build_report() -> dict:
    return {
        "row_count": {},
        "deduped": {},
        "missing_key": {},
        "flagged": defaultdict(list),
        "written": {},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset-dir", default=str(DEFAULT_DATASET_DIR), help="Directory containing the source CSVs.")
    parser.add_argument("--env-file", default=str(DEFAULT_ENV_PATH), help="Path to .env with SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.")
    parser.add_argument("--reset", action="store_true", help="Clear Cases_Audit_Log before reseeding (never source tables).")
    parser.add_argument("--dry-run", action="store_true", help="Validate + normalize only; do not write to Supabase.")
    args = parser.parse_args()

    dataset_dir = Path(args.dataset_dir)
    load_env(Path(args.env_file))

    schema_errors = validate_schema(dataset_dir)
    if schema_errors:
        print("Schema validation FAILED — aborting load, no Supabase writes attempted.\n", file=sys.stderr)
        for csv_file, missing in schema_errors:
            print(f"  {csv_file}: missing/renamed column(s): {', '.join(missing)}", file=sys.stderr)
        return 1

    supabase_client = None
    if not args.dry_run:
        supabase_url = os.environ.get("SUPABASE_URL")
        supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not supabase_key:
            print("ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (check .env)", file=sys.stderr)
            return 1
        policy_for_retry = load_policy_config()
        supabase_client = SupabaseClient(supabase_url, supabase_key, retry=policy_for_retry["retry"])

    clients = {"supabase": supabase_client}

    policy = load_policy_config()
    report = build_report()
    report["backend"] = {table.airtable_table: table.backend for table in TABLES}

    if args.reset and supabase_client:
        report["reset_cases_deleted"] = supabase_client.delete_all("Cases_Audit_Log", "case_id")

    start = time.time()
    try:
        for table in TABLES:
            records = load_table(table, dataset_dir, policy, report)
            backend_client = clients[table.backend]
            if backend_client:
                written = backend_client.upsert_batch(table.airtable_table, table.natural_key, records)
                report["written"][table.airtable_table] = len(written)
            else:
                report["written"][table.airtable_table] = 0
    except SupabaseError as exc:
        print(f"ERROR: {table.backend} write failed for {table.airtable_table}: {exc}", file=sys.stderr)
        return 1
    report["elapsed_seconds"] = round(time.time() - start, 2)
    report["mode"] = "dry-run" if args.dry_run else "live"

    print(json.dumps(report, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
