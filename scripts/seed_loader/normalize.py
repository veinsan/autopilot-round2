"""Text and date normalization rules — reference implementation.

This module is the executable form of the normalization rule set specified in
docs/OPERATORS.md (OP-01 Business Logic steps 1-2), docs/DATA_FLOW.md section 3,
and docs/DECISIONS.md ADR-011. The reseeding utility (docs/DATA_FLOW.md section 6)
imports it directly; the no-code Auto Operators (OP-01/OP-02/OP-03) reimplement the
same rules independently, per ADR-006's "one documented rule set, two
implementations" framing.

Load-bearing properties (do not weaken without reading ADR-011):
- A date that cannot be parsed returns an explicit UNPARSEABLE result, never a
  guessed value.
- Purely numeric day/month-ambiguous dates (e.g. 10/07/2026, 10-07-2026,
  10.07.2026 — any of the three common separators) are interpreted under the
  single declared ``normalization.ambiguous_numeric_date_order`` config value,
  never guessed per-value. A value invalid under the declared order but valid
  under the alternate order returns AMBIGUOUS (escalate), never a silent
  reinterpretation. Whitespace around the separator (``15 / 07 / 2026``) is
  tolerated the same way trailing/internal whitespace is elsewhere.
  Note: a value valid under BOTH orders (e.g. 03/04/2026) is intentionally
  NOT escalated — it is accepted under the declared order. ADR-011's prose
  names 03/04/2026 as a "genuinely ambiguous" example, but the config's whole
  purpose is to pick one convention and apply it consistently; escalating
  every day<=12 numeric date (a large fraction of the real dataset, confirmed
  by TestFullPublicSampleParses) would flood the Workbench with false
  escalations for dates that are unambiguous under the declared convention.
  See test_normalize.py::TestAmbiguousNumericDateOrderPolicy, which encodes
  this as the deliberate, tested behavior.
- All parsed dates are truncated to day granularity (docs/DATA_FLOW.md section 9,
  timezone row).
- Blank is a distinct, meaningful state (e.g. blank Submitted_At = non-response),
  not an error.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Optional, Sequence

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POLICY_CONFIG_PATH = _REPO_ROOT / "config" / "policy_config.json"

# Matches a purely numeric D-M-Y / M-D-Y date under any of the three common
# separators. Deliberately does NOT match a year-first ISO date (2026-06-15):
# the first group is capped at 2 digits, so a 4-digit leading year can never
# satisfy it — no overlap with the strptime formats tried afterward.
_AMBIGUOUS_NUMERIC_DATE_RE = re.compile(r"^(\d{1,2})([/\-.])(\d{1,2})\2(\d{4})$")
_SEPARATOR_SPACING_RE = re.compile(r"\s*([/\-.])\s*")
_WHITESPACE_RE = re.compile(r"\s+")


def load_policy_config(path: Optional[Path] = None) -> dict:
    """Load the versioned policy_config reference export."""
    with open(path or _POLICY_CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def _default_normalization() -> dict:
    return load_policy_config()["normalization"]


def normalize_text(value: Optional[str]) -> str:
    """Trim and collapse internal whitespace (trailing-whitespace trap type)."""
    if value is None:
        return ""
    return _WHITESPACE_RE.sub(" ", value).strip()


def normalize_name(value: Optional[str]) -> str:
    """normalize_text plus title-casing, per OP-01 Business Logic step 1."""
    text = normalize_text(value)
    return " ".join(word.capitalize() for word in text.split(" ")) if text else ""


class ParseStatus(Enum):
    OK = "ok"
    BLANK = "blank"
    UNPARSEABLE = "unparseable"
    AMBIGUOUS = "ambiguous"


@dataclass(frozen=True)
class DateParseResult:
    status: ParseStatus
    value: Optional[date]
    raw: str
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.status is ParseStatus.OK


def _parse_numeric_date(day_part: int, month_part: int, year: int) -> Optional[date]:
    try:
        return date(year, month_part, day_part)
    except ValueError:
        return None


def parse_date(
    value: Optional[str],
    formats: Optional[Sequence[str]] = None,
    ambiguous_numeric_date_order: Optional[str] = None,
) -> DateParseResult:
    """Parse a date string per ADR-011; never guess, never crash.

    ``formats`` and ``ambiguous_numeric_date_order`` default to the values in
    config/policy_config.json (``normalization`` block) so behavior is
    config-driven, not hardcoded.
    """
    raw = "" if value is None else str(value)
    text = normalize_text(raw)
    if not text:
        return DateParseResult(ParseStatus.BLANK, None, raw)
    # Tolerate whitespace hugging a separator ("15 / 07 / 2026") uniformly,
    # both for the ambiguous-numeric-date check below and for strptime.
    text = _SEPARATOR_SPACING_RE.sub(r"\1", text)

    if formats is None or ambiguous_numeric_date_order is None:
        defaults = _default_normalization()
        formats = defaults["date_formats_accepted"] if formats is None else formats
        if ambiguous_numeric_date_order is None:
            ambiguous_numeric_date_order = defaults["ambiguous_numeric_date_order"]
    ambiguous_numeric_date_order = ambiguous_numeric_date_order.upper()
    if ambiguous_numeric_date_order not in ("DMY", "MDY"):
        raise ValueError(
            f"ambiguous_numeric_date_order must be 'DMY' or 'MDY', got {ambiguous_numeric_date_order!r}"
        )

    # Numeric-only dates (D-M-Y / M-D-Y, any of /, -, . as separator) are
    # ambiguous per-value and must never be guessed.
    ambiguous = _AMBIGUOUS_NUMERIC_DATE_RE.match(text)
    if ambiguous:
        first, _sep, second, year = ambiguous.group(1), ambiguous.group(2), ambiguous.group(3), ambiguous.group(4)
        first, second, year = int(first), int(second), int(year)
        if ambiguous_numeric_date_order == "DMY":
            declared = _parse_numeric_date(first, second, year)
            alternate = _parse_numeric_date(second, first, year)
        else:
            declared = _parse_numeric_date(second, first, year)
            alternate = _parse_numeric_date(first, second, year)
        if declared is not None:
            return DateParseResult(ParseStatus.OK, declared, raw)
        if alternate is not None:
            return DateParseResult(
                ParseStatus.AMBIGUOUS,
                None,
                raw,
                detail=(
                    f"invalid under declared ambiguous_numeric_date_order={ambiguous_numeric_date_order} "
                    "but valid under the alternate order; escalating rather than silently reinterpreting"
                ),
            )
        return DateParseResult(
            ParseStatus.UNPARSEABLE, None, raw, detail="not a valid calendar date under either numeric-date order"
        )

    for fmt in formats:
        try:
            parsed = datetime.strptime(text, fmt)
        except ValueError:
            continue
        return DateParseResult(ParseStatus.OK, parsed.date(), raw)

    return DateParseResult(
        ParseStatus.UNPARSEABLE, None, raw, detail="no accepted format matched; see normalization.date_formats_accepted"
    )
