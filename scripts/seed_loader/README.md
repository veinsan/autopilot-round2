# Reseeding Utility (`scripts/seed_loader/`)

Local, team-operated utility specified in `docs/DATA_FLOW.md` §6 and `docs/DECISIONS.md` ADR-006:
a schema-driven (column-name-mapped) loader that seeds Supabase (the sole system of record — Airtable is
fully deprecated, `docs/DECISIONS.md` ADR-001 second amendment; no Airtable credentials are required to
run it) from a dataset export and can be re-run live against a fresh dataset for the demo's
hidden-dataset proof (`docs/DEMO.md` Beat 6). `schema.py`'s per-table `TableSchema.backend` is kept only
for a possible future re-split, not because anything currently routes elsewhere.

## Contents

| File | Backlog task | Role |
|---|---|---|
| `normalize.py` | `TASKS.md` 0.2.2 | Text + multi-format date normalization rules (ADR-011). Never guesses a date; blank / unparseable / ambiguous are explicit statuses. |
| `fuzzy_dedup.py` | `TASKS.md` 0.2.3 | Fuzzy name-variant dedup rules (ADR-012), three bands: merge / review / new. **Live OP-01 intake rule set only** — the bulk loader never runs it against seed rows (ADR-006 amendment). |
| loader itself | `TASKS.md` 3.1–3.2 | Not yet built (Phase 3). |

These modules are the executable reference for the rule set the no-code Auto Operators
(OP-01/OP-02/OP-03) implement independently — one documented specification, two implementations
(`docs/DECISIONS.md` ADR-006 amendment). Change the rules here only in lockstep with
`docs/OPERATORS.md` and the Auto workflows.

All tunable values come from `config/policy_config.json` (`normalization` and `thresholds` blocks) —
never hardcoded (`docs/ARCHITECTURE.md` §7).

## Setup & tests

```sh
pip3 install -r requirements.txt   # rapidfuzz (optional; difflib fallback exists)
cd scripts/seed_loader
python3 -m unittest discover -v
```
