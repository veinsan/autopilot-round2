# `policy_config` v1.0 — Reference Export

This file documents `policy_config.json`, the **versioned reference export** of the policy
configuration defined in `docs/ARCHITECTURE.md` §7. Per that section, the **canonical, live copy is a
Supabase table** (originally Airtable — created in `docs/TASKS.md` 0.1.1/0.2.1, migrated per `0.1.5` and
`docs/DECISIONS.md` ADR-001's amendment) so a business user can edit it without touching code; this JSON
exists for documentation, diffing, and as the source the seeding utility and tests read locally. Keep the
two in sync — the JSON is the reviewed record, the Supabase table is the runtime surface, seeded by
`scripts/seed_loader/seed_policy_config.py`.

JSON cannot carry comments, so the one-line justification for every default (required by
`docs/TASKS.md` 0.2.1 and `docs/MASTER_PLAN.md` §14) lives here. Justifications are transcribed from
`docs/OPERATORS.md` per-Operator "Configurable Parameters" tables and `docs/ARCHITECTURE.md` §5/§7 —
transcribed, not re-derived.

## Top-level fields

| Field | Default | Justification |
|---|---|---|
| `version` | `"1.0"` | Versioned so any change can be diffed and audited (`ARCHITECTURE.md` §9, auditability bonus). |
| `as_of_date` | `null` | `null` = live wall-clock "now" (production behavior). Pinned to a fixed ISO date only for automated tests and the demo recording — never an implicit `now()` inside Operator logic (`ARCHITECTURE.md` §5, `DECISIONS.md` ADR-014). |
| `demo_mode` | `false` | When `true`, write-side Operators (OP-01, OP-04) read `retry_demo_profile` instead of `retry`, eliminating up-to-85s of backoff dead air during a live take (`TASKS.md` 0.2.4, `RISKS.md` R-23). Production behavior unaffected when off. |

## `thresholds`

| Field | Default | Owner | Justification |
|---|---|---|---|
| `provisioning_blocked_grace_days` | `1` | OP-02 | Day-one access should exist by end of Day 1; 1 day grace absorbs timezone/EOD ambiguity. |
| `task_stalled_overdue_days` | `3` | OP-02 | 3 days past due is late enough to be a real signal, short enough to still be actionable before the next milestone. |
| `compliance_step_terms` | 2-item list | OP-02 | Explicit list, not a substring match, so the rule survives a hidden dataset that renames or adds compliance-related steps — extend the list, not the Operator's logic (`DECISIONS.md` ADR-016). |
| `engagement_low_score` | `5` (of 0–10) | OP-03 | Below the midpoint; conservative enough to avoid flagging normal variance. |
| `disclosure_classifier_min_confidence` | `0.75` | OP-03 | High bar to auto-confirm; below it, fail-safe to human review rather than a coin-flip auto-decision. |
| `dedup_confidence_threshold` | `0.90` | OP-01 | High bar — a false merge (treating two real people as one) is worse than an extra escalation (`DECISIONS.md` ADR-012). |
| `dedup_flag_band_low` | `0.70` | OP-01 | Below this, treated as confidently a new hire; no escalation needed. Between the two bands → escalate for human confirmation. |
| `dedup_hire_date_proximity_days` | `3` | OP-01 | Implementation-defined per the ADR-016 pattern: `OPERATORS.md` §OP-01 step 4 requires "`Legal_Name` + `Hire_Date` proximity" without fixing the window. Deliberately tight, and empirically validated against the public sample, not guessed: the dataset itself contains two genuinely different employees sharing an identical `Legal_Name` — `EMP7032`/`EMP7059` ("Faizal Cheng", hired 17 days apart) and `EMP7038`/`EMP7043` ("Tariq Raj", hired 18 days apart). An earlier 30-day default would have auto-merged both pairs — a live false merge, the single worst failure mode per `RISKS.md` R-03. This window exists to catch an accidental re-submission of the *same* intake event (a coordinator submits twice, or resubmits after fixing a typo), which should differ by days, not weeks — not to catch "hired in the same general cohort," which two distinct same-named people routinely do. See `fuzzy_dedup.py`'s three-tier logic: dates within this window get normal name-similarity banding; an exact/near-exact name match *outside* the window never silently auto-merges but is downgraded to human review rather than silently discarded, since an identical name is still worth a person's attention regardless of date gap. |
| `catch_rate_sla_days` | `3` | OP-05 | Matches `task_stalled_overdue_days`, keeping the "did we act in time" bar consistent with the "is this task late" bar that generates the signal. |

## `normalization`

| Field | Default | Justification |
|---|---|---|
| `date_formats_accepted` | 13 `strptime` patterns | Covers the 3 formats observed in the public sample plus additional unseen formats, per `DECISIONS.md` ADR-011 and `TASKS.md` 0.2.2 acceptance criteria (a parser tuned only to visible formats is sample-tuning). Includes 3 ISO 8601 timestamp variants (`T` separator, with/without fractional seconds, no-seconds) not present in the public sample but common enough in real system exports to defend against proactively, since a harder hidden dataset is explicitly expected (`CONTEXT.md` §4.3–§4.5). Extendable without a code change if a new hidden-dataset format appears. All parsed dates are truncated to day granularity (`DATA_FLOW.md` §9, timezone row). Deliberately **not** extended for 2-digit years or ordinal day suffixes ("21st Jun 2026") — a 2-digit year is genuinely ambiguous about century (guessing one would violate ADR-011), and ordinal suffixes aren't plausible output from a structured Workday/Peakon system export (the sample's own dates are machine-generated, not hand-typed); both correctly fall through to UNPARSEABLE (escalate) rather than being papered over. |
| `ambiguous_numeric_date_order` | `"DMY"` | Purely numeric dates with no separator ambiguity check would be a bug: `10/07/2026`, `10-07-2026`, and `10.07.2026` are all inherently ambiguous between DD/MM and MM/DD regardless of which of the three separators is used, and the hidden dataset isn't guaranteed to reuse the sample's specific separator. Per ADR-011 the system never guesses per-value; the interpretation is this single declared, auditable config value — `DMY` because `CONTEXT.md` §12.4 documents the sample's slash format as DD/MM/YYYY (and the public sample contains slash dates with both components ≤ 12, which would otherwise all escalate and fail `TASKS.md` 3.1's "loads the sample cleanly"). A value invalid under the declared order but valid under the alternate order escalates as `AMBIGUOUS` — it is never silently reinterpreted. Whitespace hugging the separator (`15 / 07 / 2026`) is tolerated the same way trailing/internal whitespace is elsewhere in the system. |

## `routing`

| Field | Justification |
|---|---|
| `manager_channel_by_org` | One channel per `Manager_Directory.Org` value (5 values: Finance, Sales, Ops, Engineering, People) — **never** keyed on `Workers.Job_Family`, a different, non-corresponding taxonomy (`ARCHITECTURE.md` §6 "Manager-channel routing"). Values are placeholder channel names until `TASKS.md` 0.1.2 replaces them with the real Slack channel IDs. |
| `confidential_channel` | A single, access-restricted channel, deliberately **not** routed by `Org` — fragmenting confidential routing multiplies who can see sensitive material (`DECISIONS.md` ADR-002). |
| `it_escalation_channel` | Single IT-provisioning escalation channel (`TASKS.md` 0.1.2). |

## `templates`

Message copy for OP-04, interpolating **only non-sensitive fields** — `_internal_case_payload`
content must never appear in any rendered template (`OPERATORS.md` §OP-04, `DATA_FLOW.md` §7). The
`confidential_alert` template deliberately contains no disclosure content: the actual comment is
reachable only through the linked Workbench case (`INTEGRATIONS.md` §2 "Data Exchanged").

## `retry` / `retry_demo_profile`

| Field | Default | Justification |
|---|---|---|
| `retry` | 3 attempts, 5/20/60s backoff | Production default; absorbs Supabase rate limits and transient failures alike (`ARCHITECTURE.md` §7–§8). Airtable is fully deprecated (`DECISIONS.md` ADR-001 second amendment) — every write today targets Supabase, though the wrapper itself was never backend-specific. Exhausted retries always escalate, never silently drop (`OPERATORS.md` failure tables). |
| `retry_demo_profile` | 1 attempt, no backoff | Used only when `demo_mode` is on (demo recording): a live demo cannot afford up to 85s of dead air per failed write chain (`RISKS.md` R-23). |
