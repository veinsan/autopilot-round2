# STAGE_SUMMARY.md — Round 1 Implementation Summary

**What this document is:** a single-read summary of where the project stands at the end of the Round 1
build stage — what was implemented on the **Supervity Auto** platform, how the Orchestrator and the five
Operators actually work, what lives in this repo versus what lives in the Auto workspace, and every
credential/environment value the system needs (filled and unfilled).

**Audience:** anyone picking this project up cold — a teammate, a judge reading alongside the demo, or a
future Round 2 build. It summarizes; it does not replace `ARCHITECTURE.md` (design), `OPERATORS.md`
(spec), `TASKS.md` (task-level status), or `DECISIONS.md` (ADRs).

**Standard of proof used below:** every "verified" claim traces to a raw Auto **Activity Timeline /
Execution Log** entry or a locally-run test, never to a builder chat's prose summary of its own run —
see `DECISIONS.md` ADR-018 for why that distinction became a project-wide rule mid-build.

---

## 1. Executive Summary

The Round 1 AI Employee is **functionally complete and live**. It is a governed multi-agent system — one
Orchestrator (`ORCH-01`) coordinating five Operator Agents (`OP-01`–`OP-05`) — that monitors a 90-day
new-hire onboarding journey, detects onboarding/provisioning/engagement risk, acts automatically on clear
cases via Slack, and escalates every judgment call to a human at the Auto Workbench.

| Dimension | State at end of this stage |
|---|---|
| Operators built & saved in Auto | 5 of 6 units live (`OP-01`, `OP-02`, `OP-03`, `OP-04`, `ORCH-01`); `OP-05` descoped |
| Routing branches verified live | **5 of 5** distinct outcomes, each against real seeded data |
| System of record | **Supabase only** — all 7 tables; Airtable fully deprecated (ADR-001 second amendment) |
| Integrations live | Supabase (SoR) + Slack (channel) + Typeform (forms) = 3 integrations, 3 categories |
| Repo-side code | `scripts/seed_loader/` (reseeding utility + shared rule modules) + `config/` — **58/58 tests pass** |
| Qualification gate | All four criteria met and independently evidenced (see §7) |
| Remaining critical path | Phase 5 — demo recording, LinkedIn post, portal submission |

Two structural decisions define this stage more than any other: **(a)** the mid-build migration of every
table off Airtable onto Supabase, which collapsed the architecture to a single backend, and **(b)** the
discovery that Auto's AI-interpreted steps fabricate results when used for pure data plumbing, which
forced ORCH-01's merge/routing steps and OP-03's rule evaluation to be rebuilt as deterministic Code
steps (ADR-018).

---

## 2. Architecture at a Glance

```mermaid
flowchart TB
    subgraph Intake["Intake"]
        TF["Typeform<br/>(live, poll-based)"]
        SEED["Reseeding Utility<br/>(repo script, CSV → Supabase)"]
    end

    subgraph SB["Supabase — sole system of record (7 tables)"]
        WK["Workers"]
        MD["Manager_Directory"]
        PC["policy_config"]
        OT["Onboarding_Tasks"]
        PI["Provisioning_Integration"]
        PK["Peakon_Engagement"]
        CASE["Cases_Audit_Log"]
    end

    subgraph Auto["Supervity Auto workspace"]
        POLL["OP-01 Typeform Intake Poller<br/>(parent workflow)"]
        OP1["OP-01 Intake & Normalization"]
        ORCH["ORCH-01 Orchestrator"]
        OP2["OP-02 Onboarding & Provisioning Risk"]
        OP3["OP-03 Engagement & Disclosure"]
        OP4["OP-04 Escalation & Notification"]
        WB["Auto Workbench<br/>(human review)"]
    end

    subgraph SL["Slack"]
        SLM["5 manager channels (by Org)"]
        SLI["IT provisioning channel"]
        SLC["Confidential HR channel"]
    end

    TF --> POLL --> OP1 --> WK
    SEED --> SB
    ORCH -->|parallel fan-out| OP2 & OP3
    OP2 --> OT & PI
    OP3 --> PK
    OP2 & OP3 -->|reasons[]| ORCH
    ORCH -->|routine| OP4
    ORCH -->|judgment call| WB
    OP4 --> MD
    OP4 --> SLM & SLI & SLC
    OP4 --> CASE
    PC -.->|read by every unit| Auto
```

**The invariant that holds the design together:** the Orchestrator touches no external system directly.
Every external read/write is owned by exactly one Operator. ORCH-01 only triggers Operators and reads
their outputs. This is what makes an integration outage or a credential rotation a one-Operator change,
never a cross-cutting one.

**Platform access pattern:** this workspace has **no native Supabase/Postgres connector**, so every
Supabase read and write in Auto is a **Path 2 custom REST call** (`AUTO_BUILD_GUIDE.md` §A). Slack and
Typeform are **Path 1 native connectors**. Typeform's Auto integration turned out to be **poll-based, not
push-webhook** — hence the separate `OP-01 Typeform Intake Poller` parent workflow that fans one poll's
batch out to OP-01 one submission at a time, leaving OP-01's already-tested single-record logic untouched.

---

## 3. The Orchestrator — `ORCH-01`

The highest-complexity, highest-gate-risk unit in the build, and the one that took the most rework.

### 3.1 Shape

| Aspect | Implementation |
|---|---|
| Trigger | Event-triggered, single `employee_id` input (via Auto app form during testing) |
| Fan-out | Calls `OP-02` and `OP-03` as subworkflows, **in parallel** |
| Fan-in | Barrier — waits for both, then unions their `reasons[]` arrays |
| Routing | One deterministic **Code step**, first-match-wins over the §3.3 table |
| Output | Exactly one `OP-04` call per hire (or a silent no-action), never a direct Slack/Supabase write |
| Second entry point | Schedule-triggered cohort sweep — **not built** (`TASKS.md` 2.2.8) |

### 3.2 Single routing authority

OP-02 and OP-03 each emit a `tier` field (`LOW`/`MEDIUM`/`HIGH`). **ORCH-01 never reads it.** `tier` is
advisory only — a human-readable severity label carried into the audit log. Routing is decided
*exclusively* from the union of `reasons[]` **codes**. Reading `tier` anywhere in the branching logic is
a bug, not a shortcut (ADR-013).

### 3.3 Routing table — evaluated in this exact order, first match wins

| # | Condition | Route | Live verification |
|---|---|---|---|
| 1 | OP-03 `confidential = true` **and** `confidence ≥ disclosure_classifier_min_confidence` | `confidential_disclosure` → OP-04 → confidential Slack channel | ✅ `EMP7003` |
| 2 | OP-03 `confidential = true` **but** `confidence <` threshold | `workbench_log` → Workbench, **no Slack** | ⚠️ **Not built as a distinct branch** (`TASKS.md` 2.2.6) |
| 3 | `TASK_ALREADY_ESCALATED` present, **or** both Operators fired ≥1 reason (compounding risk) | `workbench_log` → Auto Workbench, **not** a Slack nudge | ✅ `EMP7000` |
| 4 | Exactly one MEDIUM reason, code ∈ {`MISSING_DAY_ONE_ACCESS`, `PROVISIONING_DELAYED`} | `it_escalation` → OP-04 → IT channel | ✅ `EMP7018` |
| 5 | Exactly one MEDIUM reason, code ∈ {`STALLED_COMPLIANCE_DOC`, `LOW_ENGAGEMENT_SCORE`} | `manager_nudge` → OP-04 → manager channel by `Org` | ✅ `EMP7035` |
| 6 | No reasons from either Operator | Log & continue — no OP-04 call, no audit row | ✅ `EMP9999` |

Rows 4 and 5 resolve a real spec gap found during the build: the original routing table sent every
single-MEDIUM case to `manager_nudge`, leaving OP-04's fully-built `it_escalation` template unreachable.
Resolved by **explicit per-code lookup**, deliberately not by a structural heuristic on whether the
reason carries a resource reference (ADR-017) — a named code→case_type map answers "why did this go to
IT?" in one line and can't silently break when an unrelated field's population changes.

**Confidentiality is a hard override.** It is evaluated first and forecloses every branch below it,
regardless of what OP-02 found. Note the subtlety in rows 1 vs. 2: a low-confidence disclosure is *still*
`confidential: true` — the rows differ on **confidence**, not on the `confidential` flag. Writing
`if confidential: → Slack` would send an unconfirmed, possibly-false disclosure to the confidential
channel instead of to a human.

### 3.4 Partial-signal handling

If one Operator's call fails its own integration retries, ORCH-01 proceeds on the *other* Operator's
signal alone rather than blocking the hire. If both fail, it calls OP-04 with
`orch01_no_signal_available` and stops before the routing table. Verified for the *no-data* case
(`EMP9999` — both Operators returned empty results cleanly → `reasons: []` → `action: none`); the
genuine *integration-failure* case was never exercised, since no real failure occurred during testing.

### 3.5 Parallel execution — the gate evidence

`EMP7000`: `Execute OP-02` ran 10:18:41–10:19:28 and `Execute OP-03` ran 10:18:42–10:19:23 — ~45 seconds
of genuine overlap, read off Activity Timeline timestamps. This took two rounds of debugging first: a
subworkflow-picker glitch that resolved both calls to OP-02 (fixed by explicitly confirming OP-03 was
published), and the merge-step bug below.

### 3.6 The rework that mattered — ADR-018

ORCH-01's "Merge Subworkflow Outputs" and "Route and Escalate" steps were originally built as Auto's
**AI-interpreted** steps, the same type OP-01/02/03's detection logic uses successfully. Across repeated
attempts they reported **fabricated results** — invented reason codes that exist nowhere in this system's
spec (`op02_it_high_risk`, `op03_disclosure_missing`), invented employee data, and success summaries that
contradicted the same run's own raw logs. Both steps were rebuilt as plain deterministic **Code steps**.

A step whose whole job is "combine two other steps' real outputs and branch on them literally" has no
need for language-model interpretation — it is pure data plumbing, and removing the interpretation layer
removes the fabrication surface entirely. OP-03's "Evaluate Rules and Determine Output" step had already
needed the identical fix. The consequence adopted project-wide: **only raw Activity Timeline / Execution
Logs count as proof of a run's behavior.**

---

## 4. The Operators

### OP-01 — Intake & Normalization · **Built, 5/5 unit cases passed**

Turns an incoming new-hire record into a clean, deduplicated `Workers` row before anything downstream
sees it.

- **Trigger:** the `OP-01 Typeform Intake Poller` parent workflow, one call per submission returned by a
  poll (zero, one, or many).
- **Required fields:** exactly **three** — `Legal_Name`, `Hire_Date`, and one manager identifier. Everything
  else is enrich-later. An earlier draft marked ~11 fields required, which would have escalated nearly
  every realistic live submission and broken the gate-mandatory live-intake demo beat.
- **Pipeline:** normalize text → multi-format date parse (never guesses; unparseable escalates) → resolve
  manager against `Manager_Directory` (0 or >1 candidates escalates) → fuzzy-dedup on normalized name +
  hire-date proximity → upsert to Supabase `Workers` on `Worker_WID`.
- **Dedup bands:** ≥ 0.90 → update existing; < 0.70 → create new; in between → escalate
  `intake_possible_duplicate` rather than silently deciding either way.
- **Failure modes:** `intake_validation` / `intake_integration_failure` / `intake_possible_duplicate` — all
  to the Workbench, nothing silently dropped. Write failure retries 3× (5/20/60s), or once with no
  backoff when `demo_mode` is on.
- **Verified:** clean create, name-variant update, unparseable date, unresolvable manager, missing
  required field.

### OP-02 — Onboarding & Provisioning Risk · **Built, 4/4 reason codes verified live**

Read-only, single-hire assessment of onboarding-task and IT-provisioning health.

| Rule | Reason code | Verified against |
|---|---|---|
| `Provisioning_Integration.Status = Blocked` past grace | `MISSING_DAY_ONE_ACCESS` | `EMP7000` (Laptop + System Access, >53 days past grace) |
| Compliance step in `Not Started`/`In Progress` past overdue threshold | `STALLED_COMPLIANCE_DOC` | `EMP7005` (57.6 days overdue) |
| `Onboarding_Tasks.Status = Escalated` | `TASK_ALREADY_ESCALATED` | `EMP7000` ×2, `EMP7005` ×1 |
| `Requested` provisioning row past grace, no `Fulfilled_On` | `PROVISIONING_DELAYED` | `EMP7000` (Email, 6.6 days past) |

Compliance-step matching uses a **configurable term list** (`policy_config.thresholds.compliance_step_terms`),
never a hardcoded substring match — so a hidden dataset that renames its compliance steps is a config
edit, not a logic edit (ADR-016). Tier aggregation: 0 reasons → LOW, 1 → MEDIUM, 2+ → HIGH — advisory
only. Zero source rows returns `data_state: "no_data_yet"`, not an error. `confidence` is fixed at 1.0
(every rule is a deterministic data check).

*Not separately fault-injection-tested:* the read-failure retry/escalation path (built during the
Supabase migration), and one clean/LOW hire.

### OP-03 — Engagement & Disclosure · **Built, 2 of 3 rules live**

The confidentiality-critical Operator. Read-only over `Peakon_Engagement`, plus one LLM classification
step.

- **Rule 1 — low engagement:** most recent score below `engagement_low_score` (default 5) →
  `LOW_ENGAGEMENT_SCORE`. Verified on `EMP7046` (score 3 at Day 60). Also verified *negatively*: `EMP7007`
  (low early, recovered later) correctly does **not** fire — the rule reads most-recent, not lowest-ever.
- **Rule 2 — survey non-response:** ❌ **not implemented.** Dropped after 7+ debugging attempts produced
  repeated false "fixed" claims from Auto's builder that contradicted the raw logs. Team call: not
  gate-blocking (OP-03 still returns real signals via rules 1 and 3), so the time went to ORCH-01 instead.
  `SURVEY_NON_RESPONSE` therefore never appears in a real `reasons[]` this round.
- **Rule 3 — sensitive disclosure:** an LLM classifier (not keyword matching, ADR-005) asks whether a
  comment discloses a personal/health/interpersonal/safety concern that HR should handle confidentially.
  Verified live on `EMP7003`'s real comment ("…dealing with a health matter and have not felt able to
  raise it with my manager yet") → `confidential: true`, confidence 1.0; routine comments correctly
  classify `false`.
- **Confidentiality contract — verified zero leakage:** raw comment text appears **only** in
  `_internal_case_payload`, never in `reasons[]`, which carries just the generic
  `SENSITIVE_DISCLOSURE_DETECTED` entry. Confirmed by manual inspection of raw Activity Timeline logs for
  `EMP7003`.
- **Fail-safe:** classifier failure or low confidence defaults to `confidential: true, confidence: 0` —
  fail safe, not fail silent. A false negative here is the single worst failure mode in the build.
  Implemented per spec; not separately fault-injection-tested.
- **Rebuild note:** the "Evaluate Rules and Determine Output" step was converted from AI-interpreted to a
  deterministic Code step after the AI version repeatedly fabricated results — the same pattern later
  formalized as ADR-018.

### OP-04 — Escalation & Notification · **Built, 6/6 unit cases passed**

The only Operator with write access to notification channels, which localizes all outbound
retry/failure/credential logic in one place.

- **Case types:** `manager_nudge`, `it_escalation`, `confidential_disclosure`, `workbench_log`.
- **Routing:** `manager_nudge` resolves `Manager_WID` → `Manager_Directory.Org` →
  `policy_config.routing.manager_channel_by_org` (5 real channel IDs). `it_escalation` and
  `confidential_disclosure` go to fixed channels — the confidential channel **always**, never org-branched
  (ADR-002). Unresolvable manager → `op04_routing_unresolved` to the Workbench, never a silent non-notify.
- **Templating:** rendered from `policy_config.templates`. Hard constraint, tested with a literal sentinel
  string: `_internal_case_payload.comment_text` and `.driver` are **never** interpolated into any message
  or written to any audit field. Only `.milestone` may be used, and only in the confidential template.
- **Slack send:** native connector, posting to channel **IDs**. Retries 3× (or once in `demo_mode`);
  exhausted → `op04_notification_failure` to the Workbench **and** the audit write still runs
  independently, so the trail records "we tried to notify and failed."
- **Audit:** exactly one `Cases_Audit_Log` row per run — every case type including `workbench_log` and
  failed sends — carrying `case_id`, `timestamp`, `employee_id`, `case_type`, `channel`,
  `policy_rules_fired`, `outcome`. `workbench_log` skips Slack entirely and logs `channel = "workbench"`.

### OP-05 — Cohort Reporting · ❌ **Not built (descoped)**

Specified in full (`OPERATORS.md` §OP-05) but not implemented this round. It would have computed the
headline **exposure rate** (% of active cohort with ≥1 unresolved OP-02-style reason, computed fresh from
the source tables and deliberately independent of the system's own case log, so it is falsifiable rather
than a self-report), plus task completion rate and at-risk catch rate.

Its Round 1 output surface was also reopened by the migration: `TASKS.md` 0.0.4 had settled on an Airtable
Interface over the audit log; with that table now on Supabase, the surface becomes **Supabase's Table
Editor** — a plain filterable grid, not a purpose-built dashboard. A real, accepted quality reduction for
the business-output rubric line (ADR-001 second amendment, Consequence 1).

**Structural guarantee worth preserving:** OP-05's read scope permanently **excludes `Peakon_Engagement`
as a table** — not just its `Comment` field. It has no input contract that could read a raw disclosure
even by mistake. Any future edit adding that table to OP-05's inputs is a regression, not a refactor.

---

## 5. What Lives in This Repo

The Auto workflows themselves are no-code and live in the Supervity Auto workspace — they are not files
here. What the repo holds is the specification package, the shared rule set, and the data tooling.

| Path | Role | State |
|---|---|---|
| `config/policy_config.json` | Versioned reference export of every threshold, routing target, template, and retry profile | ✅ Complete (v1.0) |
| `config/supabase_schema.sql` | DDL for all 7 tables, applied to the live project | ✅ Applied |
| `scripts/seed_loader/loader.py` | Reseeding utility: schema-validated, idempotent CSV → Supabase load with a JSON load report | ✅ Built |
| `scripts/seed_loader/normalize.py` | Multi-format date + text normalization rules (ADR-011); 13 accepted patterns, explicit `BLANK`/`UNPARSEABLE`/`AMBIGUOUS` statuses | ✅ Built |
| `scripts/seed_loader/fuzzy_dedup.py` | Name-variant dedup rules (ADR-012), 3 bands; rapidfuzz with a stdlib `difflib` fallback | ✅ Built |
| `scripts/seed_loader/supabase_client.py` | PostgREST client — dual-header auth, header-driven upsert, key-padded bulk arrays | ✅ Built |
| `scripts/seed_loader/seed_policy_config.py` | Pushes `policy_config.json` into the Supabase `policy_config` table (22 rows) | ✅ Built |
| `scripts/seed_loader/airtable_client.py` | Legacy Airtable client | ⚠️ Deprecated, unused |
| `scripts/seed_loader/test_*.py` | 58 unit tests | ✅ **58/58 pass** (re-run at time of writing, 1.8s) |
| `docs/` | 10-document specification package (context, plan, architecture, operators, data flow, integrations, decisions, risks, tasks, build guide, demo) | ✅ Current |

**Important framing on "shared" logic:** `normalize.py` and `fuzzy_dedup.py` are not imported by the Auto
Operators — a no-code platform can't import a Python module. They are the *executable reference* for one
documented rule set that both the Auto workflows and the loader implement independently (ADR-006
amendment). Changing a rule here without changing it in Auto (and in `OPERATORS.md`) silently forks them.

**Reseeding utility contract:** schema-driven by column name, aborts with a specific per-column report on
a renamed/missing column (no partial load), idempotent via PostgREST upsert on each table's natural key,
`--reset` clears only `Cases_Audit_Log` and never a source table, `--dry-run` validates and normalizes
without writing. Live verified against Supabase: 60 `Workers`, 25 `Manager_Directory`, 22 `policy_config`,
780 `Onboarding_Tasks`, 300 `Provisioning_Integration`, 140 `Peakon_Engagement` rows.

```sh
pip install -r scripts/seed_loader/requirements.txt
python scripts/seed_loader/loader.py --dry-run          # validate + normalize, no writes
python scripts/seed_loader/loader.py                    # live reseed
python scripts/seed_loader/seed_policy_config.py        # push config to Supabase
cd scripts/seed_loader && python -m unittest discover   # 58 tests
```

---

## 6. Environment & Credentials

### 6.1 Repo-side `.env`

`.env` is gitignored and **not present in this working copy** — a fresh clone has to create one from
`.env.example` before any script will run live.

| Variable | Used by | Required? | Status |
|---|---|---|---|
| `SUPABASE_URL` | `loader.py`, `seed_policy_config.py` → `SupabaseClient` | **Yes** — scripts exit 1 without it | 🔲 **Fill in** (value exists in the team's live env; absent from this checkout) |
| `SUPABASE_SERVICE_ROLE_KEY` | same | **Yes** — same | 🔲 **Fill in** (project-scoped Supabase secret key; full access, bypasses RLS) |
| `AIRTABLE_BASE_ID` | *nothing* — `airtable_client.py` is deprecated and takes constructor args | ❌ No | ⛔ **Obsolete** — still listed in `.env.example`, read by no code path |
| `AIRTABLE_TOKEN` | *nothing* | ❌ No | ⛔ **Obsolete** — same |
| `SLACK_BOT_TOKEN` | *nothing in this repo* — Slack is a native Auto connector | ❌ No (repo-side) | ⚠️ Belongs in **Auto's credential store**, not here; listed in `.env.example` misleadingly |

> **Flagged:** `.env.example` is stale relative to ADR-001's second amendment. It should drop the two
> `AIRTABLE_*` lines, annotate `SLACK_BOT_TOKEN` as Auto-side-only (or remove it), and — since
> `AUTO_BUILD_GUIDE.md` §A writes URLs as `https://{SUPABASE_PROJECT_REF}.supabase.co` — optionally add
> `SUPABASE_PROJECT_REF` for clarity. Not changed as part of writing this summary.

### 6.2 Auto workspace credentials (not in this repo)

These live in the Supervity Auto workspace's own credential store and are what the no-code Operators
actually authenticate with.

| Credential | Path | Used by | Status |
|---|---|---|---|
| Supabase REST credential — API root `https://{ref}.supabase.co/rest/v1`, **both** `apikey: {key}` and `Authorization: Bearer {key}` headers (missing either → rejected) | Path 2 custom REST | Every Operator (all reads/writes + `policy_config`) | ✅ Connected & live-verified |
| Slack bot/app token | Path 1 native connector | OP-04 (send message, by channel **ID**) | ✅ Connected & live-verified |
| Typeform account/auth | Path 1 native connector (**polling**, not push webhook) | `OP-01 Typeform Intake Poller` | ✅ Connected & live-verified |
| LLM step | Auto-native — no external key, and deliberately **not counted** as an integration for gate purposes | OP-03 rule 3 classifier | ✅ Working |
| Airtable connection | Path 2 custom REST | *nothing* | ⛔ **Deprecated** — still physically connected, and Auto's builder may still suggest it. Do not bind any step to it. |
| GitHub PAT / GitHub App | Path 1 | OP-04 bonus audit mirror (`TASKS.md` 4.2.2) | 🔲 **Not provisioned** — optional P2 bonus only; wiring it does **not** restore gate margin |

### 6.3 Non-secret configuration (already filled, lives in `policy_config`)

Not environment variables, but the values a business user is most likely to change — all present in both
`config/policy_config.json` and the live Supabase `policy_config` table:

- **7 real Slack channel IDs** — Finance `C0BJA0P1M6V`, Sales `C0BJBQ02U2Y`, Ops `C0BHSMV328P`,
  Engineering `C0BJ4PYGV5K`, People `C0BJ4PZ8961`, IT `C0BJ839B24A`, Confidential `C0BK2CRJ596`.
  Keyed on `Manager_Directory.Org` (5 values), **never** `Workers.Job_Family` (4 different, only
  partially-overlapping values — `Ops` ≠ `Operations`, `Engineering` ≠ `Technology`).
- **Thresholds** — grace days, overdue days, compliance step terms, engagement floor, classifier
  confidence floor, dedup bands, catch-rate SLA.
- **`as_of_date`** — `null` = live wall-clock. Pinned only for deterministic tests and the demo
  recording; never an implicit `now()` inside any Operator (ADR-014).
- **`demo_mode` + `retry_demo_profile`** — toggling `demo_mode` on swaps the 3-attempt 5/20/60s retry
  for a single no-backoff attempt, eliminating up to ~85s of dead air per failed write chain during a
  live take (`RISKS.md` R-23).

---

## 7. Qualification Gate — Evidence

| Criterion | Status | Evidence |
|---|---|---|
| Not a single mega-agent | ✅ | 1 Orchestrator + 4 built Operators + 1 parent workflow, each independently saved and invocable |
| ≥3 integrations, ≥2 categories, incl. 1 channel + 1 SoR | ✅ | Supabase (SoR) + Slack (channel) + Typeform (forms) = 3 integrations, 3 categories |
| ≥1 live exception to Auto Workbench | ✅ | `EMP7000` → `TASK_ALREADY_ESCALATED` → `workbench_log`; OP-04 subworkflow call confirmed via its own run audit link, not a claim |
| Parallel / branching / stateful demonstrable | ✅ | OP-02 ∥ OP-03 overlap by raw timestamp (`EMP7000`); all 5 routing branches confirmed with real data |

**Zero spare margin, stated honestly:** dropping Airtable took the integration count from 5 to exactly the
gate's stated minimum. A Typeform outage during judging would drop the category count below the
requirement, not merely remove a demo beat. Accepted trade-off — a single-backend architecture was judged
simpler to build correctly with a two-person team and the time remaining than maintaining two live
backends (ADR-001 second amendment Consequence 2; `RISKS.md` R-26).

---

## 8. Known Gaps — Disclosed, Not Oversights

| Gap | Task | Why it stands |
|---|---|---|
| OP-03 rule 2 `SURVEY_NON_RESPONSE` not implemented | `1.3.3` | 7+ attempts produced builder claims contradicted by raw logs; not gate-blocking with 2/3 rules live, so effort moved to ORCH-01 |
| Low-confidence-disclosure branch not built | `2.2.6` | Every real test case classified at or near confidence 1.0, so the branch was never exercisable. A genuinely sub-threshold disclosure would currently fall through to the non-confidential path rather than escalating — the one gap with real correctness consequences |
| Schedule-triggered cohort sweep not built | `2.2.8` | Every test was a manual single-`employee_id` run |
| E2E test is 6 hand-picked hires, not a 60-worker sweep | `2.2.10` | Depends on `2.2.8`. Covers 4 of 5 branches with real data — above the "≥3 branch types" gate minimum, but it is **not** the literal "full cohort, zero crashes" criterion, and should be narrated that way |
| OP-05 + dashboard not built | `4.1.x` | Descoped for time. Business-output evidence rests on individually-verified case outcomes, not an aggregate metric |
| Adversarial rehearsal dataset not authored/run | `3.3`–`3.5` | Phase 3's hard release gate was not cleared. Closest robustness proof: `EMP9999` (an ID absent from all seed data) resolves cleanly through the full pipeline with no crash and no fabricated finding |
| Loader timing not measured against the <90s target | `3.6` | Live reseeds succeeded; the stopwatch check wasn't run |
| Integration-failure retry paths not fault-injection-tested | `1.2.6`, `1.3.6`, `2.2.7` | Built per spec; no real integration failure occurred during testing to exercise them |
| Self-learning design note not written | `4.3.1` | P2, documentation-only |

---

## 9. Stale Artifacts to Be Aware Of

- **`PROGRESS.md`** — a read-only audit dated 2026-07-18, written before the Supabase migration and
  before any Auto work was verifiable from the repo. Its conclusions (Airtable as system of record, "no
  evidence Auto work has started") are **superseded by this document** and by `TASKS.md`.
- **`.env.example`** — carries two dead `AIRTABLE_*` variables and a `SLACK_BOT_TOKEN` no repo code reads
  (see §6.1).
- **`scripts/seed_loader/README.md`** — its contents table still says the loader is "Not yet built
  (Phase 3)"; it has been built and tested since.
- **`README.md` repository-structure note** — says `config/` and `scripts/` are "not yet implemented";
  both are.
- **`TASKS.md` 0.1.1 / 0.1.4** — describe Airtable provisioning. Accurate as *historical record* only.

---

## 10. Next Actions

1. **Phase 5 — submission package** (critical path): record the demo per `DEMO.md`, publish the LinkedIn
   post, assemble the Operator/workspace links, draft and submit the portal fields.
2. **Cheap correctness win if time remains:** build the low-confidence-disclosure branch (`2.2.6`) — it is
   a few lines in ORCH-01's existing Code routing step and closes the only gap with real correctness
   consequences.
3. **Cheap hygiene:** refresh `.env.example`, `scripts/seed_loader/README.md`, and `README.md`'s structure
   note (§9); write the `4.3.1` self-learning design note (documentation only).
4. **If more time:** `2.2.8` cohort sweep → `2.2.10` real 60-worker E2E → `3.3`/`3.4` adversarial
   rehearsal → OP-05.
