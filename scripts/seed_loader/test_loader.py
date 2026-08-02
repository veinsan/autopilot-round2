"""Unit tests for loader.py against TASKS.md 3.1/3.2 acceptance criteria.

No live network calls: schema/normalization logic is tested directly against temp CSV copies, and
Airtable I/O is exercised only through airtable_client's pure batching/URL helpers.
"""

import csv
import shutil
import tempfile
import unittest
from pathlib import Path

from loader import build_report, load_table, normalize_row, validate_schema
from normalize import load_policy_config
from schema import TABLES

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLE_CSV_DIR = REPO_ROOT / "dataset" / "csv"


class TestSchemaValidationCleanSample(unittest.TestCase):
    def test_public_sample_passes_schema_validation(self):
        self.assertEqual(validate_schema(SAMPLE_CSV_DIR), [])


class TestSchemaValidationRenamedColumn(unittest.TestCase):
    """TASKS.md 3.2: deliberately rename one column in a test copy; utility aborts with a clear,
    specific error, does not partial-load."""

    def setUp(self):
        self.tmp_dir = Path(tempfile.mkdtemp())
        for table in TABLES:
            shutil.copy(SAMPLE_CSV_DIR / table.csv_file, self.tmp_dir / table.csv_file)

    def tearDown(self):
        shutil.rmtree(self.tmp_dir)

    def _rename_column(self, csv_file, old_name, new_name):
        path = self.tmp_dir / csv_file
        with open(path, encoding="utf-8", newline="") as f:
            rows = list(csv.reader(f))
        rows[0] = [new_name if c == old_name else c for c in rows[0]]
        with open(path, "w", encoding="utf-8", newline="") as f:
            csv.writer(f).writerows(rows)

    def test_renamed_required_column_reported_specifically(self):
        self._rename_column("Workers.csv", "Legal_Name", "Full_Name")
        errors = validate_schema(self.tmp_dir)
        self.assertEqual(len(errors), 1)
        csv_file, missing = errors[0]
        self.assertEqual(csv_file, "Workers.csv")
        self.assertIn("Legal_Name", missing)

    def test_missing_file_reported_as_not_found(self):
        (self.tmp_dir / "Manager_Directory.csv").unlink()
        errors = validate_schema(self.tmp_dir)
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0][0], "Manager_Directory.csv")
        self.assertIn("<file not found>", errors[0][1])

    def test_clean_copy_still_passes(self):
        self.assertEqual(validate_schema(self.tmp_dir), [])


class TestNormalizeRow(unittest.TestCase):
    def setUp(self):
        self.policy = load_policy_config()
        self.workers_table = next(t for t in TABLES if t.airtable_table == "Workers")

    def test_name_field_title_cased_and_trimmed(self):
        row = {"Legal_Name": "faizal  nair ", "Employee_ID": "EMP1"}
        fields, flags = normalize_row(self.workers_table, row, self.policy)
        self.assertEqual(fields["Legal_Name"], "Faizal Nair")
        self.assertEqual(flags, [])

    def test_valid_date_normalized_to_iso(self):
        row = {"Hire_Date": "15/07/2026"}
        fields, flags = normalize_row(self.workers_table, row, self.policy)
        self.assertEqual(fields["Hire_Date"], "2026-07-15")
        self.assertEqual(flags, [])

    def test_unparseable_date_preserved_raw_and_flagged(self):
        row = {"Hire_Date": "not a date"}
        fields, flags = normalize_row(self.workers_table, row, self.policy)
        self.assertEqual(fields["Hire_Date"], "not a date")
        self.assertEqual(len(flags), 1)
        self.assertIn("Hire_Date", flags[0])

    def test_blank_date_omitted_not_flagged(self):
        row = {"Hire_Date": ""}
        fields, flags = normalize_row(self.workers_table, row, self.policy)
        self.assertNotIn("Hire_Date", fields)
        self.assertEqual(flags, [])

    def test_valid_numeric_coerced(self):
        row = {"FTE": "0.8"}
        fields, flags = normalize_row(self.workers_table, row, self.policy)
        self.assertEqual(fields["FTE"], 0.8)
        self.assertEqual(flags, [])

    def test_invalid_numeric_omitted_and_flagged(self):
        row = {"FTE": "full-time"}
        fields, flags = normalize_row(self.workers_table, row, self.policy)
        self.assertNotIn("FTE", fields)
        self.assertEqual(len(flags), 1)
        self.assertIn("FTE", flags[0])

    def test_boolean_values_coerced_without_guessing(self):
        peakon_table = next(t for t in TABLES if t.airtable_table == "Peakon_Engagement")
        fields, flags = normalize_row(peakon_table, {"x_confidential": "true"}, self.policy)
        self.assertEqual(fields["x_confidential"], True)
        self.assertEqual(flags, [])

        fields, flags = normalize_row(peakon_table, {"x_confidential": "unknown"}, self.policy)
        self.assertNotIn("x_confidential", fields)
        self.assertIn("x_confidential", flags[0])

    def test_opaque_id_never_title_cased(self):
        row = {"Employee_ID": " emp7000 "}
        fields, _ = normalize_row(self.workers_table, row, self.policy)
        self.assertEqual(fields["Employee_ID"], "emp7000")


class TestInFileDuplicateCollapsing(unittest.TestCase):
    """DATA_FLOW.md §6/§9: exact-natural-key duplicate rows within one seed file are deduped by
    exact match as part of the loader's own logic (distinct from cross-run Airtable upsert)."""

    def setUp(self):
        self.tmp_dir = Path(tempfile.mkdtemp())
        self.policy = load_policy_config()
        self.table = next(t for t in TABLES if t.airtable_table == "Manager_Directory")

    def tearDown(self):
        shutil.rmtree(self.tmp_dir)

    def _write_csv(self, rows):
        path = self.tmp_dir / "Manager_Directory.csv"
        with open(path, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=self.table.columns)
            writer.writeheader()
            writer.writerows(rows)
        return path

    def test_duplicate_natural_key_collapses_to_one_record(self):
        self._write_csv([
            {"Manager_WID": "MGR1", "Employee_ID": "EMP1", "Name": "Kevin Goh", "Email_Work": "a@x.com", "Org": "Sales"},
            {"Manager_WID": "MGR1", "Employee_ID": "EMP1", "Name": "Kevin Goh", "Email_Work": "a@x.com", "Org": "Sales"},
            {"Manager_WID": "MGR2", "Employee_ID": "EMP2", "Name": "Lena Abdullah", "Email_Work": "b@x.com", "Org": "Ops"},
        ])
        report = build_report()
        records = load_table(self.table, self.tmp_dir, self.policy, report)
        self.assertEqual(len(records), 2)
        self.assertEqual(report["deduped"]["Manager_Directory"], 1)

    def test_blank_natural_key_excluded_and_flagged(self):
        self._write_csv([
            {"Manager_WID": "", "Employee_ID": "EMP1", "Name": "Kevin Goh", "Email_Work": "a@x.com", "Org": "Sales"},
            {"Manager_WID": "MGR2", "Employee_ID": "EMP2", "Name": "Lena Abdullah", "Email_Work": "b@x.com", "Org": "Ops"},
        ])
        report = build_report()
        records = load_table(self.table, self.tmp_dir, self.policy, report)
        self.assertEqual(len(records), 1)
        self.assertEqual(report["missing_key"]["Manager_Directory"], 1)


class TestFullPublicSampleLoadsCleanly(unittest.TestCase):
    """TASKS.md 3.1 acceptance: loads the public sample dataset cleanly."""

    def test_all_tables_load_without_crashing(self):
        policy = load_policy_config()
        report = build_report()
        for table in TABLES:
            records = load_table(table, SAMPLE_CSV_DIR, policy, report)
            self.assertGreater(len(records), 0, table.airtable_table)
        self.assertEqual(report["missing_key"].get("Workers", 0), 0)


if __name__ == "__main__":
    unittest.main()
