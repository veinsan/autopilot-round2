"""Fuzzy name-variant dedup rules — reference implementation.

Executable form of the identity-resolution rule set in docs/OPERATORS.md
(OP-01 Business Logic step 4) and docs/DECISIONS.md ADR-012. Scope note
(ADR-006 amendment): this logic belongs to OP-01's *live Typeform intake path*
only — the bulk reseeding utility must NOT run it against seed rows (seed
workers are already distinct; it dedups only exact Employee_ID duplicates).
This module exists as the tested reference the no-code OP-01 workflow mirrors.

Three-band decision per ADR-012, thresholds from config/policy_config.json:
- score >= dedup_confidence_threshold           -> "merge"  (update existing row)
- dedup_flag_band_low <= score < threshold      -> "review" (escalate to a human)
- score < dedup_flag_band_low                   -> "new"    (confidently a new hire)

Hire_Date proximity gate (config dedup_hire_date_proximity_days, default 3):
a tight window meant to catch an accidental re-submission of the *same*
intake event, not "hired in the same general cohort" — two different people
sharing a name and starting weeks apart is a normal, expected case, not an
anomaly, and must never auto-merge just because both are true. This is
empirically grounded, not guessed: the public sample itself contains two
pairs of genuinely different employees with an identical Legal_Name —
EMP7032/EMP7059 ("Faizal Cheng", 17 days apart) and EMP7038/EMP7043
("Tariq Raj", 18 days apart). Outside the window, an exact/near-exact name
match is downgraded to "review" (never a silent "merge", and never a silent
"new" either — see classify_candidate). A false merge is the costliest
failure mode in the whole system (RISKS.md R-03).

Open-source usage (MASTER_PLAN.md section 4.5): string similarity is computed
with the rapidfuzz library when available, with a stdlib difflib fallback so
the rule set itself never depends on the environment.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional

from normalize import load_policy_config, normalize_name

try:
    from rapidfuzz import fuzz as _rapidfuzz

    def _ratio(a: str, b: str) -> float:
        return _rapidfuzz.ratio(a, b) / 100.0

    SIMILARITY_BACKEND = "rapidfuzz"
except ImportError:  # pragma: no cover - exercised only where rapidfuzz is absent
    from difflib import SequenceMatcher

    def _ratio(a: str, b: str) -> float:
        return SequenceMatcher(None, a, b).ratio()

    SIMILARITY_BACKEND = "difflib"


def name_similarity(a: Optional[str], b: Optional[str]) -> float:
    """Similarity in [0, 1] between two person names.

    Casing, padding, and internal whitespace are normalized away and word
    order is ignored (sorted tokens), so pure formatting variants score 1.0.
    When both names have the same token count, the score is capped by the
    weakest aligned token — so a single clearly-different word (a different
    surname) cannot be washed out by an otherwise-long identical string.
    """
    norm_a = normalize_name(a).casefold()
    norm_b = normalize_name(b).casefold()
    if not norm_a or not norm_b:
        return 0.0
    tokens_a = sorted(norm_a.split(" "))
    tokens_b = sorted(norm_b.split(" "))
    score = _ratio(" ".join(tokens_a), " ".join(tokens_b))
    if len(tokens_a) == len(tokens_b):
        # Pair every token with its best counterpart, then cap the score by the
        # weakest such pairing. Best-match pairing (not sorted-position zip) so
        # a typo that shifts a token's sort position cannot mispair tokens.
        weakest_token = min(
            min(
                max(_ratio(x, y) for y in other)
                for x in tokens
            )
            for tokens, other in ((tokens_a, tokens_b), (tokens_b, tokens_a))
        )
        score = min(score, weakest_token)
    return score


@dataclass(frozen=True)
class DedupDecision:
    action: str  # "merge" | "review" | "new"
    confidence: float
    detail: str


def classify_candidate(
    incoming_name: Optional[str],
    existing_name: Optional[str],
    incoming_hire_date: Optional[date] = None,
    existing_hire_date: Optional[date] = None,
    thresholds: Optional[dict] = None,
) -> DedupDecision:
    """Decide merge / review / new for one incoming record vs one existing row.

    Thresholds default to config/policy_config.json ``thresholds``.

    Hire-date proximity is a precondition for auto-merge, not merely a
    disqualifier applied after the fact: ``dedup_hire_date_proximity_days``
    exists to catch an accidental re-submission of the *same* intake event
    (a coordinator submits twice, or resubmits after fixing a typo), which
    should differ by days, not weeks — it is not evidence that two
    similarly-named people are the same person. The public sample itself
    proves this distinction matters: it contains two pairs of genuinely
    different employees sharing an identical Legal_Name, hired 17 and 18
    days apart (see config/README.md). So:

    - Hire dates within the window (or unknown) -> normal similarity banding.
    - Hire dates known and OUTSIDE the window:
        - name similarity still >= the merge threshold -> "review", never a
          silent "merge" (an identical/near-identical name is worth a
          person's attention regardless of the date gap) and never a silent
          "new" either (that would bury the coincidence entirely).
        - otherwise -> "new", as before.
    """
    if thresholds is None:
        thresholds = load_policy_config()["thresholds"]
    merge_threshold = thresholds["dedup_confidence_threshold"]
    flag_band_low = thresholds["dedup_flag_band_low"]
    proximity_days = thresholds["dedup_hire_date_proximity_days"]

    score = name_similarity(incoming_name, existing_name)

    dates_far_apart = False
    days_apart = None
    if incoming_hire_date is not None and existing_hire_date is not None:
        days_apart = abs((incoming_hire_date - existing_hire_date).days)
        dates_far_apart = days_apart > proximity_days

    if dates_far_apart:
        if score >= merge_threshold:
            return DedupDecision(
                "review",
                score,
                f"name similarity {score:.3f} meets the auto-merge bar on its own, but hire "
                f"dates are {days_apart} days apart (window: {proximity_days}) — never "
                "auto-merge on name alone this far apart; escalate for a human to confirm "
                "these are (or are not) the same person",
            )
        return DedupDecision(
            "new",
            score,
            f"hire dates {days_apart} days apart exceed the {proximity_days}-day proximity "
            f"window and name similarity {score:.3f} is below the merge threshold; treated "
            "as a different person",
        )

    if score >= merge_threshold:
        return DedupDecision(
            "merge", score, f"name similarity {score:.3f} >= {merge_threshold} auto-merge threshold"
        )
    if score >= flag_band_low:
        return DedupDecision(
            "review",
            score,
            f"name similarity {score:.3f} in the ambiguous band "
            f"[{flag_band_low}, {merge_threshold}); escalate for human confirmation",
        )
    return DedupDecision(
        "new", score, f"name similarity {score:.3f} below {flag_band_low}; confidently a new hire"
    )
