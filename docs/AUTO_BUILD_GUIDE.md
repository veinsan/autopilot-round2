# AUTO_BUILD_GUIDE.md — Round 2 Auto Operator Build Prompts

## Purpose

This is the copy-paste runbook for building the Round 2 HR Ops workflows in
Supervity Auto. It turns the frozen decisions in `plan.md` into small builder
prompts and verifiable tests. It does not redesign the solution.

Build scope:

- extend the existing Orchestrator (`ORCH-01`) and notification Operator
  (`OP-04`);
- create `OP-05 Compliance & Work Authorization`;
- create `OP-06 First-Payroll Verification`;
- create `OP-07 Cross-Team Readiness & Manager Accountability`;
- create a scheduled parent workflow for the 09:00 UTC cohort sweep.

Keep existing `OP-01`–`OP-04` behavior unless a prompt below explicitly amends
it. Auto hosts the Orchestrator and Operators; this repository remains the
Command Center, policy API, data view, and human Workbench.

Stage 1 described a proposed `OP-05 Cohort Reporting`, but it was explicitly
descoped and never built. The frozen Round 2 numbering replaces that unused
slot with `OP-05 Compliance & Work Authorization`. Create it as a new Operator;
do not continue or repurpose an old Cohort Reporting workflow if one happens to
exist in the workspace.

The old `OPERATORS.md`, `TASKS.md`, and `DECISIONS.md` referenced by
`STAGE_SUMMARY.MD` are not present in this repository. For this guide, the
authoritative sources are `plan.md`, `config/auto_command_contract.md`,
`config/supabase_schema.sql`, the Round 2 problem statement, and
`docs/STAGE_SUMMARY.MD`.

## 0. Do not build past these go-live gates

These are real contract dependencies, not builder choices.

| Gate | Required before | Pass condition |
|---|---|---|
| G-01 Active Round 2 policy | Any live Operator test | Exactly one `policy_versions` row has `status=active`, and its `config_snapshot` contains the registered Round 2 reason codes and thresholds used below. Missing keys must create a system exception; Operators must not invent defaults. |
| G-02 Restricted payroll RBAC | OP-06 case routing/live publish | Manager list/detail/action APIs exclude `case_type=payroll`; payroll is visible only to Admin and the approved People Ops/payroll role. No `error_reason`, `gross`, or `net` is stored in a standard case/event. |
| G-03 Manager action state | OP-07 step 7.3 | A durable server-owned state contract exists for `nudge_created`, `delivered`, `acknowledged`, `action_verified`, `escalated`, reminder count, and deadlines. It must support multiple delivery attempts idempotently. Do not derive these states from Slack success, a blank field, or Peakon `manager_response_days`. |
| G-04 Live workflow IDs | Orchestrator publish | Server-only configuration maps the approved workflow keys to the published Auto workflow UUIDs. The browser never supplies a workflow UUID. |

Steps 5.1–5.3, 6.1–6.2, and 7.1–7.2 can be built and unit-tested before G-02
or G-03. Do not fake the gated parts merely to make the builder show green.

The minimum active policy snapshot must contain these keys (values remain
editable through Policy Studio). The `reason_codes` shown are Round 2 additions:
merge them with the existing Round 1 registry; never replace or rename an
existing code:

```json
{
  "reason_codes": [
    "COMPLIANCE_DEADLINE_AT_RISK",
    "COMPLIANCE_LEGAL_BREACH",
    "WORK_AUTH_EXPIRY_AT_RISK",
    "WORK_AUTH_EXPIRED",
    "PAYROLL_ERROR_DETECTED",
    "PAYROLL_NOT_CONFIRMED",
    "PAYROLL_RECORD_MISSING",
    "DAY_ONE_DEPENDENCY_BLOCKED",
    "LEARNING_MILESTONE_OVERDUE",
    "MANAGER_ACKNOWLEDGMENT_OVERDUE",
    "MANAGER_ACTION_OVERDUE",
    "COHORT_DEPENDENCY_BOTTLENECK"
  ],
  "as_of_date": null,
  "demo_mode": false,
  "thresholds": {
    "work_auth_expiry_at_risk_days": {"default": 30},
    "compliance_at_risk_days": {"default": 14},
    "first_payroll_cutoff_days": {"default": 30},
    "nudge_cadence_days": {"default": 2},
    "manager_acknowledgment_deadline_days": {"default": 2},
    "manager_action_deadline_days": {"default": 5},
    "manager_max_reminders": {"default": 2},
    "bottleneck_min_workers": 2,
    "bottleneck_min_percent": 25
  },
  "retry": {"max_attempts": 3, "backoff_seconds": [5, 20, 60]},
  "retry_demo_profile": {"max_attempts": 1, "backoff_seconds": []}
}
```

The numbers above are conservative demo seed values, not legal advice or an
authoritative payroll calendar. Review them, add jurisdiction overrides where
known, simulate, approve, and activate through Policy Studio. Auto always reads
the active version and never reads a draft as operative policy.

## 1. Builder operating rules

### 1.1 If the Auto builder gets stuck

| Situation | Response |
|---|---|
| Builder asks questions instead of building | Answer with one concrete decision, or paste only the Goal and failing STEP. |
| Waiting for approval | Say `Yes, proceed with the saved plan.` or list the exact requested change. |
| Same error repeats | Narrow the prompt to one failing step; do not repaste an entire Operator. |
| Wrong data source/tool | Say: `Use the Supabase custom REST credential, not Airtable and not a native Supabase/Postgres block.` |
| Integration required but unavailable | Finish the connection in workspace integration settings, then retry once. |
| Long/confused builder chat | Start a fresh builder chat against the Operator's current saved version, then paste the next step. |

After every build, inspect the raw Activity Timeline. A builder summary is not
proof that a REST call, branch, retry, or subworkflow actually ran.

### 1.2 Supabase REST only

All source and operational tables live in Supabase. Airtable is deprecated even
if an old connected credential is still visible. Auto has no native Supabase
connector for this project; use HTTP/custom API requests bound to the server-side
Supabase REST credential.

```text
API root: {SUPABASE_URL}/rest/v1
Headers:
  apikey: {SUPABASE_SERVICE_ROLE_KEY}
  Authorization: Bearer {SUPABASE_SERVICE_ROLE_KEY}
  Content-Type: application/json
```

Never paste the service-role key into a prompt, workflow field, log, or test
output. Bind the saved credential in the builder UI.

- Read: `GET /Table?Column=eq.value&select=field1,field2`
- Upsert: `POST /Table?on_conflict=primary_key` with
  `Prefer: resolution=merge-duplicates,return=representation` and a bare JSON
  array body.
- Never issue a filter-less update or delete.
- Select only fields required by the step. OP-06 must never select
  `error_reason`, `gross`, or `net`.

### 1.3 Active policy and time

Every Operator begins with:

```text
GET /policy_versions?status=eq.active&select=version_id,config_snapshot,activated_at&limit=2
```

Require exactly one row. If zero or more than one is returned, emit a
`system_exception`, route it to the Workbench, and stop the affected evaluation.
Require every policy key used by the branch; never silently fall back to a
hard-coded value.

`as_of` is `config_snapshot.as_of_date` when non-empty, otherwise the current
instant. Deadline comparisons use the worker's jurisdiction-local calendar day:

1. take `Workers.jurisdiction` as the jurisdiction key;
2. query `Locations_Entities` by that jurisdiction;
3. require all matching entity rows to agree on one timezone;
4. use that timezone, otherwise use `Workers.time_zone` only when non-empty;
5. a missing/invalid/conflicting mapping becomes a data-quality system
   exception—never guess from the free-text `Workers.Location` label.

### 1.4 Determinism and privacy

Use Code/Logic steps for lookup, date math, comparison, grouping, deduplication,
and routing. AI text generation must not decide whether a legal, payroll,
deadline, or manager-action rule fired.

Never put any of these into a standard output, event, case, Slack message, or
builder log:

- `Peakon_Engagement.Comment` or raw survey narrative;
- confidential payload, driver, or secure case content;
- `Payroll_Records.error_reason`, `gross`, or `net`;
- access tokens, full API responses, or model reasoning.

OP-07 may not read `Confidential_Cases`. It may read only non-confidential
engagement metadata with an explicit `x_confidential=eq.false` filter and a
field allowlist that excludes `Comment`.

### 1.5 Common Operator input and output

Common input:

```json
{
  "execution_id": "command_id or stable Auto run ID",
  "command_id": "optional; present for Command Center runs",
  "trigger_source": "command_center|daily_schedule|typeform",
  "scope": "employee|cohort",
  "employee_id": "EMP7000",
  "cohort": null
}
```

Each Operator returns one envelope, including an empty `findings` array when
clear:

```json
{
  "employee_id": "EMP7000",
  "operator_id": "OP-05",
  "policy_version_id": "policy_x",
  "evaluated_at": "2026-08-03T09:00:00Z",
  "findings": [
    {
      "reason_code": "COMPLIANCE_DEADLINE_AT_RISK",
      "domain": "compliance",
      "severity": "high",
      "evidence_refs": ["compliance-item:CMP-80065"],
      "owner": "people_ops_compliance",
      "recommended_action": "Review the compliance deadline and owner"
    }
  ],
  "reasons": ["COMPLIANCE_DEADLINE_AT_RISK"],
  "system_exceptions": []
}
```

`reasons` is only the unique reason-code projection of `findings`; it contains
no prose. Unknown reason codes become a system exception and never trigger a
notification.

Every evaluated object writes an idempotent `policy_evaluations` row containing
only safe evidence references. Build `evaluation_id` deterministically from
`execution_id + operator_id + policy_version_id + object_type + object_id +
rule_key`; upsert on `evaluation_id`. Record both clear and fired outcomes so a
policy-change demo is measurable.

### 1.6 Retry and demo mode

Every Supabase write and Slack send uses the active versioned policy's retry
profile. When `demo_mode=true`, use `retry_demo_profile`; otherwise use `retry`.
Treat a network failure or any non-2xx response as a failed attempt. Wait the
corresponding backoff value and retry up to `max_attempts`; a missing backoff
entry means zero wait. After exhaustion, emit an integration-failure system
exception with safe context. Never claim the write/send succeeded. A failed
Slack delivery does not consume a successful manager-reminder count.

## 2. OP-05 — Compliance & Work Authorization

Create one Operator named exactly `OP-05 Compliance & Work Authorization`.

### 5.1 — Contract, policy, worker, and timezone context

**Prompt:**

```text
Goal: create the safe, deterministic input and policy context for Round 2
compliance and work-authorization evaluation.

Create an Operator named "OP-05 Compliance & Work Authorization". Do not use an
AI interpretation step. Use only Code/Logic and Supabase custom REST requests.
Never use Airtable or a native Supabase/Postgres block.

INPUT: execution_id, optional command_id, trigger_source, employee_id.

STEP 1 — Validate input.
- employee_id and execution_id must be non-empty strings.
- Invalid input returns a system_exception and stops. Do not invent an employee.

STEP 2 — Read the active policy.
- GET policy_versions where status=active, selecting only version_id,
  config_snapshot, activated_at, limit 2.
- Require exactly one row.
- Require reason_codes plus thresholds.work_auth_expiry_at_risk_days and
  thresholds.compliance_at_risk_days.
- Resolve as_of from config_snapshot.as_of_date; null means current instant.
- A missing/invalid policy creates a safe system_exception and stops.

STEP 3 — Read the worker.
- GET Workers where Employee_ID equals input.employee_id.
- Select only Employee_ID, jurisdiction, time_zone, work_auth_expiry, Hire_Date,
  Location, cohort.
- Require exactly one worker row.

STEP 4 — Resolve jurisdiction timezone deterministically.
- Query Locations_Entities by Workers.jurisdiction, selecting only jurisdiction
  and timezone.
- If all matching rows have the same valid timezone, use it.
- Otherwise use Workers.time_zone only if it is non-empty and valid.
- Never infer jurisdiction or timezone from the free-text Location field.
- If no safe timezone can be resolved, emit a data-quality system_exception and
  stop date-dependent evaluation.
- Compute as_of_local_date in the resolved timezone.

OUTPUT a temporary context containing execution_id, employee_id, worker,
policy_version_id, active config_snapshot, evaluated_at, as_of_local_date, and
resolved_timezone. Do not output a full policy or raw REST response.
```

**Tests:**

| # | Scenario | Input/setup | Expected |
|---|---|---|---|
| 1 | Valid context | `EMP7032`, pinned `as_of_date=2026-08-03` | One SG worker; `Asia/Singapore`; active policy version carried forward. |
| 2 | Unknown employee | `EMP-NOT-FOUND` | Safe system exception; no compliance call and no finding. |
| 3 | Missing policy key | Controlled active-policy fixture without `compliance_at_risk_days` | System exception; no inferred 14-day default. |
| 4 | Timezone ambiguity | Controlled worker/entity fixture with no valid timezone | System exception; no system-clock date math for that employee. |

### 5.2 — Deterministic rule evaluation and logging

**Prompt:**

```text
Goal: add deterministic compliance-item and work-authorization decisions to the
existing "OP-05 Compliance & Work Authorization" context.

Continue the existing Operator after its context step.

STEP 1 — Read compliance items.
- GET Compliance_Items by employee_id.
- Select only item_id, employee_id, doc_type, jurisdiction, due_date, status.

STEP 2 — Resolve jurisdiction threshold values.
- A threshold may be a number or an object keyed by jurisdiction with an
  explicit "default".
- Use the exact jurisdiction override when present, else explicit default.
- Missing, negative, or non-numeric values create a system_exception; do not
  invent a value.

STEP 3 — Evaluate every compliance item in deterministic Code logic.
- Status Completed, Complete, or Verified (case-insensitive) => CLEAR.
- Missing/invalid due_date => data-quality system_exception for this item.
- due_date before as_of_local_date => COMPLIANCE_LEGAL_BREACH, critical,
  domain compliance.
- due_date from 0 through compliance_at_risk_days inclusive =>
  COMPLIANCE_DEADLINE_AT_RISK, high, domain compliance.
- Later due date => CLEAR.
- If item.jurisdiction is non-empty and differs from worker.jurisdiction, do not
  decide the legal status; create a data-quality system_exception for the item.

STEP 4 — Evaluate work authorization.
- A blank Workers.work_auth_expiry is not automatically an error and must not be
  guessed; the source dictionary permits local workers without an expiry.
- For a non-empty valid expiry: before as_of_local_date => WORK_AUTH_EXPIRED,
  critical; from 0 through work_auth_expiry_at_risk_days inclusive =>
  WORK_AUTH_EXPIRY_AT_RISK, high; otherwise CLEAR.
- Invalid non-empty expiry => data-quality system_exception.

STEP 5 — Group and log.
- Return at most one finding per reason_code. Combine safe evidence_refs; use
  compliance-item:<item_id> and worker:<employee_id> only.
- Write one idempotent policy_evaluations row per evaluated item/rule, including
  CLEAR outcomes. Evidence must contain IDs and numeric day distance only, never
  document content.
- Output the common envelope with operator_id OP-05, findings, unique reasons,
  and system_exceptions.
```

**Tests:**

Jalankan sesuai kolom **Urutan** (bukan urutan nomor `#`) — ini menghormati dependensi
antar-test: test 7 harus langsung setelah test 1 memakai `execution_id` yang sama, dan
test yang mem-pin `as_of_date`/threshold mengubah `policy_versions` yang sedang
`active`, jadi harus dikelompokkan dan di-revert sebelum test lain lanjut.

Field yang sama di semua baris (tidak diulang di tabel): `command_id` = sama dengan
`execution_id`; `trigger_source` = `command_center`.

| Urutan | # | Scenario | employee_id | execution_id | Expected output | Tindakan tambahan sebelum run |
|---|---|---|---|---|---|---|
| 1 | 3 | Clear employee | `EMP7099` | `cmd_746f8376c86bd2da4646026aef7ff3d6` | `reasons: []`, `findings: []` (both compliance items Verified) | Tidak ada |
| 2 | 1 | Legal breach | `EMP7054` | `cmd_b46f034307cb6582c3a738ab86e2dc3b` | `COMPLIANCE_LEGAL_BREACH`, critical; evidence `CMP-80109`; blank worker expiry → tidak ada reason work-auth | Tidak ada |
| 3 | 7 | Duplicate delivery | `EMP7054` | **sama persis dengan #2**: `cmd_b46f034307cb6582c3a738ab86e2dc3b` | Findings identik dengan #2; **tidak ada** baris `policy_evaluations` baru | Jalankan langsung setelah #2, sebelum policy aktif berubah |
| 4 | 2 | Deadline at risk | `EMP7032` | `cmd_9693abbe1222df2a19830260b86427d0` | `COMPLIANCE_DEADLINE_AT_RISK`, high; evidence `CMP-80065`. Uji OP-05 sendiri — employee ini juga punya payroll Error, jangan sampai bocor | Pin `config_snapshot.as_of_date="2026-08-03"` lewat Policy Studio (draft→simulate→approve→activate) |
| 5 | 8 | Item/worker jurisdiction mismatch | `EMP7032` | `cmd_f718417ddebcf8316b38fd51cfee7fb2` | Item-level data-quality `system_exception`; item lain tetap dievaluasi normal | Clone `CMP-80065` → item baru dengan `jurisdiction=MY` |
| 6 | 9 | Missing/invalid due_date | `EMP7000` | `cmd_97b69ef0a17f1ebe8656ba5b10a4dff1` | Item-level data-quality `system_exception`; `CMP-80002` (item asli) tetap dievaluasi normal | Clone `CMP-80001` → item baru dengan `due_date` dikosongkan |
| 7 | 4 | Work auth near expiry | `EMP7099` | `cmd_d21b9c9caa1c0044656800ce825a2d8a` | `WORK_AUTH_EXPIRY_AT_RISK` (29 hari ke `2027-04-28`, threshold 30) | Pin `as_of_date="2027-03-30"` |
| 8 | 5 | Work auth expired | `EMP7099` | `cmd_8fea1318a222c5f928767861e6a55401` | `WORK_AUTH_EXPIRED` | Pin `as_of_date="2027-04-29"` |
| 9 | 6a | Boundary policy change — sebelum | `EMP7099` | `cmd_31b3d3c7a7b5f2739e1566eb13df0d20` | CLEAR (20 hari > threshold 10) | Pin `as_of_date="2027-04-08"` **dan** `work_auth_expiry_at_risk_days.default=10` |
| 10 | 6b | Boundary policy change — sesudah | `EMP7099` | `cmd_184ed215f84a8c5b3049fa8aab33cacc` | `WORK_AUTH_EXPIRY_AT_RISK` (20 hari ≤ threshold 30); evaluasi #9 dan #10 masing-masing mencatat `policy_version_id` yang berbeda | as_of tetap sama; ubah threshold ke `30` lewat policy version baru (approved/active) |
| 11 | 10 | Invalid jurisdiction threshold | `EMP7032` | `cmd_4d0a62607dff26936e9daeaa6ec5971a` | Whole-employee `system_exception`; tidak ada finding, tidak ada nilai default rekaan | Set `compliance_at_risk_days` ke nilai non-numerik/negatif — **jangan aktifkan di policy produksi**; pakai context override pada satu test-run di Auto Studio bila didukung, jika tidak lakukan di luar jam produksi dan revert segera |

Setelah baris #11 selesai, **reaktivasi `policy_round2_v1` versi asli**
(`as_of_date=null`, `compliance_at_risk_days.default=14`,
`work_auth_expiry_at_risk_days.default=30`) sebelum menjalankan stage/test lain.

> Gunakan format tabel ini (Urutan / # / Scenario / employee_id / execution_id /
> Expected output / Tindakan tambahan, plus catatan `command_id`+`trigger_source`
> bersama di atas tabel) untuk daftar tes stage-stage berikutnya (5.3, 6.x, 7.x,
> dan seterusnya) begitu prompt masing-masing sudah final.

### 5.3 — OP-05 failure behavior

**Prompt:**

```text
Goal: make OP-05 fail safely without dropping independent evaluations.

Continue "OP-05 Compliance & Work Authorization".

- A failure reading the active policy or worker stops the entire employee
  evaluation and returns one system_exception.
- A malformed individual compliance item creates an item-level system_exception
  but does not prevent other valid items or valid work authorization from being
  evaluated.
- A failed policy_evaluations write uses the active retry profile. If all
  attempts fail, add an integration-failure system_exception and return the
  already-computed findings; never claim that the evaluation was persisted.
- Return only the common safe envelope. Do not expose HTTP bodies, credentials,
  full policy snapshots, or stack traces.
```

**Tests:**

Field yang sama di semua baris: `command_id` = sama dengan `execution_id`;
`trigger_source` = `command_center`.

| Urutan | Scenario | employee_id | execution_id | Expected output | Tindakan tambahan sebelum run |
|---|---|---|---|---|---|
| 1 | Stop on read failure (regresi ujung-ke-ujung) | `EMP-NOT-FOUND` | `cmd_8774c85d31000a84a4587c3af702218f` | Tepat satu `system_exceptions` (`WORKER_NOT_FOUND`); `findings: []`; tidak ada compliance/work-auth item yang dievaluasi; tidak ada baris `policy_evaluations` ditulis | Tidak ada |
| 2 | Isolasi item malformed (item lain + work-auth tetap dievaluasi) | `EMP7032` | `cmd_1735fe99ed2b02cb94a9728ea9436f6e` | `findings` tetap berisi `COMPLIANCE_DEADLINE_AT_RISK` (evidence `CMP-80065`); `system_exceptions` berisi satu data-quality exception level-item untuk item hasil clone; cek `policy_evaluations` ada baris work-authorization untuk `EMP7032` (CLEAR/AT_RISK) — buktikan work-auth tidak ikut ter-skip | Pin `as_of_date="2026-08-03"`; clone `CMP-80066` → item baru dengan `due_date` dikosongkan (malformed), biarkan `CMP-80065` asli tetap ada |
| 3 | Kegagalan tulis `policy_evaluations` (retry habis) | `EMP7032` | `cmd_e34a1f414d180370d2b07113bf5ebcb8` | `findings` tetap berisi `COMPLIANCE_DEADLINE_AT_RISK` (tidak hilang meski tulis gagal); `system_exceptions` berisi satu integration-failure exception setelah retry profile aktif habis (`max_attempts=3`, backoff `5/20/60`s ≈ sampai ~85 detik); query `policy_evaluations` untuk `evaluation_id` run ini **tidak ada baris** — buktikan tidak ada klaim persisted palsu | Pin `as_of_date="2026-08-03"` (pakai sisa data `CMP-80065` asli, tanpa clone); sebelum run, arahkan sementara endpoint tulis STEP 5 ke tabel/path yang salah (typo) supaya request gagal; segera kembalikan ke `policy_evaluations` yang benar setelah test selesai |

Setelah baris #3, pastikan endpoint tulis STEP 5 sudah dikembalikan ke
`policy_evaluations` yang benar dan hapus fixture clone dari #2
(`delete from "Compliance_Items" where item_id = <id clone>`) sebelum
melanjutkan ke test/stage lain.

## 3. OP-06 — First-Payroll Verification

Create one Operator named exactly `OP-06 First-Payroll Verification`.

### 6.1 — Restricted read and cutoff context

**Prompt:**

```text
Goal: create a privacy-safe first-payroll context using status and an editable
jurisdiction cutoff, without inferring salary or exposing payroll details.

Create "OP-06 First-Payroll Verification" using Code/Logic and Supabase custom
REST only. Never use Airtable, a native database block, or an AI decision step.

INPUT: execution_id, optional command_id, trigger_source, employee_id.

STEP 1 — Use the same input validation, active-policy read, as_of local-date,
jurisdiction threshold resolution, and timezone rules as OP-05. Require
thresholds.first_payroll_cutoff_days.

STEP 2 — Read the worker by Employee_ID, selecting only Employee_ID, Hire_Date,
jurisdiction, time_zone, and cohort. Require a valid Hire_Date; ambiguity becomes
a system_exception.

STEP 3 — Read payroll records by employee_id, ordered cycle descending.
Select ONLY payroll_id, employee_id, cycle, status. CRITICAL: do not request,
store, print, or interpolate error_reason, gross, or net.

STEP 4 — Determine the first-payroll record deterministically.
- If the source guarantees one row, use it.
- If more than one row exists, choose the earliest cycle only when every cycle
  parses unambiguously as YYYY-MM; otherwise emit a data-quality exception.
- Compute cutoff_date = Hire_Date + jurisdiction first_payroll_cutoff_days.
- as_of_local_date must be strictly after cutoff_date for pending/missing rules.

Output only the temporary safe context: IDs, selected status, cycle, cutoff_date,
policy_version_id, and evaluation timestamps. No compensation values.
```

**Tests:**

| Scenario | Expected |
|---|---|
| `EMP7062`, `as_of=2026-08-03` | Reads `PAY-40063` with status Error; output contains none of the source's raw error text or compensation fields. |
| `EMP7008`, same as-of | Reads Paid safely. |
| Forced REST response containing sentinel `PAYROLL_SECRET_XYZ` in `error_reason` | Sentinel never appears in Operator variables, output, Activity Timeline, or events because the field was not selected. |

### 6.2 — Deterministic payroll outcomes and evaluation log

**Prompt:**

```text
Goal: classify first-payroll status conservatively and log a safe evaluation.

Continue "OP-06 First-Payroll Verification" after the restricted context step.

Use deterministic Code logic:
- status Error, case-insensitive => PAYROLL_ERROR_DETECTED, critical, domain
  payroll, regardless of cutoff.
- status Pending, Unconfirmed, or blank => PAYROLL_NOT_CONFIRMED, high, only
  when as_of_local_date is strictly after cutoff_date.
- no payroll row => PAYROLL_RECORD_MISSING, high, only when as_of_local_date is
  strictly after cutoff_date.
- status Paid => CLEAR.
- Any unregistered status => data-quality system_exception; do not guess.

Never compare gross/net, infer expected salary, inspect error_reason, or send a
manager nudge. Evidence refs contain only payroll:<payroll_id> or
worker:<employee_id>; a missing record uses only the worker reference.

Write one idempotent policy_evaluations row for the payroll check, including
CLEAR. Return the common OP-06 envelope. owner is people_ops_payroll and the
recommended action is "Route to the restricted payroll reviewer".
```

**Tests:**

| # | Scenario | Input/setup | Expected |
|---|---|---|---|
| 1 | Confirmed Error | `EMP7062`, `PAY-40063` | `PAYROLL_ERROR_DETECTED`; no raw reason/amount. |
| 2 | Pending after cutoff | `EMP7001`, MY cutoff ending before `2026-08-03` | `PAYROLL_NOT_CONFIRMED`. |
| 3 | Pending before cutoff | `EMP7045`, cycle `2026-09`, `as_of=2026-08-03` with applicable cutoff not passed | CLEAR. |
| 4 | Paid | `EMP7008` | CLEAR. |
| 5 | Missing after cutoff | Controlled worker fixture with no payroll row and passed cutoff | `PAYROLL_RECORD_MISSING`. This condition does not exist naturally in the supplied CSV. |
| 6 | Missing before cutoff | Same fixture before cutoff | CLEAR. |
| 7 | Policy change | Same pending fixture under two active cutoff versions | Outcome changes only when cutoff boundary changes; both versions logged. |

### 6.3 — Restricted case routing (G-02 required)

Do not paste this prompt until G-02 passes.

**Prompt:**

```text
Goal: hand payroll findings to the existing governed case writer without any
manager-visible path.

Continue "OP-06 First-Payroll Verification".

- Return payroll findings to ORCH-01; do not send Slack directly.
- ORCH-01 may route them only to OP-04's restricted workbench case action.
- Use one active case per payroll_id. For PAYROLL_RECORD_MISSING, use one active
  case per employee plus the literal first-payroll check; do not invent a cycle.
- Repeated runs update the same active case. A recurring signal after a human
  resolution reopens that case; a clear evaluation never auto-closes it.
- Store only the safe common finding fields. Never store error_reason, gross,
  net, or a manager channel.
- If the restricted route is unavailable, emit a system exception and stop the
  write; never fall back to a standard manager queue.
```

**Gate tests:** a Manager cannot list, fetch, or act on the payroll case even
when the employee is their direct report; People Ops/payroll can; the literal
source error text cannot be found in any standard API response, event, case, or
Slack output.

## 4. OP-07 — Cross-Team Readiness & Manager Accountability

Create one Operator named exactly
`OP-07 Cross-Team Readiness & Manager Accountability`. It has employee and
cohort modes.

### 7.1 — Day-1 dependencies and learning milestones

**Prompt:**

```text
Goal: evaluate standard operational Day-1 and learning risks without touching
confidential or payroll data.

Create "OP-07 Cross-Team Readiness & Manager Accountability" using deterministic
Code/Logic and Supabase custom REST only.

INPUT: common input contract. For this step require scope=employee and a valid
employee_id. Read the active policy and local as_of context using the common
rules.

STRICT DATA ALLOWLIST:
- Workers: Employee_ID, Hire_Date, jurisdiction, time_zone, cohort.
- Cross_Team_Dependencies: dep_id, employee_id, team, task, status,
  blocks_day_one.
- Learning_Milestones: milestone_id, employee_id, course, due_day, status.
Do not read Payroll_Records, Confidential_Cases, or Peakon Comment.

STEP 1 — Day-1 readiness.
- A dependency is blocking when blocks_day_one is boolean true and status is not
  Done, Completed, Complete, or Fulfilled (case-insensitive).
- Group all blocking rows into ONE DAY_ONE_DEPENDENCY_BLOCKED finding per
  employee, severity high, domain dependency.
- evidence_refs are dependency:<dep_id>; do not place task prose in events.

STEP 2 — Learning.
- Parse due_day only from exact case-insensitive "Day <non-negative integer>".
- due_date = Hire_Date + due_day calendar days.
- Status Completed or Complete is clear.
- A non-completed milestone is LEARNING_MILESTONE_OVERDUE only when
  as_of_local_date is strictly after due_date.
- Group all overdue rows into ONE finding per employee. Invalid due_day or Hire
  Date creates a data-quality system_exception, not a guessed deadline.

STEP 3 — Write idempotent policy_evaluations rows for each dependency and
milestone, including CLEAR outcomes. Return the common OP-07 envelope.
```

**Tests:**

| # | Scenario | Input | Expected |
|---|---|---|---|
| 1 | Three grouped blockers | `EMP7063`, `as_of=2026-08-03` | One `DAY_ONE_DEPENDENCY_BLOCKED` finding with `DEP-10253`, `DEP-10255`, `DEP-10256`; not three cases. |
| 2 | Three overdue milestones | `EMP7101`, same as-of | One `LEARNING_MILESTONE_OVERDUE` finding with `LRN-30304`, `LRN-30305`, `LRN-30306`. |
| 3 | Clean | `EMP7008` | No OP-07 finding: incomplete dependencies are not Day-1 blockers and all learning is complete. |
| 4 | Invalid due day | Controlled `due_day=Soon` | Data-quality exception; no guessed deadline. |
| 5 | Privacy | Place `SENTINEL_CONFIDENTIAL_XYZ` in a confidential Peakon comment | Sentinel cannot appear anywhere because this step never reads the column. |

### 7.2 — Cohort dependency bottlenecks

**Prompt:**

```text
Goal: add a privacy-safe cohort mode that reports a dependency bottleneck only
when both editable thresholds pass.

Continue "OP-07 Cross-Team Readiness & Manager Accountability".

When scope=cohort:
1. Require cohort and resolve the same active policy/as_of.
2. Read all Workers in the cohort, selecting only Employee_ID and cohort.
3. Denominator is the count of distinct cohort employees.
4. Read their Cross_Team_Dependencies using paginated REST and the strict field
   allowlist from step 7.1.
5. Include only active Day-1 blockers. Group by dependency team.
6. For each team compute distinct affected employee count and percentage =
   affected / denominator * 100.
7. Emit COHORT_DEPENDENCY_BOTTLENECK only when affected count is at least
   bottleneck_min_workers AND percentage is at least bottleneck_min_percent.
8. Output cohort, policy version, as_of, numerator, denominator, percentage,
   team, and safe dependency IDs. Do not output employee predictions, comments,
   or names.
9. Write an idempotent policy_evaluations row for each team, including teams
   suppressed by either threshold.

Missing/zero denominator, incomplete pagination, or invalid thresholds becomes
a system_exception. Never calculate from a partial first page.
```

**Tests:**

| # | Scenario | Setup | Expected |
|---|---|---|---|
| 1 | Both thresholds pass | `COH-2026-W22`, min workers <=14 and min percent <=73.7 | Security bottleneck: 14 of 19, about 73.7%; code `COHORT_DEPENDENCY_BOTTLENECK`. |
| 2 | Count suppresses | min workers 15 | No Security bottleneck. |
| 3 | Percent suppresses | min percent 75 | No Security bottleneck. |
| 4 | Pagination | Force dependency response to multiple pages | Same 14/19 result as unpaginated test. |

### 7.3 — Manager accountability state machine (G-03 required)

Do not paste this prompt until the server-owned state source named in G-03 is
live and its exact table/API fields have replaced the placeholders below.

**Prompt:**

```text
Goal: evaluate manager acknowledgment/action deadlines from authoritative
system state, never from an inferred behavioral signal.

Continue "OP-07 Cross-Team Readiness & Manager Accountability".

Read only the approved manager-action state source: {MANAGER_ACTION_STATE_API}.
Required fields are case_id, employee_id, current_state, nudge_created_at,
delivered_at, acknowledged_at, action_verified_at, escalated_at,
successful_reminder_count, next_reminder_at, acknowledgment_deadline,
action_deadline, and source_event_id. Do not read confidential or payroll cases.

Enforce this state machine:
nudge_created -> delivered -> acknowledged -> action_verified
                                      \-> escalated

- Slack/send success may create delivered only through an idempotent confirmed
  delivery event. A failed delivery does not increment successful_reminder_count
  and creates an operational system exception.
- MANAGER_ACKNOWLEDGMENT_OVERDUE fires only when a delivered standard case has no
  explicit acknowledgment after its policy-derived acknowledgment deadline.
- MANAGER_ACTION_OVERDUE fires only when an acknowledged standard case has no
  explicit verified action after its action deadline.
- Stop reminders at manager_max_reminders; then transition through the approved
  escalation write, never by merely returning prose.
- Repeated source_event_id values are idempotent.
- Peakon manager_response_days, a blank field, Slack delivery alone, or elapsed
  time without an authoritative case state can never prove manager neglect.
- Payroll and confidential case types are excluded before all manager logic.

Return safe findings and log policy evaluations. Never label an individual as
disengaged, negligent, or likely to resign.
```

**Tests:**

| State fixture | Expected |
|---|---|
| Delivered, deadline passed, no acknowledgment | `MANAGER_ACKNOWLEDGMENT_OVERDUE`. |
| Delivered, explicit acknowledgment before deadline | No acknowledgment finding. |
| Acknowledged, action deadline passed, no verified action | `MANAGER_ACTION_OVERDUE`. |
| Slack failure | Operational exception; reminder count unchanged. |
| Duplicate delivery event | One state transition; one successful reminder count. |
| Payroll/confidential case | Excluded from OP-07 manager path. |
| Only `Peakon_Engagement.manager_response_days=6` (for example `EMP7013`) but no authoritative action state | No manager-overdue finding. |

## 5. OP-01/02/03 — Active-policy compatibility amendment

This is a compatibility migration, not a rebuild. Apply it separately to each
saved Operator and rerun its Stage 1 regression suite before publishing.

**Prompt for OP-01, OP-02, and OP-03 (paste into each Operator separately):**

```text
Goal: migrate this existing Operator from legacy policy_config reads to the one
active versioned policy without changing its already-tested business behavior.

Continue the current saved Operator. Do not create a replacement workflow.

1. At the start, GET policy_versions where status=active, selecting only
   version_id, config_snapshot, activated_at, limit 2. Require exactly one row.
2. Read the same existing threshold/normalization/routing value from the
   equivalent location inside config_snapshot. Do not read a draft and do not
   combine values from legacy policy_config with the active version.
3. Preserve existing reason codes, deterministic Code steps, input/output fields,
   Typeform single-submission behavior, and confidentiality rules.
4. Add policy_version_id and evaluated_at to the safe output. Preserve the
   existing legacy reasons projection expected by ORCH-01.
5. For every rule decision, upsert an idempotent policy_evaluations row using the
   common safe logging contract, including CLEAR outcomes. OP-01 normalization
   and dedup decisions log only safe field/rule identifiers, never form prose.
6. Missing active policy/key creates a system_exception and stops the affected
   decision. Never fall back silently to legacy policy_config.
```

**Regression tests:** OP-01 still passes its five saved intake cases and its
Typeform polling parent still fans out one submission at a time; OP-02 still
returns its four registered Round 1 reason codes on the original fixtures;
OP-03 still passes the low-score and confidential-disclosure fixtures, including
the literal sentinel leak test. For one safe fixture per Operator, change an
applicable threshold through an approved active version and prove the outcome
and logged policy version change together.

## 6. OP-04 — Round 2 routing amendments

Continue the existing `OP-04 Escalation & Notification`; do not create a second
notification Operator.

### 4.R2.1 — Known-code routing and grouped case upsert

**Prompt:**

```text
Goal: extend OP-04 for Round 2 reason codes while preserving a single governed
writer for cases and notifications.

Continue "OP-04 Escalation & Notification". Keep all existing Round 1 routing,
retry, demo_mode, audit, and confidentiality guards.

At the start, use the one active policy_versions config_snapshot for registered
codes, routing, templates, retry, and demo_mode. Verify parity first, then stop
mixing values from legacy policy_config with the active version. Missing required
keys create a system exception; never use a silent legacy fallback.

Accept only reason codes in the active policy's registered reason_codes and the
engineering registry. Route by code, never by severity alone:
- COMPLIANCE_DEADLINE_AT_RISK, COMPLIANCE_LEGAL_BREACH,
  WORK_AUTH_EXPIRY_AT_RISK, WORK_AUTH_EXPIRED -> People Ops compliance Workbench;
  no manager notification unless a separately approved policy explicitly adds a
  safe standard route.
- PAYROLL_ERROR_DETECTED, PAYROLL_NOT_CONFIRMED, PAYROLL_RECORD_MISSING ->
  restricted People Ops/payroll Workbench only; never manager Slack.
- DAY_ONE_DEPENDENCY_BLOCKED -> standard Day-1 Workbench and approved dependency
  owner route.
- LEARNING_MILESTONE_OVERDUE -> standard manager-to-People-Ops route.
- MANAGER_ACKNOWLEDGMENT_OVERDUE, MANAGER_ACTION_OVERDUE -> People Ops
  accountability escalation, not another nudge to the same manager.
- COHORT_DEPENDENCY_BOTTLENECK -> cohort insight/audit only; do not create one
  employee case per cohort signal.
- Unknown code -> system_exception Workbench only; send no Slack message.

Case identity and lifecycle:
- compliance/work authorization: one deterministic case per employee +
  jurisdiction, combining current safe reason codes/evidence refs;
- Day-1 readiness: one deterministic case per employee, combining blockers;
- learning: one deterministic case per employee + learning domain;
- payroll: follow gated step 6.3;
- update/reopen the same case on recurring risk; never create duplicates;
- a clear automated run never resolves a human-close case.

Store only fields allowed by the workbench case contract. Every Slack or
Supabase write uses the active retry/demo profile. Integration failure creates a
safe operational exception; it does not silently change the business outcome.
```

**Tests:** each new known code reaches only its allowed route; repeating the same
employee/jurisdiction blockers updates one case; an unknown code sends no Slack;
payroll never reaches manager; a resolved recurring compliance risk reopens the
same case; clear evaluation does not auto-close it.

### 4.R2.2 — Confidential independence regression

**Prompt:**

```text
Goal: preserve zero leakage while allowing independent standard risks to proceed.

Amend OP-04/ORCH behavior so a confidential signal creates a separate restricted
confidential case and message. It must not suppress a simultaneous compliance,
payroll, Day-1, or learning case for the same employee.

Never interpolate confidential comment_text or driver into any standard or
restricted message. The confidential message may contain only employee_id,
milestone, and secure case link/reference. Standard branches may contain only
their own safe findings and may not read internal_case_payload.
```

**Tests:** send a combined input containing `SENTINEL_SECRET_HEALTH_XYZ` plus a
Day-1 blocker. Expect one confidential route and one standard Day-1 route; the
sentinel is absent from all standard cases/messages/events and absent from the
confidential alert text itself.

## 7. ORCH-01 — Round 2 orchestration

Continue the existing Orchestrator. It coordinates Operators and performs no
direct source-system or Slack reads/writes.

### O.1 — Parallel fan-out and deterministic merge

**Prompt:**

```text
Goal: extend the existing HR Orchestrator with parallel Round 2 evaluation while
keeping external I/O inside specialized Operators.

Continue the existing ORCH-01. Do not create a new Orchestrator.

For scope=employee:
1. Validate the common input contract.
2. Start independent evaluation branches in parallel:
   - existing OP-02/OP-03 paths required by the saved Round 1 design;
   - OP-05 Compliance & Work Authorization;
   - OP-06 First-Payroll Verification;
   - OP-07 Cross-Team Readiness & Manager Accountability in employee mode.
   OP-01 remains Typeform-triggered through its existing polling parent and is
   not fabricated for employees without a submission.
3. Wait for all branches and merge their safe envelopes in deterministic
   operator-id order. Deduplicate findings by operator_id + reason_code +
   employee_id; union safe evidence_refs.
4. Partial failure does not erase successful independent findings. Add the
   failed branch's safe system exception.
5. Apply non-overridable safety separation: confidential work remains separate
   and never suppresses simultaneous standard findings.
6. Route each known code to OP-04. Unknown codes route only as a system exception.
7. Return a final safe summary with operators_completed, operators_failed,
   findings, reasons, policy_version_ids, and case IDs. No narrative payloads.

ORCH-01 must not query Supabase or send Slack directly. OP-04 remains the single
case/notification writer.
```

**Tests:**

| # | Scenario | Expected |
|---|---|---|
| 1 | Multi-domain employee (`EMP7032`) | OP-05 and OP-06 results both survive merge; routes remain separate. |
| 2 | One branch fails | Other valid branches still produce cases; failed branch becomes system exception. |
| 3 | Duplicate finding delivery | One merged finding and one idempotent case. |
| 4 | Unknown reason code | No action except system exception. |
| 5 | Confidential + standard | Both independent routes execute; no sensitive cross-branch data. |

### O.2 — Command event correlation

**Prompt:**

```text
Goal: make ORCH-01 observable by the Command Center without exposing raw data.

Continue ORCH-01.

- Preserve command_id from Command Center input as execution_id.
- Emit safe queued/running/terminal events with stable event IDs and source event
  IDs. For Command Center runs, call the approved persist_workflow_event RPC so
  event persistence and command status transition are atomic.
- Emit per-Operator finding events only with registered reason codes and details
  {"source":"auto_workflow"}. Never include REST responses or finding prose.
- End exactly once as completed, failed, or cancelled. A cancellation request
  prevents new downstream actions.
- For scheduled/Typeform runs without command_id, preserve the stable Auto run ID
  as execution_id so the FastAPI reconciler can discover and correlate the run.
```

**Tests:** raw Activity Timeline and Supabase show stable correlation; replaying a
source event does not add a second event; SSE reconnect resumes after the last
monotonic sequence; terminal state is emitted once.

## 8. Daily cohort sweep parent workflow

Create a parent workflow named exactly `HR Ops Daily Cohort Sweep`. It is a
scheduler/fan-out workflow, not an eighth business Operator.

### S.1 — Schedule, bounded fan-out, and cohort aggregation

**Prompt:**

```text
Goal: evaluate the active onboarding cohort daily through ORCH-01 and then build
privacy-safe cohort bottlenecks.

Create a Parent Workflow named "HR Ops Daily Cohort Sweep".

TRIGGER: every day at 09:00 UTC. Also allow an explicit manual test trigger.

1. Read the one active policy and resolve one run-level as_of instant.
2. Read Workers through paginated Supabase REST. Select only Employee_ID,
   Hire_Date, cohort, jurisdiction, time_zone. Define the active onboarding
   cohort as employees from Day 0 through Day 90 inclusive at the shared as_of
   local date. Invalid/missing dates become system exceptions; do not guess.
3. Create one stable parent execution ID. Invoke ORCH-01 once per eligible
   employee with trigger_source=daily_schedule. Use bounded parallelism supported
   by Auto; do not launch an unbounded burst.
4. Retry only failed invocations according to active retry/demo policy. Reusing
   the same child execution ID must be idempotent.
5. After employee fan-out settles, invoke OP-07 once per represented cohort with
   scope=cohort to evaluate bottlenecks.
6. Return counts for eligible, completed, failed, findings, and cohorts. Never
   include names, comments, payroll details, or confidential payloads.
7. Record a discoverable safe run/event trail using the stable Auto run ID.
```

**Tests:** manual run uses one shared as_of; pagination includes all eligible
workers; one failed child retry does not duplicate cases; `COH-2026-W22` produces
the seeded Security 14/19 bottleneck under permissive thresholds; demo_mode
fails fast; scheduled run is later visible through FastAPI reconciliation.

## 9. End-to-end acceptance suite

Do not mark the build complete until these are captured from live Auto Activity
Timeline plus Supabase/API evidence.

| Gate | Required proof |
|---|---|
| Architecture | One Orchestrator calls at least five distinct Operators; Round 2 branches run in parallel; scheduled and stateful behavior are visible. |
| Live data | Operators read Supabase via custom REST, never CSV/Airtable/native DB blocks. |
| Policy | At least three editable active policies measurably change outcomes; every evaluation records policy version and as_of. |
| Workbench | A real exception is created, claimed/acknowledged, and human-resolved; recurring risk reopens rather than duplicates. |
| Integrations | Supabase REST plus native Slack and native Typeform polling are live (three integrations across source/channel categories). |
| Privacy | Confidential sentinel and payroll sentinel are absent from dashboard, standard queue, events, logs, client responses, and message text. |
| Idempotency | Retrying the same source/execution IDs does not duplicate evaluations, cases, state transitions, or notifications. |
| Degraded mode | One Operator/integration failure creates an observable system exception while independent safe branches continue. |
| Generality | Tests use rule-based logic and several employees/cohorts; no behavior is hard-coded to fixture IDs. |

## 10. Build status tracker

Update this table after each saved builder version and test. Put the Activity
Timeline run ID or other evidence link in the last column; `builder says done`
is not evidence.

| ID | Workflow | Build step | Person A | Person B | Dependency | Build | Tests | Evidence / notes |
|---|---|---|---|---|---|---|---|---|
| G-01 | Policy Studio | Activate complete Round 2 policy | Review/activate | Validate contract | None | Done | Passed (69 focused) | `policy_round2_v1` is activated; user-confirmed live |
| G-02 | Command Center | Restrict payroll case RBAC | Supply live route test | Implement RBAC | Backend | Done | Passed (60 focused; 144 full; live local JWT) | `people_ops_payroll` is provisioned separately; payroll token receives 403 from Admin APIs |
| G-03 | Command Center | Publish manager action-state contract | Supply Auto needs | Implement contract | Backend | Done | Passed (unit + clean-install SQL smoke) | Latest additive schema was applied to live Supabase; user-confirmed |
| UI | Command Center | Policy Studio, Workbench, Dashboard, Data Manager | Build/live-test | Publish APIs | G-01/G-02/G-03 contracts | Done | Production build and local Keycloak provider passed | All user-facing copy is English; protected pages redirect to sign-in |
| 5.1 | OP-05 | Context/policy/timezone | Build | Fixture support | G-01 | Saved | Partial | Valid-employee test completed end-to-end; `EMP-NOT-FOUND` safely returns a system exception but currently receives Supabase REST 401 instead of `WORKER_NOT_FOUND`. |
| 5.2 | OP-05 | Compliance/work-auth rules + logs | Build/test | Verify persisted log | 5.1 | Saved | Partial | `EMP7054` completed with the expected compliance legal-breach finding after jurisdiction-threshold parsing was corrected; remaining rule, persistence, and idempotency tests pending. |
| 5.3 | OP-05 | Partial failure behavior | Build/test | Verify safe API result | 5.2 | Done | Passed (3/3) | All 3 tests passed: stop-on-read-failure (`EMP-NOT-FOUND`), item-level isolation (`EMP7032` + malformed clone), and write-retry-then-integration-failure. Fixed a state-propagation bug in `evaluate_compliance_context` — `worker_found`/`policy_version_id`/`as_of_local_date` were never written to `workflow_step_state`, only passed locally to `display_results()`, causing downstream to always see the upstream context as missing. |
| 6.1 | OP-06 | Restricted context/read | Build/test | Privacy review | G-01 | Saved | Not started | Initial context/read workflow saved; privacy and fixture tests pending. |
| 6.2 | OP-06 | Payroll rules + logs | Build/test | Verify persisted log | 6.1 | Not started | Not started | |
| 6.3 | OP-06/OP-04 | Restricted payroll case route | Build after gate | Prove G-02 | G-02, 6.2 | Ready after 6.2 | Not started | G-02 is satisfied; do not bypass the restricted route |
| 7.1 | OP-07 | Dependencies + learning | Build/test | Fixture support | G-01 | Saved | Not started | Initial employee-mode workflow saved; dependency, learning, and privacy tests pending. |
| 7.2 | OP-07 | Cohort bottlenecks | Build/test | Verify API parity | 7.1 | Not started | Not started | |
| 7.3 | OP-07 | Manager state machine | Build after gate | Prove G-03 | G-03, 7.1 | Ready after 7.1 | Not started | G-03 is satisfied; do not infer from Peakon |
| C.1 | OP-01 | Active-policy compatibility | Build/regression | Verify policy log | G-01 | Not started | Not started | |
| C.2 | OP-02 | Active-policy compatibility | Build/regression | Verify policy log | G-01 | Not started | Not started | |
| C.3 | OP-03 | Active-policy compatibility | Build/privacy regression | Verify policy log | G-01 | Not started | Not started | |
| 4.R2.1 | OP-04 | New-code routing/grouped cases | Build/test | Verify Workbench API | 5.2, 6.2, 7.1 | Not started | Not started | |
| 4.R2.2 | OP-04 | Confidential independence | Build/test | Privacy review | 4.R2.1 | Not started | Not started | |
| O.1 | ORCH-01 | Parallel fan-out/merge | Build/test | Observe mocks/API | OP-05/06/07 unit tests | Not started | Not started | |
| O.2 | ORCH-01 | Command/event correlation | Build/live test | Verify SSE/reconcile | O.1, G-04 | Not started | Not started | |
| S.1 | Daily Sweep | Schedule/fan-out/aggregation | Build/live test | Verify discovery | O.2, 7.2 | Not started | Not started | |
| E2E | All | End-to-end acceptance suite | Auto evidence | API/privacy evidence | All gates | Not started | Not started | |
