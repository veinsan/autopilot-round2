"""Unit tests for normalize.py against TASKS.md 0.2.2 acceptance criteria.

All expectations are pinned/deterministic; no wall-clock dependence
(ARCHITECTURE.md section 5).
"""

import csv
import unittest
from datetime import date
from pathlib import Path

from normalize import (
    DateParseResult,
    ParseStatus,
    normalize_name,
    normalize_text,
    parse_date,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CSV_DIR = REPO_ROOT / "dataset" / "csv"

DATE_COLUMNS = {
    "Workers.csv": ["Hire_Date"],
    "Onboarding_Tasks.csv": ["Due_Date", "Completed_Date"],
    "Provisioning_Integration.csv": ["Requested_On", "Fulfilled_On"],
    "Peakon_Engagement.csv": ["Submitted_At"],
}


class TestNormalizeText(unittest.TestCase):
    def test_trailing_whitespace_trap(self):
        self.assertEqual(normalize_text("faizal nair "), "faizal nair")

    def test_internal_whitespace_collapsed(self):
        self.assertEqual(normalize_text("Faizal  Nair"), "Faizal Nair")

    def test_none_and_blank(self):
        self.assertEqual(normalize_text(None), "")
        self.assertEqual(normalize_text("   "), "")

    def test_name_title_casing(self):
        self.assertEqual(normalize_name("faizal nair "), "Faizal Nair")
        self.assertEqual(normalize_name("LENA  ABDULLAH"), "Lena Abdullah")


class TestKnownSampleFormats(unittest.TestCase):
    """The 3 formats documented in CONTEXT.md section 12.4."""

    def test_iso_datetime(self):
        self.assertEqual(parse_date("2026-06-15 00:00:00").value, date(2026, 6, 15))

    def test_dd_mm_yyyy(self):
        self.assertEqual(parse_date("15/07/2026").value, date(2026, 7, 15))

    def test_month_name(self):
        self.assertEqual(parse_date("Jun 21 2026").value, date(2026, 6, 21))

    def test_iso_date_only(self):
        self.assertEqual(parse_date("2026-05-26").value, date(2026, 5, 26))


class TestUnseenFormats(unittest.TestCase):
    """At least 2 formats not present in the public sample (TASKS.md 0.2.2)."""

    def test_slash_iso(self):
        self.assertEqual(parse_date("2026/06/15").value, date(2026, 6, 15))

    def test_full_month_name_with_comma(self):
        self.assertEqual(parse_date("June 21, 2026").value, date(2026, 6, 21))

    def test_day_first_month_name(self):
        self.assertEqual(parse_date("21 Jun 2026").value, date(2026, 6, 21))

    def test_iso_with_t_separator(self):
        self.assertEqual(parse_date("2026-06-15T00:00:00").value, date(2026, 6, 15))

    def test_iso_with_t_separator_and_microseconds(self):
        self.assertEqual(parse_date("2026-06-15T00:00:00.123456").value, date(2026, 6, 15))

    def test_datetime_without_seconds(self):
        self.assertEqual(parse_date("2026-06-15 00:00").value, date(2026, 6, 15))

    def test_datetime_with_microseconds_space_separator(self):
        self.assertEqual(parse_date("2026-06-15 00:00:00.123456").value, date(2026, 6, 15))


class TestAmbiguousNumericDateOrderPolicy(unittest.TestCase):
    """ADR-011 + config/README.md: declared order, never a per-value guess.

    Covers all 3 common separators (/, -, .) since the hidden dataset is not
    guaranteed to reuse the public sample's specific one.
    """

    def test_numerically_ambiguous_value_uses_declared_dmy_order(self):
        # 10/07/2026 exists in the public sample's Submitted_At column.
        self.assertEqual(parse_date("10/07/2026").value, date(2026, 7, 10))

    def test_dash_separated_ambiguous_date(self):
        self.assertEqual(parse_date("10-07-2026").value, date(2026, 7, 10))

    def test_dot_separated_ambiguous_date(self):
        self.assertEqual(parse_date("10.07.2026").value, date(2026, 7, 10))

    def test_whitespace_padded_separator(self):
        self.assertEqual(parse_date("15 / 07 / 2026").value, date(2026, 7, 15))
        self.assertEqual(parse_date("15 - 07 - 2026").value, date(2026, 7, 15))

    def test_contradicts_declared_order_escalates_as_ambiguous(self):
        # Valid only as MM/DD (Jul 25) — must escalate, never silently swap.
        for value in ("07/25/2026", "07-25-2026", "07.25.2026"):
            result = parse_date(value)
            self.assertIs(result.status, ParseStatus.AMBIGUOUS, value)
            self.assertIsNone(result.value, value)

    def test_mdy_order_when_configured(self):
        self.assertEqual(
            parse_date("07/25/2026", ambiguous_numeric_date_order="MDY").value, date(2026, 7, 25)
        )

    def test_invalid_under_both_orders_is_unparseable(self):
        result = parse_date("99/99/2026")
        self.assertIs(result.status, ParseStatus.UNPARSEABLE)
        self.assertIsNone(result.value)

    def test_iso_year_first_date_never_treated_as_ambiguous(self):
        # A 4-digit leading year can never satisfy the 1-2 digit first group
        # of the ambiguous-date pattern — must go through strptime instead.
        self.assertEqual(parse_date("2026-06-15").value, date(2026, 6, 15))
        self.assertEqual(parse_date("2026 - 06 - 15").value, date(2026, 6, 15))


class TestNeverGuess(unittest.TestCase):
    def test_garbage_is_unparseable_not_a_guess(self):
        for garbage in ["not a date", "2026-13-45", "Febtember 3 2026", "12345", "--"]:
            result = parse_date(garbage)
            self.assertIs(result.status, ParseStatus.UNPARSEABLE, garbage)
            self.assertIsNone(result.value, garbage)

    def test_blank_is_a_distinct_meaningful_state(self):
        # Blank Submitted_At = non-response (Field_Dictionary.csv), not an error.
        for blank in [None, "", "   "]:
            self.assertIs(parse_date(blank).status, ParseStatus.BLANK)

    def test_whitespace_padding_still_parses(self):
        self.assertEqual(parse_date("  15/07/2026  ").value, date(2026, 7, 15))

    def test_result_shape(self):
        result = parse_date("garbage")
        self.assertIsInstance(result, DateParseResult)
        self.assertFalse(result.ok)
        self.assertTrue(result.detail)


class TestFullPublicSampleParses(unittest.TestCase):
    """Every non-blank date in every date column of the public sample must
    parse cleanly under the default config — a precondition for TASKS.md 3.1
    ("loads the public sample dataset cleanly")."""

    def test_all_sample_dates_parse(self):
        failures = []
        for filename, columns in DATE_COLUMNS.items():
            with open(CSV_DIR / filename, encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    for column in columns:
                        result = parse_date(row[column])
                        if result.status not in (ParseStatus.OK, ParseStatus.BLANK):
                            failures.append((filename, column, row[column], result.status))
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
