"""Unit tests for fuzzy_dedup.py against TASKS.md 0.2.3 acceptance criteria.

Acceptance: a similarity score for name pairs with casing/whitespace/
minor-spelling variance, tested against at least 5 hand-crafted variant pairs
and 5 hand-crafted genuinely-different-person pairs, with ZERO false merges in
the latter set (ADR-012's costliest failure mode, RISKS.md R-03).
"""

import unittest
from datetime import date

from fuzzy_dedup import DedupDecision, classify_candidate, name_similarity
from normalize import ParseStatus, load_policy_config, parse_date

# Same person, formatting/typo variants (casing, padding, doubled whitespace,
# missing letter, word order) — should auto-merge.
VARIANT_PAIRS = [
    ("Faizal Nair", "faizal nair "),
    ("Faizal  Nair", "Faizal Nair"),
    ("Lena Abdullah", "Lena Abdulah"),
    ("NUR AISYAH RAHMAN", "Nur Aisyah Rahman"),
    ("Goh Kevin", "Kevin Goh"),
]

# Genuinely different people — must NEVER classify as "merge".
DIFFERENT_PERSON_PAIRS = [
    ("Faizal Nair", "Faizal Tan"),
    ("Kevin Goh", "Kevin Teo"),
    ("Lena Abdullah", "Wan Abdullah"),
    ("Anjali Prakash", "Anjali Pillai"),
    ("Tariq Ong", "Tariq Wong"),
]


class TestNameSimilarity(unittest.TestCase):
    def test_scores_are_bounded(self):
        for a, b in VARIANT_PAIRS + DIFFERENT_PERSON_PAIRS:
            score = name_similarity(a, b)
            self.assertGreaterEqual(score, 0.0)
            self.assertLessEqual(score, 1.0)

    def test_pure_formatting_variants_score_1(self):
        self.assertEqual(name_similarity("Faizal Nair", " faizal  nair "), 1.0)
        self.assertEqual(name_similarity("Goh Kevin", "Kevin Goh"), 1.0)

    def test_empty_or_missing_names_score_0(self):
        self.assertEqual(name_similarity("", "Faizal Nair"), 0.0)
        self.assertEqual(name_similarity(None, None), 0.0)
        self.assertEqual(name_similarity("   ", "x"), 0.0)


class TestVariantPairsMerge(unittest.TestCase):
    def test_all_variant_pairs_auto_merge(self):
        for a, b in VARIANT_PAIRS:
            decision = classify_candidate(a, b)
            self.assertEqual(decision.action, "merge", (a, b, decision))


class TestZeroFalseMerges(unittest.TestCase):
    def test_no_different_person_pair_ever_merges(self):
        for a, b in DIFFERENT_PERSON_PAIRS:
            decision = classify_candidate(a, b)
            self.assertNotEqual(decision.action, "merge", (a, b, decision))

    def test_clearly_different_people_classify_as_new(self):
        for a, b in DIFFERENT_PERSON_PAIRS[:4]:
            decision = classify_candidate(a, b)
            self.assertEqual(decision.action, "new", (a, b, decision))


class TestReviewBand(unittest.TestCase):
    def test_partial_name_lands_in_human_review_band(self):
        # Missing middle name: genuinely ambiguous — the middle band exists
        # exactly for this (ADR-012: never a binary decision where least sure).
        decision = classify_candidate("Nur Aisyah Rahman", "Nur Rahman")
        self.assertEqual(decision.action, "review", decision)


class TestHireDateProximityGate(unittest.TestCase):
    def test_far_apart_identical_names_never_silently_merge_or_silently_new(self):
        # An exact name match months apart must never auto-merge (that would
        # be the costliest failure mode, RISKS.md R-03) but must also never
        # be silently waved through as "new" — it goes to human review.
        decision = classify_candidate(
            "Faizal Nair",
            "Faizal Nair",
            incoming_hire_date=date(2026, 8, 1),
            existing_hire_date=date(2026, 5, 1),
        )
        self.assertEqual(decision.action, "review", decision)

    def test_nearby_hire_dates_allow_merge(self):
        decision = classify_candidate(
            "Faizal Nair",
            "faizal nair ",
            incoming_hire_date=date(2026, 5, 26),
            existing_hire_date=date(2026, 5, 28),
        )
        self.assertEqual(decision.action, "merge", decision)

    def test_unknown_hire_dates_fall_back_to_name_bands(self):
        decision = classify_candidate("Faizal Nair", "faizal nair ")
        self.assertEqual(decision.action, "merge", decision)

    def test_far_apart_moderately_similar_names_are_new_not_review(self):
        # Outside the window with a score below the merge threshold: the
        # review-band escalation only fires for a near-exact name match
        # outside the window, not for merely-similar names.
        decision = classify_candidate(
            "Faizal Nair",
            "Faizal Tan",
            incoming_hire_date=date(2026, 8, 1),
            existing_hire_date=date(2026, 5, 1),
        )
        self.assertEqual(decision.action, "new", decision)


class TestRealDatasetFalseMergePairs(unittest.TestCase):
    """Regression coverage for two real, empirically-discovered pairs of
    genuinely different employees in the public sample who share an
    identical Legal_Name (dataset/csv/Workers.csv). An earlier
    dedup_hire_date_proximity_days=30 default would have auto-merged both —
    a live false merge. These are real data, not hand-crafted synthetic
    cases, and directly justify the tightened default (config/README.md)."""

    def test_faizal_cheng_emp7032_emp7059_never_merges(self):
        # EMP7032 hired 2026-07-25, EMP7059 hired 2026-07-08 — 17 days apart.
        decision = classify_candidate(
            "Faizal Cheng",
            "Faizal Cheng",
            incoming_hire_date=date(2026, 7, 25),
            existing_hire_date=date(2026, 7, 8),
        )
        self.assertNotEqual(decision.action, "merge", decision)
        self.assertEqual(decision.action, "review", decision)

    def test_tariq_raj_emp7038_emp7043_never_merges(self):
        # EMP7038 hired 2026-05-18, EMP7043 hired 2026-06-05 — 18 days apart.
        decision = classify_candidate(
            "Tariq Raj",
            "Tariq Raj",
            incoming_hire_date=date(2026, 6, 5),
            existing_hire_date=date(2026, 5, 18),
        )
        self.assertNotEqual(decision.action, "merge", decision)
        self.assertEqual(decision.action, "review", decision)

    def test_full_public_sample_never_produces_a_merge_verdict(self):
        # Defense in depth: run the classifier over every same-name pair in
        # the real 60-worker sample (bulk loader never calls this in
        # practice, per the OP-01 scope note — but if OP-01's live intake
        # path later re-processes one of these same names, it must not
        # auto-merge two people who are already known-distinct).
        import csv
        from pathlib import Path

        csv_dir = Path(__file__).resolve().parents[2] / "dataset" / "csv"
        with open(csv_dir / "Workers.csv", encoding="utf-8") as f:
            workers = list(csv.DictReader(f))

        normalization = load_policy_config()["normalization"]

        def parse(d):
            result = parse_date(
                d,
                normalization["date_formats_accepted"],
                normalization["ambiguous_numeric_date_order"],
            )
            self.assertIs(result.status, ParseStatus.OK, (d, result))
            return result.value

        merges = []
        for i in range(len(workers)):
            for j in range(i + 1, len(workers)):
                a, b = workers[i], workers[j]
                decision = classify_candidate(
                    a["Legal_Name"],
                    b["Legal_Name"],
                    incoming_hire_date=parse(a["Hire_Date"]),
                    existing_hire_date=parse(b["Hire_Date"]),
                )
                if decision.action == "merge":
                    merges.append((a["Employee_ID"], b["Employee_ID"], decision))
        self.assertEqual(merges, [])


class TestConfigDriven(unittest.TestCase):
    def test_default_thresholds_come_from_policy_config(self):
        thresholds = load_policy_config()["thresholds"]
        self.assertIn("dedup_confidence_threshold", thresholds)
        self.assertIn("dedup_flag_band_low", thresholds)
        self.assertIn("dedup_hire_date_proximity_days", thresholds)
        # Tightening the merge bar via config (not code) must change behavior:
        strict = dict(thresholds, dedup_confidence_threshold=0.99)
        decision = classify_candidate("Lena Abdullah", "Lena Abdulah", thresholds=strict)
        self.assertEqual(decision.action, "review", decision)

    def test_decision_shape(self):
        decision = classify_candidate("Faizal Nair", "Faizal Tan")
        self.assertIsInstance(decision, DedupDecision)
        self.assertTrue(decision.detail)
        self.assertGreaterEqual(decision.confidence, 0.0)
        self.assertLessEqual(decision.confidence, 1.0)


if __name__ == "__main__":
    unittest.main()
