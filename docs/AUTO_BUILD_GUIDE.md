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

Field yang sama di semua baris: `command_id` = sama dengan `execution_id`;
`trigger_source` = `command_center`; pin `as_of_date="2026-08-03"`.

| Urutan | Scenario | employee_id | execution_id | Expected output | Tindakan tambahan sebelum run |
|---|---|---|---|---|---|
| 1 | Baca status Error (tanpa bocor detail) | `EMP7062` | `cmd_a3408d6c818e7e633873fab74c2b3b2d` | Output berisi `PAY-40063`, status `Error`, `cutoff_date=2026-06-26` (Hire_Date `2026-05-27` + 30 hari); tidak ada `error_reason`, `gross`, atau `net` di manapun (variabel, output, Activity Timeline) | Tidak ada |
| 2 | Baca status Paid | `EMP7008` | `cmd_0d84b4010c4fb7be79e79ccd220fb5ca` | Output berisi `PAY-40009`, status `Paid`, `cutoff_date=2026-07-25` (Hire_Date `2026-06-25` + 30 hari) | Tidak ada |
| 3 | Sentinel tidak boleh bocor | `EMP7062` | `cmd_aab69ff2ad9ad591b4c7732ef5eb3d23` | Output tetap seperti test #1; string `PAYROLL_SECRET_XYZ` **tidak muncul** di variabel Operator, output, Activity Timeline, atau `workflow_events` — buktikan `error_reason` memang tidak pernah di-select | Sebelum run: `update "Payroll_Records" set error_reason = 'PAYROLL_SECRET_XYZ - temporary test marker' where payroll_id = 'PAY-40063';`. Setelah run, kembalikan: `update "Payroll_Records" set error_reason = 'Bank account validation failed; first salary not disbursed' where payroll_id = 'PAY-40063';` |

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

Field yang sama di semua baris: `command_id` = sama dengan `execution_id`;
`trigger_source` = `command_center`. `first_payroll_cutoff_days` aktif = 30
(default, tanpa override jurisdiksi) kecuali disebutkan lain.

| Urutan | Scenario | employee_id | execution_id | Expected output | Tindakan tambahan sebelum run |
|---|---|---|---|---|---|
| 1 | Error → critical, abaikan cutoff | `EMP7062` | `cmd_9f1e81e4a8e8d174cfb1b8992931d5b5` | `PAYROLL_ERROR_DETECTED`, severity critical, domain payroll; evidence `payroll:PAY-40063`; tidak ada `error_reason`/`gross`/`net` di mana pun | Pin `as_of_date="2026-08-03"` |
| 2 | Pending, cutoff sudah lewat | `EMP7001` | `cmd_42932cbe315059e061d324a13f7b4358` | `PAYROLL_NOT_CONFIRMED`, severity high; cutoff `2026-07-16` (Hire `2026-06-16`+30), `as_of=2026-08-03` sudah lewat cutoff | Pin `as_of_date="2026-08-03"` |
| 3 | Pending, cutoff belum lewat | `EMP7045` | `cmd_e8ac6bd34ab175c8e8819a8e38330ddd` | CLEAR; cutoff `2026-09-01` (Hire `2026-08-02`+30) belum lewat pada `as_of=2026-08-03` | Pin `as_of_date="2026-08-03"` |
| 4 | Paid → selalu CLEAR | `EMP7008` | `cmd_d3ba5c7e742bb034d40d17a8569a4b30` | CLEAR; cutoff `2026-07-25` (Hire `2026-06-25`+30) diabaikan karena status Paid | Pin `as_of_date="2026-08-03"` |
| 5 | Tidak ada payroll row, cutoff sudah lewat | `EMP7000` | `cmd_784fbccb23c413463577522c3640089c` | `PAYROLL_RECORD_MISSING`, severity high; evidence hanya `worker:EMP7000`; cutoff `2026-06-25` (Hire `2026-05-26`+30) sudah lewat pada `as_of=2026-08-03` | Pin `as_of_date="2026-08-03"`. Hapus sementara payroll row: `delete from "Payroll_Records" where payroll_id='PAY-40001';` |
| 6 | Tidak ada payroll row, cutoff belum lewat | `EMP7000` (fixture sama, payroll row masih dihapus) | `cmd_35bc9e9baf3b3df9f7799120cd34f3fb` | CLEAR; cutoff `2026-06-25` belum lewat pada `as_of` yang dipin | Pin `as_of_date="2026-06-01"` (payroll row `EMP7000` tetap dihapus dari test #5) |
| 7a | Perubahan policy — versi cutoff lama | `EMP7001` | `cmd_b4156fabb39b28ea9d483eb59c927b61` | `PAYROLL_NOT_CONFIRMED` (sama seperti #2); baris `policy_evaluations` mencatat `policy_version_id` aktif saat ini | Pin `as_of_date="2026-08-03"`; jalankan dengan `policy_round2_v1` (cutoff default 30) masih aktif |
| 7b | Perubahan policy — versi cutoff baru | `EMP7001` | `cmd_78857487ca8a618f72d4c6ca950c7a68` | CLEAR; cutoff baru `2026-08-15` (Hire `2026-06-16`+60) belum lewat pada `as_of=2026-08-03` — buktikan hasil berubah murni karena versi policy, bukan karena data worker/payroll berubah | Buat draft policy baru via Policy Studio dengan `first_payroll_cutoff_days.default=60`, simulate → approve → activate (menggantikan `policy_round2_v1` sebagai active); setelah test, kembalikan `policy_round2_v1` sebagai active |

Setelah baris #7b, pastikan `policy_round2_v1` (cutoff 30) sudah diaktifkan
kembali dan payroll row `EMP7000` sudah dipulihkan sebelum lanjut ke stage
lain:

```sql
insert into "Payroll_Records" (payroll_id, employee_id, cycle, gross, net, status, error_reason)
values ('PAY-40001', 'EMP7000', '2026-06', 6000, 4693.53, 'Paid', null);
```

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

**Tests:**

Field yang sama di semua baris: `command_id` = sama dengan `execution_id`;
`trigger_source` = `command_center`; pin `as_of_date="2026-08-03"`.

| Urutan | Scenario | employee_id | execution_id | Expected output | Tindakan tambahan sebelum run |
|---|---|---|---|---|---|
| 1 | Case dibuat untuk Error | `EMP7062` | `cmd_5d164bd8b72dd632465fdd4d582c132d` | Satu `workbench_cases` baru dengan `case_type=payroll`, terkait `payroll_id=PAY-40063`; `sanitized_context` hanya berisi field aman (outcome, evidence, severity) | Tidak ada |
| 2 | Case dibuat untuk Not Confirmed | `EMP7001` | `cmd_18a65e81d805f6164ce2d9c220b1015d` | Satu `workbench_cases` baru terkait `payroll_id=PAY-40002` | Tidak ada |
| 3 | Case per-employee untuk Record Missing | `EMP7000` | `cmd_f8a02873f949cd97d422bdadb0f76ca7` | Satu `workbench_cases` baru terkait `employee_id=EMP7000` (bukan per payroll_id, karena tidak ada row payroll); `sanitized_context` tidak berisi cycle yang direka-reka | Hapus sementara payroll row: `delete from "Payroll_Records" where payroll_id='PAY-40001';` |
| 4 | Run berulang → update case yang sama | `EMP7062` | `cmd_db7b28da7cf6619911b33f2f39ff61a0` | Masih **tepat satu** `workbench_cases` untuk `payroll_id=PAY-40063` (bukan case baru); `updated_at`/isi berubah, `case_id` tetap sama seperti test #1 | Jalankan langsung setelah #1, tanpa ubah data |
| 5 | Sinyal berulang setelah resolusi manusia → reopen | `EMP7062` | `cmd_a8f8e919d606849131f26d5c95c17707` | Case `PAY-40063` yang tadinya di-resolve kembali `status=open` (reopened), bukan case baru | Sebelum run: `update "workbench_cases" set status='resolved', resolved_at=now() where case_id=<case_id dari test #1>;` |
| 6 | CLEAR tidak pernah auto-close case | `EMP7000` | `cmd_fa57a4fe93466f1a8efc53eba72edf10` | Case employee `EMP7000` dari test #3 **tetap terbuka** (status tidak berubah jadi resolved secara otomatis) meski hasil evaluasi sekarang CLEAR | Kembalikan payroll row `EMP7000` (`insert` seperti catatan di bawah §6.2) supaya hasil jadi Paid/CLEAR; jangan resolve case secara manual |
| 7 | Tidak ada field sensitif tersimpan | `EMP7062` | `cmd_2aa9133471927cf0f28dbc6d908bf475` | Query langsung `workbench_cases` untuk case `PAY-40063`: pastikan **tidak ada** `error_reason`, `gross`, atau `net` di `sanitized_context` mana pun, walau sumber datanya (`Payroll_Records.error_reason`) mengandung teks tersebut | Jalankan setelah test #1/#4, cek langsung isi `sanitized_context` via SQL |
| 8 | Restricted route tidak tersedia → system_exception, tanpa fallback | `EMP7001` | `cmd_647b25dc7121f5eb4f12855850fc6031` | Satu `system_exception` operasional; **tidak ada** case baru/terupdate di `workbench_cases` maupun tabel manager-visible mana pun — buktikan tidak fallback ke antrian manager standar | Sebelum run, arahkan sementara endpoint tulis OP-04 restricted case action ke path yang salah (typo); kembalikan setelah test |

RBAC-nya sendiri (Manager tidak bisa list/fetch/act atas case payroll walau dia manager langsung karyawan tsb; People Ops/payroll bisa) sudah dibuktikan generik oleh G-02 (lihat tracker: Done, 60 focused + 144 full test, live local JWT). Untuk 6.3 cukup satu langkah verifikasi tambahan: pakai `case_id` hasil test #1 di atas, coba `GET`/`PATCH` case itu dengan JWT Manager biasa (harus 403) dan dengan JWT `people_ops_payroll` (harus berhasil) — tidak perlu mengulang seluruh suite G-02.

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

Field yang sama di semua baris: `scope=employee`; `command_id` = sama dengan
`execution_id`; `trigger_source` = `command_center`; pin `as_of_date="2026-08-03"`.

| Urutan | Scenario | employee_id | execution_id | Expected output | Tindakan tambahan sebelum run |
|---|---|---|---|---|---|
| 1 | Grouped Day-1 blockers (+ learning ikut nyata) | `EMP7063` | `cmd_7f7544c380d7e2b1797efb005d7c9652` | Satu `DAY_ONE_DEPENDENCY_BLOCKED` dengan evidence `DEP-10253`, `DEP-10255`, `DEP-10256` (bukan 3 finding terpisah); juga satu `LEARNING_MILESTONE_OVERDUE` nyata dengan `LRN-30190`, `LRN-30192` (due `2026-06-02`/`2026-07-25`, keduanya sebelum `as_of`) — ini bukan bug, dataset EMP7063 memang punya keduanya | Tidak ada |
| 2 | Tiga milestone overdue (+ 1 dependency blocked ikut nyata) | `EMP7101` | `cmd_69f62f3d238b0491e49856589272a006` | Satu `LEARNING_MILESTONE_OVERDUE` dengan evidence `LRN-30304`, `LRN-30305`, `LRN-30306` (due `2026-05-13`/`2026-06-05`/`2026-07-05`, semua sebelum `as_of`); juga satu `DAY_ONE_DEPENDENCY_BLOCKED` dengan `DEP-10407` saja (`DEP-10408` sudah Done, tidak ikut) | Tidak ada |
| 3 | Bersih | `EMP7008` | `cmd_a39ceefc8af272b1144306aac4d34d0e` | Tidak ada finding OP-07 sama sekali: dependency `EMP7008` yang belum Done semuanya `blocks_day_one=false`; semua learning milestone Completed | Tidak ada |
| 4 | `due_day` tidak valid | `EMP7000` | `cmd_fb67a5b04ad5449ac05655ce15ab077e` | Satu data-quality `system_exception` untuk milestone clone (tidak ada deadline yang ditebak); finding nyata `EMP7000` yang lain (`DAY_ONE_DEPENDENCY_BLOCKED` dari `DEP-10002`/`DEP-10003`, `LEARNING_MILESTONE_OVERDUE` dari `LRN-30002`) tetap muncul — buktikan item invalid tidak menghentikan evaluasi item lain | Clone milestone: `insert into "Learning_Milestones" (milestone_id, employee_id, course, due_day, status) values ('LRN-30001-INVALID', 'EMP7000', 'Test Invalid Due Day', 'Soon', 'In Progress');`. Setelah test, hapus: `delete from "Learning_Milestones" where milestone_id='LRN-30001-INVALID';` |
| 5 | Privacy — sentinel tidak boleh bocor | `EMP7000` | `cmd_5add517dc16905b95ce66613934cc8fb` | Findings sama seperti data asli `EMP7000` (tanpa clone test #4); string `SENTINEL_CONFIDENTIAL_XYZ` **tidak muncul** di variabel Operator, output, Activity Timeline, atau `workflow_events` — buktikan kolom `Comment`/Peakon memang tidak pernah dibaca step ini | Sebelum run: `update "Peakon_Engagement" set "Comment" = 'SENTINEL_CONFIDENTIAL_XYZ - temporary test marker' where "Response_ID" = 'PK-5001';`. Setelah run, kembalikan: `update "Peakon_Engagement" set "Comment" = 'Good start, team is welcoming.' where "Response_ID" = 'PK-5001';` |

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

**Input contract (form test 7.2):**

| Field | Wajib | Isi | Perilaku kalau kosong |
|---|---|---|---|
| `scope` | **Ya** | `cohort` atau `employee` | `input_validation` system_exception; tidak ada read apa pun |
| `cohort` | Ya saat `scope=cohort` | mis. `COH-2026-W22` | `input_validation` system_exception |
| `employee_id` | Ya saat `scope=employee` | mis. `EMP7063` | diabaikan saat `scope=cohort` |
| `min_workers_for_bottleneck` | Tidak | integer ≥ 1 | pakai `thresholds.bottleneck_min_workers` dari policy aktif |
| `min_percent_for_bottleneck` | Tidak | angka 0–100 | pakai `thresholds.bottleneck_min_percent` dari policy aktif |

Aturan yang mengikat kedua field threshold:

- Kosong berarti **baca policy aktif**, bukan "pakai default hard-coded". Nilai
  kosong tidak boleh berubah jadi 2/25 di dalam Code step.
- Nilai yang diisi adalah **override khusus test**. Run terjadwal (`daily_schedule`)
  dan run Command Center produksi harus mengirim kedua field ini kosong; kalau
  terisi, Operator wajib menandai barisnya (mis. `threshold_source="input_override"`)
  di `policy_evaluations` supaya audit tidak salah membaca hasil override sebagai
  hasil policy aktif. Gate "Policy" di §9 hanya boleh dibuktikan lewat baris
  #16/#17 (perubahan versi policy), bukan lewat override input.
- Invalid = non-numerik, negatif, `min_workers=0`, atau `min_percent` di luar
  0–100 → `system_exception`; jangan jatuh balik ke nilai policy dan jangan
  menebak.
- `scope=employee` mengabaikan `cohort` dan kedua threshold; jalurnya persis §7.1.

**Tests — essentials (live, di Auto Studio):**

Dipangkas dari 18 ke 7 baris: yang tersisa di sini adalah skenario yang
kebenarannya bergantung pada **eksekusi nyata** (agregasi REST atas data
sungguhan, interaksi dua threshold, filter dua kondisi bersamaan, paginasi,
retensi lintas versi policy) — bukan cuma satu cabang early-return yang bisa
dipastikan benar dengan membaca kondisinya di Code step. Skenario early-return
lain ada di tabel "Cakupan tambahan lewat code review" di bawah.

Field yang sama di semua baris: `command_id` = sama dengan `execution_id`;
`trigger_source` = `command_center`; pin `as_of_date="2026-08-03"`. `—` berarti
field dikosongkan. Denominator = jumlah worker distinct di cohort tsb pada
`Workers` (`COH-2026-W22`=19, `W29`=17, `W17`=4, `W26`=2). Jalankan sesuai
kolom **Urutan**: baris #7 mengubah policy yang sedang aktif, jadi ditaruh
paling akhir.

| Urutan | Scenario | scope | employee_id | cohort | min_workers | min_percent | execution_id | Expected output | Tindakan tambahan sebelum run |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Validasi input — representatif untuk seluruh keluarga early-return | `cohort` | — | — | — | — | `cmd_98723f43a527b55df346f242eb52be62` | Satu `input_validation` system_exception; **tidak ada** read Workers/Cross_Team_Dependencies sama sekali di Activity Timeline; `findings: []` | Tidak ada |
| 2 | Baseline policy default (kedua threshold lolos) | `cohort` | — | `COH-2026-W22` | — | — | `cmd_aeea9486642a9a82056cd2fb63af451a` | Satu `COHORT_DEPENDENCY_BOTTLENECK` untuk team **Security 14/19 (73.68%)**. Team lain ditulis sebagai suppressed, bukan dihilangkan: Facilities 4/19 (21.05%), IT 3/19 (15.79%), Payroll 1/19 (5.26%) → total 4 baris `policy_evaluations` team. Output hanya berisi cohort/team/angka/dep_id — tanpa nama, komentar, atau prediksi employee | Tidak ada (policy default `bottleneck_min_workers=2`, `bottleneck_min_percent=25`) |
| 3 | Dua band threshold dalam satu run (AND, bukan OR) | `cohort` | — | `COH-2026-W29` | — | — | `cmd_dfe4f462a6a0965a98c189c154c82a37` | Hanya Security yang fire: 5/17 (29.41%). Facilities 4/17 (23.53%) **suppressed karena persen** walau count 4 ≥ 2 — buktikan kedua threshold dievaluasi AND. IT 3/17 (17.65%) dan Payroll 1/17 (5.88%) juga suppressed | Tidak ada |
| 4 | Boundary — tepat di ambang, inklusif | `cohort` | — | `COH-2026-W17` | `1` | `25` | `cmd_08c538b141d4d8fd6d8f71e8757ba82c` | Security **1/4 = 25.00%** fire: count `1 ≥ 1` dan persen `25.00 ≥ 25` (perbandingan harus `≥`, bukan `>`); evidence `DEP-10112` | Tidak ada |
| 5 | Cohort bersih — filter dua kondisi bersamaan | `cohort` | — | `COH-2026-W26` | `1` | `1` | `cmd_de75c8c5850c3174014a0952037280d0` | Tidak ada finding sama sekali walau threshold dibuat serendah mungkin: `DEP-10036` Blocked tapi `blocks_day_one=false`, `DEP-10226`/`DEP-10228` `blocks_day_one=true` tapi sudah Done. Denominator tetap dilaporkan 2 (bukan exception) | Tidak ada |
| 6 | Paginasi REST — **SKIPPED, blocked** | `cohort` | — | `COH-2026-W22` | — | — | `cmd_e098a82b32fb70a0f210c4927999c884` | Hasil identik baris #2 (Security 14/19, 4 baris team); buktikan tidak ada data hilang akibat membaca halaman pertama saja | Tidak bisa dites tanpa perubahan kode dulu: query cohort saat ini cuma chunking daftar `employee_id` untuk filter `in.()` (`chunk_size=200`), bukan paginasi hasil (`limit`/`offset`) pada `Cross_Team_Dependencies` itu sendiri — untuk 19 worker di `COH-2026-W22`, semua ID muat dalam satu chunk sehingga jadi tepat satu HTTP call tanpa `limit`/`offset` yang bisa dikecilkan. Perlu prompt fix builder dulu untuk menambah loop `limit`/`offset` yang sesungguhnya sebelum test ini bisa dijalankan |
| 7 | Governance — suppressed tetap tercatat lintas versi policy | `cohort` | — | `COH-2026-W22` | — | — | `cmd_562b0899a4903848b39e124b06f6df63` | Tidak ada bottleneck Security (14 < 15) meski persen lolos; baris `policy_evaluations` Security tetap ditulis sebagai suppressed dan mencatat `policy_version_id` **baru** (beda dengan baris #2) | Buat draft policy baru via Policy Studio dengan `bottleneck_min_workers=15`, simulate → approve → activate; kedua field threshold di form **harus kosong**; setelah test, kembalikan `policy_round2_v1` sebagai active |

Setelah baris #7, pastikan `policy_round2_v1` (thresholds default:
`bottleneck_min_workers=2`, `bottleneck_min_percent=25`) sudah diaktifkan
kembali, dan page size REST di baris #6 sudah dikembalikan, sebelum lanjut ke
test/stage lain.

**Cakupan tambahan lewat code review (tidak perlu live test):**

Setiap baris ini adalah satu cabang early-return atau satu operator
perbandingan yang benar/salahnya terlihat langsung dari membaca Code step —
tidak perlu dijalankan live selama polanya sudah dibuktikan sekali di tabel
di atas. Buka step-nya di Auto Studio dan cocokkan kondisinya satu-satu:

| Skenario (dari draf 18-baris sebelumnya) | Yang dicek di Code step |
|---|---|
| `scope` kosong | Cabang scope kosong/tidak dikenal mengembalikan `system_exception` sebelum read apa pun — pola sama seperti baris #1 di atas, hanya beda field yang kosong |
| Cohort tidak dikenal (denominator 0) | Ada guard eksplisit `denominator == 0 → system_exception` sebelum divisi persentase mana pun |
| `scope=employee` — cohort/threshold diabaikan | Cabang `scope=employee` memanggil ulang jalur §7.1 dan tidak menyentuh variabel `cohort`/threshold sama sekali |
| `employee_id` tidak mempersempit denominator saat `scope=cohort` | Query Workers/Cross_Team_Dependencies pada cabang cohort tidak difilter oleh `employee_id` |
| Boundary — hanya count yang menekan | Operator perbandingan count memakai `≥` yang sama dengan yang sudah diverifikasi di baris #4 |
| Boundary — hanya persen yang menekan | Operator perbandingan persen memakai `≥` yang sama dengan yang sudah diverifikasi di baris #4 |
| Cohort kecil (mis. W20) tetap dihitung apa adanya | Tidak ada special-case ukuran cohort minimum di logika agregasi — jalur sama seperti baris #2/#3 |
| `min_workers=0` ditolak | Validasi numerik mensyaratkan `>= 1`, bukan cuma `>= 0` |
| Threshold non-numerik/negatif | Ada type-check + sign-check eksplisit sebelum threshold dipakai, tanpa fallback diam-diam ke nilai policy |
| `min_percent` di luar 0–100 | Ada range-check `0 <= x <= 100` eksplisit, terpisah dari validasi `min_workers` |
| Governance — persen ditekan lewat versi policy | Cabang override policy untuk `bottleneck_min_percent` memakai jalur kode yang **sama persis** dengan `bottleneck_min_workers` yang sudah diverifikasi di baris #7 (baca `policy_version_id` baru, tulis baris suppressed) — bukan jalur terpisah yang bisa diam-diam berbeda |

Kalau salah satu baris di tabel code-review ini ternyata punya cabang kode
yang **berbeda struktur** dari yang sudah live-tested (bukan sekadar field
yang berbeda), naikkan lagi jadi live test — pemangkasan ini valid hanya
selama pola kodenya benar-benar seragam.

Semua angka cohort di atas dihitung dari `dataset/csv/Workers.csv` +
`dataset/csv/Cross_Team_Dependencies.csv` dengan aturan blocker yang sama
seperti §7.1 (`blocks_day_one=true` dan status bukan Done/Completed/Complete/
Fulfilled). Kalau dataset live pernah diubah oleh fixture stage lain (mis.
`DEP-10015` di §6 4.R2.2 atau dependency `EMP7063` di §6 4.R2.1 test #16),
kembalikan dulu ke kondisi awal sebelum menjalankan tabel ini — kalau tidak,
denominator dan angka team di atas tidak akan cocok.

### 7.3 — Manager accountability state machine (G-03 required)

G-03 is live: the source is Supabase table `manager_action_states` (written
only via RPC `record_manager_action_event`, never direct insert/update from
Auto) joined to `workbench_cases` for `case_type`/`priority`. Its fields match
the required list below exactly, so the placeholder has been replaced.

**Prompt:**

```text
Goal: evaluate manager acknowledgment/action deadlines from authoritative
system state, never from an inferred behavioral signal.

Continue "OP-07 Cross-Team Readiness & Manager Accountability".

Read only the approved manager-action state source: Supabase table
"manager_action_states" joined to "workbench_cases" for case_type/priority.
Exclude any case where workbench_cases.case_type is payroll or confidential
before any manager logic runs.
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

**Signature RPC `record_manager_action_event` (terverifikasi live):**

```text
record_manager_action_event(
  target_case_id            text,
  new_source_event_id       text,
  new_event_type            text,
  event_occurred_at         timestamptz,
  new_next_reminder_at      timestamptz DEFAULT NULL,
  new_acknowledgment_deadline timestamptz DEFAULT NULL,
  new_action_deadline       timestamptz DEFAULT NULL
)
```

PostgREST mencocokkan RPC lewat **nama** argumen di body JSON, bukan posisi.
Panggilan escalation dari Auto karena itu harus memakai persis
`{"target_case_id": ..., "new_source_event_id": ..., "new_event_type": "escalated",
"event_occurred_at": ...}`; tiga argumen terakhir punya default dan boleh
dihilangkan. Nama yang meleset menghasilkan `PGRST202` (fungsi tidak ditemukan),
bukan pemanggilan dengan nilai default — jadi kegagalannya total dan senyap dari
sisi logic. Fixture di SQL Editor memanggil fungsi yang sama secara posisional,
dengan urutan timestamp `event_occurred_at`, `next_reminder_at`,
`acknowledgment_deadline`, `action_deadline`.

Pengecualian payroll ditegakkan **di dalam RPC itu sendiri**, bukan hanya oleh
filter query Auto: memanggil `record_manager_action_event` untuk case dengan
`case_type='payroll'` gagal dengan `P0001: Payroll case cannot enter manager
action state`. Filter `workbench_cases.case_type=not.in.(payroll,confidential)`
di Operator tetap wajib sebagai lapisan kedua, tetapi kombinasi terlarangnya
tidak bisa dibuat lewat jalur normal (lihat fixture test #3 di bawah).

**Input contract (form test 7.3):**

Field test form OP-07 ternyata satu form yang sama dipakai lintas 7.1/7.2/7.3
(bukan form terpisah per bagian) — jadi field cohort/threshold dari §7.2 juga
muncul di sini, ditambah satu field baru khusus 7.3:

| Field | Wajib | Diisi dengan apa untuk test ini | Perilaku kalau kosong/tidak diisi |
|---|---|---|---|
| `scope` | **Ya — dropdown, hanya 2 pilihan** | Pilih `employee` atau `cohort` dari dropdown. Tidak ada opsi lain, tidak ada opsi kosong — form tidak bisa disubmit tanpa memilih salah satu | **Tidak reachable.** UI memaksa salah satu dari dua nilai; tidak ada "scope kosong" atau "scope invalid" yang bisa dikirim lewat form test ini (beda dari asumsi saya sebelumnya) |
| `employee_id` | Ya saat `scope=employee`, diabaikan saat `scope=cohort` | Ketik ID pekerja persis, mis. `EMP7009` (lihat kolom employee_id di tabel test) | Kosongkan field ini kalau `scope=cohort` dipilih. Kalau `scope=employee` dipilih tapi ini dikosongkan → `input_validation` system_exception |
| `cohort_id` | Ya saat `scope=cohort`, diabaikan saat `scope=employee` | Ketik ID cohort, mis. `COH-2026-W22` | Kosongkan kalau `scope=employee` dipilih. Field ini **tidak dibaca** oleh logic manager-accountability sama sekali — cuma dipakai Day-1/cohort-bottleneck yang jalan bersamaan di pipeline yang sama |
| `min_workers_for_bottleneck` | Tidak, milik logic §7.2 | Kosongkan di semua test §7.3 | Kosong = pakai default policy aktif untuk logic bottleneck; **tidak berpengaruh sama sekali** ke evaluasi manager-accountability |
| `min_percent_for_bottleneck` | Tidak, milik logic §7.2 | Kosongkan di semua test §7.3 | Sama seperti `min_workers_for_bottleneck` |
| `manager_max_reminders` | Tidak | Ketik angka integer, mis. `1`, untuk override cap reminder khusus test ini (lihat test #4). Kosongkan di semua test lain | Kosong = pakai `thresholds.manager_max_reminders` dari policy aktif (default `2`) |

Karena `scope` ternyata dropdown wajib 2-pilihan, test "scope kosong/invalid"
tidak bisa dijalankan lewat form ini sama sekali. Cabang defensif
`if scope not in ["employee","cohort"]:` di kode tetap dipertahankan untuk
jaga-jaga kalau OP-07 dipanggil bukan lewat form ini (mis. langsung dari
ORCH-01) — itu masuk code review, bukan test live.

**Tests — essentials (live, di Auto Studio):**

Dipangkas dari 10 ke 4 baris: yang tersisa hanyalah skenario yang kebenarannya
bergantung pada **eksekusi nyata** — rantai empat step benar-benar tersambung,
filter embed PostgREST benar-benar menyaring, dan RPC escalation benar-benar
tertulis. Sisanya adalah cabang cermin atau kasus negatif yang bisa dipastikan
dari membaca kondisinya; lihat tabel "Cakupan tambahan lewat code review" di
bawah.

Field yang sama di semua baris: `scope=employee`; `cohort_id`,
`min_workers_for_bottleneck`, dan `min_percent_for_bottleneck` dikosongkan;
`command_id` = sama dengan `execution_id`; `trigger_source = command_center`;
pin `as_of_date="2026-08-03"`. `—` berarti field dikosongkan di form.
Jalankan sesuai kolom **Urutan** — baris #4 mengubah state (`escalated`), jadi
ditaruh paling akhir.

**Prasyarat sebelum fixture dijalankan.** Konfirmasi relasi foreign key yang
dipakai embed `workbench_cases!inner(...)`; kalau query ini tidak
mengembalikan baris, step manager akan balas 400 dan test #3 gagal karena
alasan yang salah:

```sql
select conname, conrelid::regclass, confrelid::regclass
from pg_constraint
where contype = 'f' and conrelid = 'manager_action_states'::regclass;
```

Pastikan juga `thresholds.manager_max_reminders` di policy aktif bernilai `2`.
Kalau lebih rendah, escalation ikut terpicu di baris #1/#2 dan hasilnya tidak
akan cocok dengan tabel.

Kolom **Fixture** hanya berisi statement SQL yang bisa langsung dieksekusi di
SQL Editor Supabase.

| Urutan | Scenario | employee_id | manager_max_reminders | execution_id | Expected output | Fixture (SQL Editor) |
|---|---|---|---|---|---|---|
| 1 | Rantai empat step + ack deadline lewat | `EMP7009` | — | `cmd_7f0cc415af8c17ab878cf27d6a2188e4` | Tepat satu finding: `MANAGER_ACKNOWLEDGMENT_OVERDUE`, evidence `case:CASE-73-01`. Tidak ada `DAY_ONE_DEPENDENCY_BLOCKED` (keempat dependency `blocks_day_one=false`) dan tidak ada `LEARNING_MILESTONE_OVERDUE` (`LRN-30028`/`LRN-30029`/`LRN-30030` semuanya Completed) — jadi finding tunggal ini membuktikan step manager benar-benar dieksekusi dan output-nya sampai ke Write Evaluation. Tidak ada escalation: `successful_reminder_count(1) < manager_max_reminders(2)` | `insert into "workbench_cases" (case_id, employee_id, case_type, priority, status) values ('CASE-73-01','EMP7009','dependency','high','open');`<br>`select record_manager_action_event('CASE-73-01','EVT-73-01-1','nudge_created','2026-07-28T00:00:00Z','2026-07-30T00:00:00Z','2026-07-30T00:00:00Z','2026-08-09T00:00:00Z');`<br>`select record_manager_action_event('CASE-73-01','EVT-73-01-2','delivery_succeeded','2026-07-28T00:05:00Z');` |
| 2 | Duplicate delivery event (replay) — idempotensi RPC | `EMP7014` | — | `cmd_9adcf263d019ff409b823af8680a3d57` | `successful_reminder_count=1` (bukan 2) walau event yang sama dikirim dua kali; step evaluasi membaca nilai itu apa adanya tanpa menghitung ulang. Findings: `MANAGER_ACKNOWLEDGMENT_OVERDUE` (`case:CASE-73-05`, ack_deadline `2026-07-27` sudah lewat) dan `DAY_ONE_DEPENDENCY_BLOCKED` (`DEP-10060`). Tidak ada `LEARNING_MILESTONE_OVERDUE`. Tidak ada escalation: `1 < 2` | `insert into "workbench_cases" (case_id, employee_id, case_type, priority, status) values ('CASE-73-05','EMP7014','dependency','high','open');`<br>`select record_manager_action_event('CASE-73-05','EVT-73-05-1','nudge_created','2026-07-25T00:00:00Z','2026-07-27T00:00:00Z','2026-07-27T00:00:00Z','2026-08-01T00:00:00Z');`<br>`select record_manager_action_event('CASE-73-05','EVT-73-05-2','delivery_succeeded','2026-07-25T00:05:00Z');`<br>`select record_manager_action_event('CASE-73-05','EVT-73-05-2','delivery_succeeded','2026-07-25T00:05:00Z');`<br>`select case_id, current_state, successful_reminder_count from manager_action_states where case_id = 'CASE-73-05';` |
| 3 | Case payroll dikecualikan oleh filter embed | `EMP7015` | — | `cmd_292cf2a30c60fb2c64fdc82d55f57262` | **Tidak ada** finding `MANAGER_*` sama sekali untuk `CASE-73-06` walau ack_deadline `2026-07-30` sudah lewat — disaring oleh `workbench_cases.case_type=not.in.(payroll,confidential)`. Tetap ada `LEARNING_MILESTONE_OVERDUE` dengan `LRN-30046` (due `2026-07-06`) dan `LRN-30047` (due `2026-07-29`) — buktikan pengecualian hanya berlaku untuk logic manager, bukan Learning Logic. Tidak ada Day-1 blocker | `insert into "workbench_cases" (case_id, employee_id, case_type, priority, status) values ('CASE-73-06','EMP7015','dependency','high','open');`<br>`select record_manager_action_event('CASE-73-06','EVT-73-06-1','nudge_created','2026-07-28T00:00:00Z','2026-07-30T00:00:00Z','2026-07-30T00:00:00Z','2026-08-09T00:00:00Z');`<br>`select record_manager_action_event('CASE-73-06','EVT-73-06-2','delivery_succeeded','2026-07-28T00:05:00Z');`<br>`update "workbench_cases" set case_type = 'payroll' where case_id = 'CASE-73-06';` |
| 4 | `manager_max_reminders` override + escalation lewat RPC | `EMP7016` | `1` | `cmd_6a8e0c55a29bd083d1d604e497538fb2` | Tiga finding: `MANAGER_ACKNOWLEDGMENT_OVERDUE` (`case:CASE-73-07`), `LEARNING_MILESTONE_OVERDUE` (`LRN-30049`, due `2026-05-17`), `DAY_ONE_DEPENDENCY_BLOCKED` (`DEP-10066`, `DEP-10068`). Karena `successful_reminder_count(1) >= manager_max_reminders(1)` dan `current_state != 'escalated'`, step memanggil RPC dan `manager_action_states.current_state` untuk `CASE-73-07` berubah jadi `escalated` dengan `escalated_at` terisi. Bandingkan dengan baris #1 (field dikosongkan → cap policy `2` → `1 < 2` → tidak escalate) untuk membuktikan override benar-benar dipakai | `insert into "workbench_cases" (case_id, employee_id, case_type, priority, status) values ('CASE-73-07','EMP7016','dependency','high','open');`<br>`select record_manager_action_event('CASE-73-07','EVT-73-07-1','nudge_created','2026-07-20T00:00:00Z','2026-07-22T00:00:00Z','2026-07-22T00:00:00Z','2026-07-27T00:00:00Z');`<br>`select record_manager_action_event('CASE-73-07','EVT-73-07-2','delivery_succeeded','2026-07-20T00:05:00Z');` |

Fixture baris #3 sengaja membuat case sebagai `dependency` lebih dulu, baru
mengubah `case_type` jadi `payroll` sesudah state terbentuk. Membuatnya
langsung sebagai `payroll` mustahil: RPC menolak dengan `P0001: Payroll case
cannot enter manager action state`. Kombinasi terlarang itu hanya bisa
dikonstruksi lewat pintu belakang ini, dan justru itu yang membuat test-nya
bermakna — ia menguji lapisan filter di Operator, bukan lapisan penjagaan di
RPC yang sudah terbukti sendiri.

Verifikasi setelah keempat baris selesai:

```sql
select case_id, current_state, successful_reminder_count, escalated_at
from manager_action_states where case_id like 'CASE-73-%' order by case_id;
```

`CASE-73-07` harus `current_state='escalated'` dengan `escalated_at` terisi;
tiga case lain tetap `delivered` dengan `escalated_at` null.

```sql
select evaluation_id, execution_id, employee_id, policy_key, outcome
from policy_evaluations
where employee_id in ('EMP7009','EMP7014','EMP7015','EMP7016')
order by evaluated_at desc;
```

`execution_id` harus terisi (bukan `unknown_execution`), `policy_key` bervariasi
per rule, dan baris CLEAR ikut tercatat.

Setelah selesai, hapus semua fixture test — urutan ini penting karena foreign
key — lalu kembalikan `policy_round2_v1` (`as_of_date=null`) sebagai versi
aktif:

```sql
delete from "manager_action_events" where case_id like 'CASE-73-%';
delete from "manager_action_states" where case_id like 'CASE-73-%';
delete from "workbench_cases" where case_id like 'CASE-73-%';
```

**Cakupan tambahan lewat code review (tidak perlu live test):**

| Skenario (dari draf 10-baris sebelumnya) | Yang dicek di Code step |
|---|---|
| `scope=cohort` — manager-accountability skip | Cabang `if scope == "cohort" or not worker_context` mengembalikan state apa adanya sebelum read apa pun; sudah terbukti berjalan setiap kali §7.2 dijalankan |
| Delivered, ack eksplisit sebelum deadline | Syarat `current_state == 'delivered' and not acknowledged_at` — cabang yang sama dengan baris #1, hanya beda nilai data |
| Acknowledged, action deadline lewat | Blok `current_state == 'acknowledged' and not action_verified_at` memakai operator perbandingan identik dengan blok ack yang sudah diverifikasi di baris #1 |
| Case macet di `nudge_created` | Tidak ada cabang yang menangani `current_state == 'nudge_created'`, jadi outcome tetap `clear` — terbaca langsung dari struktur if |
| Peakon bukan sumber otoritatif | Tidak ada satu pun referensi ke `Peakon_Engagement` di seluruh step; buktinya adalah ketiadaan kode, bukan hasil run |
| Field cohort/threshold diabaikan saat `scope=employee` | `cohort_id` dan kedua threshold hanya dibaca di cabang `scope == "cohort"` pada step Day-1 |

## 5. OP-01/02/03 — Active-policy compatibility amendment

This is a compatibility migration, not a rebuild. Apply it separately to each
saved Operator and rerun its Stage 1 regression suite before publishing.

**Prompt for OP-01, OP-02, and OP-03 (paste into each Operator separately):**

Bagian STEP 1–7 identik untuk ketiganya. Blok "PER-OPERATOR KEYS" di bawahnya
berbeda per Operator — sertakan hanya blok milik Operator yang sedang dimigrasi.

```text
Goal: migrate this existing Operator from legacy policy_config reads to the one
active versioned policy without changing its already-tested business behavior.

Continue the current saved Operator. Do not create a replacement workflow.

STEP 1 — Active policy.
- GET policy_versions where status=active, selecting only version_id,
  config_snapshot, activated_at, limit 2. Require exactly one row; zero or more
  than one is a system_exception that stops the evaluation.
- Read every value this Operator needs from that config_snapshot. Do not read a
  draft, and do not combine any value from legacy policy_config with the active
  version. After this migration the Operator must not read policy_config at all.
- A threshold may be a bare number or an object keyed by jurisdiction with an
  explicit "default". Use the exact jurisdiction override when present, otherwise
  the explicit default. A missing, non-numeric, or negative value is a
  system_exception — never invent a fallback.

STEP 2 — as_of and local calendar day.
- Resolve as_of from config_snapshot.as_of_date when it is non-empty, otherwise
  the current instant. Do not read the system clock when as_of_date is set: the
  regression tests pin this field, and an Operator that ignores it will return
  identical results for two deliberately different dates.
- Every deadline or overdue comparison uses the worker's jurisdiction-local
  calendar day, resolved by the common rule: take Workers.jurisdiction, query
  Locations_Entities by it, require all matching rows to agree on one valid
  timezone, otherwise fall back to Workers.time_zone only when it is non-empty
  and valid. A missing, invalid, or conflicting mapping is a data-quality
  system_exception — never guess from the free-text Location label, and never
  default to UTC.

STEP 3 — Preserve existing behaviour.
- Keep the existing reason codes, deterministic Code steps, input and output
  fields, Typeform single-submission behaviour, tier aggregation, confidence
  values, and confidentiality rules exactly as they are. This is a migration of
  where values are read from, not a change to what the rules decide.

STEP 4 — Safe output envelope.
- Add policy_version_id and evaluated_at to the safe output.
- reasons is ONLY the sorted, de-duplicated projection of the finding reason
  codes — a list of code strings such as ["MISSING_DAY_ONE_ACCESS"]. It must
  contain no sentences, no formatted text, and no form prose, because ORCH-01
  and OP-04 dispatch on the code. If the Round 1 projection currently emits
  descriptive text, replace it with codes and move the text to the rendered
  output only.
- Never place an upstream API response body, a stack trace, a credential, or
  form prose into the output, an event, a case, or a log line.

STEP 5 — Idempotent evaluation logging.
- For every rule decision, upsert one policy_evaluations row, including CLEAR
  outcomes.
- Populate the execution_id column on every record from the incoming
  execution_id.
- Build evaluation_id deterministically from execution_id + operator_id +
  policy_version_id + object_type + object_id + rule_key. Omitting execution_id
  makes two different runs collide on the same evaluation_id so the later run
  silently overwrites the earlier one — that is not idempotency.
- Set policy_key to the rule_key of that specific row, not to a single
  Operator-wide constant, so different rules stay distinguishable in the audit
  log.
- POST to /rest/v1/policy_evaluations?on_conflict=evaluation_id with the header
  Prefer: resolution=merge-duplicates and a bare JSON array body.
- OP-01 normalization and dedup decisions log only safe field and rule
  identifiers, never submitted form prose.

STEP 6 — Failure behaviour.
- A missing active policy or a missing required policy key creates a
  system_exception and stops the affected decision. Never fall back silently to
  legacy policy_config.
- Never use raise or allow an unhandled exception to end the step. Every early
  return for invalid input, missing data, or a failed read must assign the
  step's output variable with the safe envelope BEFORE returning, otherwise the
  structured exception is built and then discarded, and the caller sees a raw
  crash instead.
- A failed policy_evaluations write uses the active retry profile; after
  exhaustion add an integration-failure system_exception and still return the
  already-computed findings. Never claim the write succeeded.

STEP 7 — Verify the migration is real.
- After the change, confirm no code path still reads policy_config, and that the
  Operator's output and its policy_evaluations rows both carry the same
  policy_version_id as the row read in STEP 1.
```

**PER-OPERATOR KEYS — sertakan hanya blok Operator yang sedang dimigrasi:**

```text
PER-OPERATOR KEYS (OP-01 Intake & Normalization):
Read the fuzzy-dedup band thresholds and the normalization settings from
config_snapshot. The Round 1 behaviour is: score >= upper band updates the
existing worker, score < lower band creates a new worker, and a score between
the two bands escalates intake_possible_duplicate without deciding either way.
Both band values must come from the active policy — do not hardcode 0.90 or
0.70 anywhere in the Code step. If either key is absent from config_snapshot,
emit a system_exception rather than assuming the Round 1 numbers.
```

```text
PER-OPERATOR KEYS (OP-02 Onboarding & Provisioning Risk):
Read thresholds.task_stalled_overdue_days and the provisioning grace threshold
from config_snapshot.
Read thresholds.compliance_step_terms as the configurable term list used to
recognise a compliance step by name (ADR-016). Never match compliance steps with
a hardcoded substring: the dataset contains at least two distinct step names
("Compliance Document signed" and "Compliance training assigned") and both must
be recognised through that list.
Keep tier aggregation advisory and unchanged: 0 reasons LOW, 1 MEDIUM, 2 or more
HIGH. Zero source rows still returns data_state "no_data_yet", not an error.
Keep confidence fixed at 1.0 — every rule here is a deterministic data check.
```

```text
PER-OPERATOR KEYS (OP-03 Engagement & Disclosure):
Read thresholds.engagement_low_score and
thresholds.disclosure_classifier_min_confidence from config_snapshot.
Rule 1 compares the MOST RECENT survey score against engagement_low_score —
order the responses by milestone (Day 7, Day 30, Day 60, Day 90) and take the
last one. Do not use the lowest score, the average, or whichever row the query
happened to return first.
Rule 2 (SURVEY_NON_RESPONSE) was never implemented in Round 1 and stays out of
scope; do not add it during this migration.
Rule 3 keeps the existing LLM classifier and must continue to classify every
comment available for the worker, not only the most recent one — a disclosure in
an earlier survey must not be hidden by a later routine comment.
Confidentiality is unchanged: reasons[] carries only the generic
SENSITIVE_DISCLOSURE_DETECTED code, and the comment text stays inside
_internal_case_payload, never in reasons[], the standard output, an event, or a
log line.
```

**Regression tests:**

Ini migrasi dari Operator Round 1 yang sudah pernah lolos (lihat
`docs/STAGE_SUMMARY.MD` §4), jadi setiap test punya dua tujuan sekaligus:
membuktikan perilaku bisnis lama **tidak berubah**, dan membuktikan nilai yang
dipakai benar-benar berasal dari `config_snapshot` versi aktif, bukan dari
`policy_config` lama. Karena itu tiap Operator punya minimal satu baris
"ambang policy berubah" — itulah satu-satunya baris yang membuktikan migrasinya
benar-benar terjadi; sisanya hanya membuktikan tidak ada regresi.

Semua angka di bawah dihitung ulang dari `dataset/csv/*.csv` terhadap
`as_of_date="2026-08-03"` kecuali disebut lain. Kalau dataset live sudah diubah
fixture stage lain, kembalikan dulu sebelum menjalankan tabel ini.

**Prosedur baseline policy** (dipakai oleh semua baris "ambang policy berubah"
di ketiga Operator). Jangan mengandalkan nama versi tertentu — catat versi aktif
sebelum mengubah apa pun, lalu aktifkan kembali versi itu setelah selesai:

```sql
select version_id, change_summary, activated_at from policy_versions where status = 'active';
```

#### OP-01 — Intake & Normalization

Dipicu `OP-01 Typeform Intake Poller`, satu submission per call, jadi **tidak ada
`execution_id` manual** — korelasinya lewat Auto run ID. Tiga field wajib:
`Legal_Name`, `Hire_Date`, dan satu manager identifier; sisanya enrich-later.
Pita dedup Round 1: `≥0.90` update, `<0.70` create, di antaranya escalate
`intake_possible_duplicate`.

Baris #1 membuat pekerja baru yang dipakai ulang oleh #2–#3, jadi jalankan
berurutan dan jangan hapus hasilnya sampai #5 selesai.

**Essentials (live):**

| Urutan | Scenario | Field submission | Expected output | Tindakan tambahan |
|---|---|---|---|---|
| 1 | Clean create | `Legal_Name="Farah Kassim"`, `Hire_Date="2026-08-10"`, manager `"Anjali Prakash"` (unik di `Manager_Directory`, WID `7f350fac-799a-7cbc-4ae2-ac30d8c331a7`) | Satu row baru di `Workers` dengan `Worker_WID` baru; `Manager_WID` terisi hasil resolve, bukan teks nama; output memuat `policy_version_id` dan `evaluated_at`; satu baris `policy_evaluations` outcome CLEAR untuk keputusan create | Tidak ada |
| 2 | Name-variant update (pita ≥0.90) | `Legal_Name="Farah Kasim"` (hilang satu `s`), `Hire_Date="2026-08-10"`, manager sama | Skor dedup ≥0.90 → **update** row #1; jumlah row `Workers` tidak bertambah | Jalankan setelah #1 |
| 3 | Pita tengah → escalate, bukan tebak | `Legal_Name="Farrah Binti Kassim"`, `Hire_Date="2026-08-12"`, manager sama | Skor jatuh di 0.70–0.90 → `intake_possible_duplicate` ke Workbench. **Tidak** ada update ke row #1 dan **tidak** ada row baru — buktikan Operator menolak memutuskan sendiri. Skor fuzzy bergantung data, tidak bisa dipastikan dari membaca kode | Jalankan setelah #1 |
| 4 | Manager ambigu (>1 kandidat) | Manager identifier `"Kevin Goh"` — nama ini muncul **dua kali** di `Manager_Directory` | `intake_validation` system_exception dengan sebab >1 kandidat. Operator tidak boleh memilih kandidat pertama secara diam-diam. `"Yusof Nair"` adalah kasus duplikat kedua kalau butuh pembanding | Tidak ada |
| 5 | Ambang policy berubah — **bukti migrasi** | Submission identik baris #3 (`"Farrah Binti Kassim"`) | Hasil berubah dari `intake_possible_duplicate` jadi **update** row #1, murni karena pita dedup di policy diturunkan — bukan karena payload berubah. `policy_version_id` di output dan di `policy_evaluations` ikut berubah | Catat versi aktif lewat query baseline di atas. Buat draft policy baru dengan ambang atas dedup diturunkan ke `0.70`, simulate → approve → activate. **Konfirmasi dulu nama key pita dedup di Policy Studio** — key ini belum terdokumentasi di guide dan tidak boleh ditebak. Setelah test, aktifkan kembali versi baseline |

Setelah #5, hapus pekerja hasil test agar tidak mencemari dataset stage lain:

```sql
delete from "Workers" where "Legal_Name" in ('Farah Kassim','Farah Kasim','Farrah Binti Kassim');
```

**Cakupan tambahan lewat code review:**

| Skenario | Yang dicek di Code step |
|---|---|
| Parse `Hire_Date` multi-format | Daftar format tanggal yang diterima terbaca langsung di Code step; pastikan ada penanganan ambiguitas hari/bulan (`10/08/2026`) dan bahwa format tak dikenal jatuh ke `intake_validation`, bukan ditebak |
| Di bawah pita (<0.70) → create baru | Cabang `else` dari perbandingan yang sama dengan baris #2/#3; operator perbandingannya sudah diverifikasi di kedua baris itu |
| `Hire_Date` tidak bisa di-parse | Satu early-return `intake_validation` sebelum write apa pun |
| Manager tidak dikenal (0 kandidat) | Guard `len(candidates) == 0` bersebelahan dengan guard `> 1` yang sudah dites live di baris #4 |
| Field wajib hilang | Validasi tiga field wajib (`Legal_Name`, `Hire_Date`, manager identifier) di awal, sebelum read apa pun |

#### OP-02 — Onboarding & Provisioning Risk

Read-only, satu hire per call. `employee_id` + `execution_id` manual lewat
Command Center test form. Empat reason code: `MISSING_DAY_ONE_ACCESS`,
`PROVISIONING_DELAYED`, `STALLED_COMPLIANCE_DOC`, `TASK_ALREADY_ESCALATED`.
Agregasi tier bersifat advisory: 0 reason → LOW, 1 → MEDIUM, 2+ → HIGH.

Field yang sama di semua baris: `command_id` = sama dengan `execution_id`;
`trigger_source = command_center`; pin `as_of_date="2026-08-03"` kecuali
disebut lain di kolomnya.

**Essentials (live):**

| Urutan | Scenario | employee_id | execution_id | Expected output | Tindakan tambahan |
|---|---|---|---|---|---|
| 1 | Keempat reason code sekaligus | `EMP7000` | `cmd_f631f75b1d022b18947700ae3bf6058b` | `MISSING_DAY_ONE_ACCESS` (`INT-60001` Laptop + `INT-60005` System Access, keduanya `Blocked`), `PROVISIONING_DELAYED` (`INT-60002` Email `Requested` sejak `2026-07-13`, tanpa `Fulfilled_On`), `TASK_ALREADY_ESCALATED` (`BP-90007`, `BP-90009`), dan `STALLED_COMPLIANCE_DOC` (`BP-90005` "Compliance training assigned", jatuh tempo `2026-07-31`, 3 hari lewat). Tier HIGH, `confidence=1.0`. Output memuat `policy_version_id` + `evaluated_at`; satu baris `policy_evaluations` per reason code | Tidak ada |
| 2 | Compliance stalled jauh lewat tempo | `EMP7005` | `cmd_577c15d9c6e6cfddae036e744607f2a7` | `STALLED_COMPLIANCE_DOC` (`BP-90074` "Compliance Document signed", jatuh tempo `2026-05-23`, 72 hari lewat) dan `TASK_ALREADY_ESCALATED` (`BP-90073` "Role goals set"). Tier HIGH. Tidak ada reason provisioning — `EMP7005` tidak punya baris `Blocked` maupun `Requested` yang menggantung. Baris ini adalah baseline pembanding untuk #5 | Tidak ada |
| 3 | Clean / tier LOW | `EMP7015` | `cmd_7bd741d5cab0742dca7f9b5762a80dea` | 0 reason code, tier LOW, `data_state` normal (**bukan** `no_data_yet` — `EMP7015` punya baris provisioning dan onboarding task, semuanya sehat). Baris `policy_evaluations` tetap ditulis dengan outcome CLEAR. Buktikan migrasi tidak membuat rule fire ke semua orang | Tidak ada |
| 4a | Batas waktu — sebelum jatuh tempo | `EMP7012` | `cmd_e588eeeda529d0fa4d1818d9106d6133` | 0 reason code, tier LOW. `BP-90165` "Compliance Document signed" jatuh tempo `2026-07-21` dan belum lewat pada `as_of` ini | Pin `as_of_date="2026-07-20"` |
| 4b | Batas waktu — sesudah jatuh tempo | `EMP7012` | `cmd_4ee3d056c463598dc0761e3f0443488d` | `STALLED_COMPLIANCE_DOC` (`BP-90165`, 13 hari lewat); tier MEDIUM. Pasangan 4a/4b adalah **satu-satunya** bukti bahwa perbandingan tanggal memakai `as_of_date` dari policy, bukan jam sistem — kalau keduanya memberi hasil identik, migrasinya belum menyentuh STEP 2 | Pin `as_of_date="2026-08-03"` |
| 5 | Ambang policy berubah — **bukti migrasi** | `EMP7005` | `cmd_c905f021dcbb586ee720b56c64b5192f` | Sama seperti #2 tapi `STALLED_COMPLIANCE_DOC` **hilang** karena `task_stalled_overdue_days` dinaikkan jauh di atas 72; `TASK_ALREADY_ESCALATED` tetap muncul karena tidak terkait threshold ini, sehingga tier turun dari HIGH ke MEDIUM. `policy_version_id` di output dan di `policy_evaluations` berbeda dari baris #2 | Catat versi aktif lewat query baseline. Buat draft policy baru dengan `thresholds.task_stalled_overdue_days=100`, simulate → approve → activate. Setelah test, aktifkan kembali versi baseline |

**Cakupan tambahan lewat code review:**

| Skenario | Yang dicek di Code step |
|---|---|
| Tier MEDIUM pada tepat satu reason (`EMP7028`) | Agregasi tier hanyalah pemetaan hitungan → label (`0` LOW, `1` MEDIUM, `≥2` HIGH); kedua ujungnya sudah terbukti live di baris #1 (HIGH) dan #3 (LOW), jadi titik tengahnya terbaca langsung |
| `no_data_yet` bukan error | Cabang "nol baris sumber" mengembalikan `data_state: "no_data_yet"` tanpa system_exception. Sengaja tidak dijadikan live test: tidak ada employee di dataset yang benar-benar tanpa baris sumber, sehingga test-nya menuntut penghapusan data live sementara — risiko fixture-nya lebih besar daripada nilai buktinya |

Catatan untuk baris #1 dan #2: pencocokan langkah compliance memakai daftar term
yang bisa dikonfigurasi (`thresholds.compliance_step_terms`, ADR-016), bukan
substring hardcoded. Kalau `BP-90005` tidak ikut fire di baris #1, periksa
daftar term itu di `config_snapshot` sebelum menyalahkan logic — "Compliance
training assigned" dan "Compliance Document signed" adalah dua penamaan langkah
yang berbeda dan keduanya harus tertangkap.

#### OP-03 — Engagement & Disclosure

Read-only atas `Peakon_Engagement`, ditambah satu step klasifikasi LLM untuk
rule 3. Rule 1 (`LOW_ENGAGEMENT_SCORE`) membaca skor **paling baru**, bukan
paling rendah. Rule 2 (`SURVEY_NON_RESPONSE`) tidak diimplementasikan di Round 1
dan tetap di luar cakupan migrasi ini — jangan buat test untuknya.

Field yang sama di semua baris: `command_id` = sama dengan `execution_id`;
`trigger_source = command_center`.

**Essentials (live):**

| Urutan | Scenario | employee_id | execution_id | Expected output | Tindakan tambahan |
|---|---|---|---|---|---|
| 1 | Low engagement — skor terbaru | `EMP7046` | `cmd_905938e664ce8ae7a7bc5b2a9a038b83` | `LOW_ENGAGEMENT_SCORE` (Day 60 = 3, di bawah `engagement_low_score` default 5). Riwayatnya naik dulu (Day 7 = 6, Day 30 = 9) lalu jatuh, jadi ini juga membuktikan rule tidak memakai rata-rata. Baseline pembanding untuk #6 | Tidak ada |
| 2 | Negatif — turun lalu pulih di tiga titik | `EMP7021` | `cmd_c054f8de1c7d9a904c73e226bc1b4267` | **Tidak** fire. Day 7 = 9, Day 30 = 2, Day 60 = 7. Nilai rendahnya ada di tengah, bukan di awal atau akhir — membuktikan milestone benar-benar diurutkan, bukan diambil baris pertama/terakhir dari hasil query. Ini kasus urutan terkuat di dataset | Tidak ada |
| 3 | Confidential disclosure asli | `EMP7003` | `cmd_17417140fc97cdd28c95ccd4d6bb3fe3` | `confidential=true` dengan confidence tinggi atas `PK-5006` (Day 7, komentar soal masalah kesehatan). `reasons[]` hanya berisi kode generik `SENSITIVE_DISCLOSURE_DETECTED`; teks komentar asli **hanya** boleh ada di `_internal_case_payload`, tidak pernah di `reasons[]`, output standar, event, atau log. `LOW_ENGAGEMENT_SCORE` **tidak** fire — skor terbaru `EMP7003` adalah Day 30 = 6, jadi baris ini sekaligus membuktikan kedua rule independen | Tidak ada |
| 4 | Disclosure tidak boleh tertutup survei terbaru yang sehat | `EMP7090` | `cmd_e49310159d4e6095b780cf1104b7641b` | `PK-5209` (Day 30, skor 4) berisi disclosure pelecehan, tapi baris terbaru `PK-5210` (Day 60, skor 7) rutin dan sehat. Disclosure tetap harus terdeteksi dan dirutekan confidential; `LOW_ENGAGEMENT_SCORE` tidak fire karena skor terbaru 7. **Kalau disclosure tidak terdeteksi**, artinya rule 3 hanya mengklasifikasi komentar terbaru — itu melanggar PER-OPERATOR KEYS OP-03; perbaiki cakupan scan-nya, jangan ubah expected di sini | Tidak ada |
| 5 | Sentinel leak test | `EMP7003` | `cmd_34d56294bd009ad465dfe37a8d0b88c1` | Hasil sama seperti #3, tapi string `SENTINEL_HEALTH_XYZ` **tidak muncul** di `reasons[]`, output standar, `workflow_events`, Activity Timeline, atau log mana pun — hanya boleh ada di `_internal_case_payload` yang restricted | Sebelum run: `update "Peakon_Engagement" set "Comment" = 'Managing, though I have been dealing with SENTINEL_HEALTH_XYZ and have not felt able to raise it with my manager yet.' where "Response_ID" = 'PK-5006';`<br>Sesudah run: `update "Peakon_Engagement" set "Comment" = 'Managing, though I have been dealing with a health matter and have not felt able to raise it with my manager yet.' where "Response_ID" = 'PK-5006';` |
| 6 | Ambang policy berubah — **bukti migrasi** | `EMP7046` | `cmd_447b3286bec7424c408523f797ba357c` | `LOW_ENGAGEMENT_SCORE` **hilang** karena skor 3 tidak lagi di bawah ambang baru `2`. `policy_version_id` di output dan di `policy_evaluations` berbeda dari baris #1 — buktikan hasil berubah murni karena versi policy, bukan karena data Peakon berubah | Catat versi aktif lewat query baseline. Buat draft policy baru dengan `thresholds.engagement_low_score=2`, simulate → approve → activate. Setelah test, aktifkan kembali versi baseline |

Baris #5 mengubah data live; pastikan `update` pengembaliannya benar-benar
dijalankan sebelum stage lain berjalan, karena §6 4.R2.2 dan ORCH-01 O.1 test #5
memakai `PK-5006` yang sama.

**Cakupan tambahan lewat code review:**

| Skenario | Yang dicek di Code step |
|---|---|
| Negatif dua titik (`EMP7007`: Day 7 = 2 → Day 30 = 10) | Kasus yang sama persis dengan baris #2, hanya dengan dua titik alih-alih tiga. Begitu pengurutan milestone terbukti benar di #2, kasus dua titik tidak menambah bukti apa pun |
| Disclosure tanpa low-engagement (`EMP7005`, skor 6) | Independensi kedua rule sudah terbukti di baris #3 — `EMP7003` juga menghasilkan disclosure tanpa `LOW_ENGAGEMENT_SCORE`. Yang perlu dicek di kode: rule 1 dan rule 3 dievaluasi dari cabang terpisah, dan hasil rule 3 tidak pernah men-short-circuit rule 1 |

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

**Tests:**

Catatan: OP-04 dipanggil ORCH-01, jadi INPUT contract persisnya (bentuk array
`findings`) tergantung bagaimana Auto membangun kontrak itu. Tabel di bawah
menganggap OP-04 bisa dites langsung lewat form test Auto dengan payload
`{execution_id, employee_id, findings: [{reason_code, evidence_refs}], ...}`
— sesuaikan field persis begitu prompt ini benar-benar di-paste. Untuk
`WORK_AUTH_EXPIRY_AT_RISK`/`WORK_AUTH_EXPIRED` **tidak ada** worker di dataset
yang jatuh tempo dekat `as_of=2026-08-03` (yang paling dekat adalah `2027-01-01`),
jadi dua baris itu pakai `reason_code` yang disuntik langsung ke payload test
(bukan hasil evaluasi OP-05 asli) — cukup untuk membuktikan **routing** OP-04,
karena logika deteksi work-auth sendiri sudah diverifikasi terpisah di §5.2.

| # | Reason code | employee_id / cohort | execution_id | Expected route | Tindakan tambahan |
|---|---|---|---|---|---|
| 1 | `COMPLIANCE_DEADLINE_AT_RISK` | `EMP7032` | `cmd_e3183f42821a9b1b28489e53a073976a` | People Ops compliance Workbench; **tidak ada** Slack manager | Tidak ada (temuan asli dari §5.2 test #1) |
| 2 | `COMPLIANCE_LEGAL_BREACH` | `EMP7054` | `cmd_a560cfae1aff0407a3faddd2824069a9` | People Ops compliance Workbench; tidak ada Slack manager | Tidak ada (temuan asli dari §5.2 test #4/#5) |
| 3 | `WORK_AUTH_EXPIRY_AT_RISK` | `EMP7099` | `cmd_40097a5eb1178218bf410e2b2efef1cf` | People Ops compliance Workbench; tidak ada Slack manager | Suntik `reason_code` ini langsung di payload test (lihat catatan di atas) |
| 4 | `WORK_AUTH_EXPIRED` | `EMP7099` | `cmd_db0b0fd777760ac844b8812401c4553c` | People Ops compliance Workbench; tidak ada Slack manager | Suntik `reason_code` ini langsung di payload test |
| 5 | `PAYROLL_ERROR_DETECTED` | `EMP7062` | `cmd_fa5494b1683e2a6f58bcf24cfef5eff5` | Restricted People Ops/payroll Workbench saja; **tidak pernah** manager Slack | Tidak ada (temuan asli dari §6.2 test #1, case dari §6.3 test #1) |
| 6 | `PAYROLL_NOT_CONFIRMED` | `EMP7001` | `cmd_a1dd0114f2aab31621c890203bfd5326` | Restricted payroll Workbench saja | Tidak ada |
| 7 | `PAYROLL_RECORD_MISSING` | `EMP7000` | `cmd_487678fed9541aa53fb27d35dc4b9fa5` | Restricted payroll Workbench saja | Tidak ada (pastikan payroll row `EMP7000` masih dihapus seperti fixture §6.2/6.3) |
| 8 | `DAY_ONE_DEPENDENCY_BLOCKED` | `EMP7063` | `cmd_67a47839096127635676320198126b06` | Standard Day-1 Workbench + route dependency owner (team `Security`/`IT`/dst.) | Tidak ada (temuan asli dari §7.1 test #1) |
| 9 | `LEARNING_MILESTONE_OVERDUE` | `EMP7101` | `cmd_3b715fd0ae465c094f7b97cc410980de` | Standard manager-to-People-Ops route | Tidak ada (temuan asli dari §7.1 test #2) |
| 10 | `MANAGER_ACKNOWLEDGMENT_OVERDUE` | `EMP7009` | `cmd_b00c9ceaf53c66a922b856c73e87dde6` | People Ops accountability escalation; **bukan** nudge lagi ke manager yang sama | Reuse fixture `CASE-73-01` dari §7.3 test #1 |
| 11 | `MANAGER_ACTION_OVERDUE` | `EMP7011` | `cmd_d0bb13f5db9d19bce7131d6a82e2ac5e` | People Ops accountability escalation | Reuse fixture `CASE-73-03` dari §7.3 test #3 |
| 12 | `COHORT_DEPENDENCY_BOTTLENECK` | `COH-2026-W22` (scope=cohort) | `cmd_3ea7e95d067ca86644f5d540f3550d1f` | Cohort insight/audit **saja** — pastikan **tidak ada** satu pun case per-employee dibuat | Tidak ada (temuan asli dari §7.2 test #1) |
| 13 | Kode tidak dikenal | `EMP7008` + `reason_code="XYZ_UNREGISTERED_CODE"` | `cmd_a5d7218d44074f51eb4dcced95ea4531` | Satu `system_exception` ke Workbench; **tidak ada** Slack terkirim sama sekali | Suntik reason_code palsu ini di payload test |
| 14 | Run berulang → update case yang sama | `EMP7032` (ulangi #1) | `cmd_b1c1fe2e0c443e8571e5ce2772b2eeef` | Masih satu case per employee+jurisdiction (bukan duplikat); evidence_refs gabungan | Jalankan langsung setelah #1 |
| 15 | Reopen setelah resolusi manusia | `EMP7063` (ulangi #8 setelah resolve manual) | `cmd_1fdaf108db4d4aa79f2f1a85607ae1c8` | Case Day-1 `EMP7063` yang tadinya di-resolve kembali `open` | Sebelum run: resolve case `EMP7063` lewat `record_case_action(..., 'resolve', ...)` atau langsung `update "workbench_cases" set status='resolved', resolved_at=now() where ...` |
| 16 | CLEAR tidak auto-close | `EMP7063` | `cmd_963a89cff43687e7d012aeeb014ce8ef` | Case `EMP7063` **tetap** seperti kondisi test #15 (tidak otomatis resolved) meski sekarang hasil evaluasi CLEAR | Pastikan dependency blocker `EMP7063` sudah di-set jadi Done semua di `Cross_Team_Dependencies` supaya hasil CLEAR; jangan resolve manual |

Setelah selesai, kembalikan semua fixture ke kondisi awal: payroll row
`EMP7000`, dependency status `EMP7063`, dan status case yang sempat
di-resolve manual untuk test #15.

### 4.R2.2 — Confidential independence regression

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

**Tests:**

| Scenario | employee_id | execution_id | Expected output | Tindakan tambahan |
|---|---|---|---|---|
| Sinyal confidential + Day-1 blocker bersamaan, satu employee | `EMP7003` | `cmd_38087d41abb0755e83842a0e39d71233` | Dua route independen: (1) confidential case/message — hanya berisi `employee_id`, `milestone`, secure case link; (2) standard Day-1 Workbench case untuk `DEP-10015`. Route Day-1 **tidak boleh tersuppress** oleh sinyal confidential. String `SENTINEL_SECRET_HEALTH_XYZ` **tidak muncul** di case/message standar mana pun, event mana pun, **maupun** di teks alert confidential itu sendiri (confidential message cuma boleh `employee_id`/`milestone`/link, bukan comment_text mentah) | Sebelum run: (1) `update "Peakon_Engagement" set "Comment"='...dealing with SENTINEL_SECRET_HEALTH_XYZ and have not felt able to raise it...' where "Response_ID"='PK-5006';` (2) `update "Cross_Team_Dependencies" set status='In Progress' where dep_id='DEP-10015';` supaya jadi blocker Day-1 yang nyata. Setelah run, kembalikan komentar `PK-5006` dan status `DEP-10015` ke `Done` |

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

Field yang sama: `scope=employee`; `command_id` = sama dengan `execution_id`;
`trigger_source=command_center`; pin `as_of_date="2026-08-03"`.

| # | Scenario | employee_id | execution_id | Expected output | Tindakan tambahan |
|---|---|---|---|---|---|
| 1 | Multi-domain, dua Operator sekaligus | `EMP7032` | `cmd_685e727f698af6056739c1cb0d3493f2` | Hasil OP-05 (`COMPLIANCE_DEADLINE_AT_RISK`) **dan** OP-06 (tergantung status payroll `EMP7032` saat ini) sama-sama selamat di merge; masing-masing route ke case terpisah (compliance vs payroll), tidak tercampur | Tidak ada |
| 2 | Satu branch gagal, yang lain tetap jalan | `EMP7032` | `cmd_cc2392e2c28db7cb5245cefe620c97be` | Temuan OP-05 tetap ada dan ter-route normal; branch OP-06 yang gagal muncul sebagai satu `system_exception` terpisah, **tidak** menghapus temuan OP-05 | Cabut sementara hak tulis/baca OP-06 (mis. `revoke select on "Payroll_Records" from service_role;`), jalankan, lalu kembalikan (`grant select ...`) |
| 3 | Duplicate finding delivery (retry execution_id sama) | `EMP7032` | `cmd_685e727f698af6056739c1cb0d3493f2` (**sama persis** dengan #1) | Satu finding gabungan, satu case idempotent — tidak ada duplikat di `workbench_cases`/`policy_evaluations` | Jalankan langsung setelah #1, tanpa ubah data |
| 4 | Reason code tidak dikenal dari salah satu branch | `EMP7008` | `cmd_75a27d34818030aef4d5ac5b329959e5` | Tidak ada case/Slack apa pun untuk kode ini — hanya satu `system_exception`; branch lain untuk `EMP7008` (kalau ada) tetap jalan normal | Suntik `reason_code="XYZ_UNREGISTERED_CODE"` di salah satu finding upstream test, sama seperti §6 4.R2.1 test #13 |
| 5 | Confidential + standard bersamaan | `EMP7003` | `cmd_10fbb44d3d8a71e412e869c3cc3e2ab0` | Dua route independen jalan (confidential + Day-1 standar); tidak ada data sensitif nyeberang ke branch standar | Fixture sama seperti §6 4.R2.2: update `Comment` `PK-5006` + `Cross_Team_Dependencies.DEP-10015` jadi `In Progress`; revert setelah test |

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

**Tests:**

| # | Scenario | employee_id | execution_id | Expected output | Tindakan tambahan |
|---|---|---|---|---|---|
| 1 | Korelasi Command Center run | `EMP7032` | `cmd_16fc077348809fd328f874daf71be609` | Query `command_runs` dan `workflow_events` untuk `command_id`/`execution_id` ini: nilainya **identik**; urutan event `queued -> running -> completed` konsisten dengan Activity Timeline Auto | Jalankan lewat Command Center (bukan test form Auto langsung) supaya `command_id` benar-benar berasal dari `app/services/hr.py` |
| 2 | Replay source_event_id sama | `EMP7032` | `cmd_16fc077348809fd328f874daf71be609` (**sama persis** dengan #1) | `select count(*) from "workflow_events" where execution_id=...;` jumlahnya **tidak bertambah** dibanding setelah #1 — replay tidak menambah event baru | Jalankan ulang langsung setelah #1 dengan input identik |
| 3 | Reconnect SSE di tengah run | `EMP7062` (payroll, biar durasinya cukup lama untuk sempat disconnect) | `cmd_f0bbcaa278c91ecbdf908f654291825f` | Setelah reconnect ke stream SSE Command Center, event yang diterima lanjut dari nomor urut terakhir yang sudah diterima sebelum disconnect — tidak mengulang dari awal, tidak ada gap | Manual: buka halaman yang subscribe SSE, matikan koneksi jaringan sebentar di tengah run, nyalakan lagi |
| 4 | Terminal state sekali walau sempat retry | `EMP7062` | `cmd_1ba458fa9c0d32d490bd2314b138d303` | Tepat satu event terminal (`completed`/`failed`/`cancelled`) di `workflow_events` untuk `execution_id` ini, walau salah satu Operator sempat retry beberapa kali sebelum akhirnya berhasil/gagal | Sebelum run, buat salah satu branch (mis. OP-06) gagal sekali lalu berhasil di percobaan retry berikutnya — gunakan teknik toggle env var yang sama seperti §5.3 test #3 |
| 5 | Run terjadwal tanpa command_id | — (`trigger_source=daily_schedule`) | Tidak ada `execution_id` manual; pakai Auto run ID otomatis | `command_runs`/`workflow_events` tetap punya baris yang bisa dikorelasikan lewat Auto run ID; endpoint `POST /runs/reconcile` di Command Center bisa menemukan run ini | Trigger manual test run dari Daily Cohort Sweep (§8), bukan dari Command Center |
| 6 | Cancellation mencegah aksi lanjutan | `EMP7062` | `cmd_ab53176b83db40ac5da36561c1bcbe52` | Setelah `cancel_requested_at` di-set, tidak ada case/notification baru yang tertulis untuk branch yang belum sempat jalan; event terminal `cancelled` tertulis sekali | Mulai run, lalu segera panggil `POST /runs/{command_id}/cancel` sebelum branch OP-06/OP-07 sempat selesai |

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

**Tests:**

Semua baris pakai manual test trigger (bukan menunggu jadwal 09:00 UTC), pin
`as_of_date="2026-08-03"` di policy aktif kecuali disebutkan lain.

| # | Scenario | execution_id (parent) | Expected output | Tindakan tambahan |
|---|---|---|---|---|
| 1 | Satu as_of dibagi ke semua child | `cmd_335320ee0b5f69de171b83e0235d26ec` | Semua invocation ORCH-01 anak (lintas jurisdiksi MY/SG/AU/IN/PH) memakai `as_of_local_date` yang konsisten dengan satu instant yang sama (hasil resolve timezone masing-masing boleh beda tanggal lokal, tapi instant UTC sumbernya sama) | Tidak ada |
| 2 | Paginasi mencakup semua worker eligible | `cmd_cf427fbee9d1700f09762e7bf5b1f6ac` | Jumlah worker yang diproses (Day 0–90 di `as_of`) sama antara run dengan limit kecil vs limit default — bandingkan `eligible` count di output terhadap hitungan manual `select count(*) from "Workers" where "Hire_Date" between (as_of - interval '90 days') and as_of;` (sesuaikan filter cohort/Day-90 persis definisi prompt) | Sebelum run, kecilkan sementara page size REST `Workers` di step baca (mis. `limit=10`) lalu kembalikan setelah test |
| 3 | Retry 1 child gagal, tidak duplikat case | `cmd_a98f23b27af5974d22b4592d8c0e61c1` | Employee yang child-nya sempat gagal tetap punya **tepat satu** case/finding setelah retry berhasil — bukan dua | Buat satu employee (mis. `EMP7032`) gagal di percobaan pertama (toggle env var sama seperti §5.3 test #3), berhasil di retry berikutnya |
| 4 | Bottleneck cohort end-to-end | `cmd_dd5468435b72bb1356cd9620685bd399` | `COH-2026-W22` tetap menghasilkan `COHORT_DEPENDENCY_BOTTLENECK` Security 14/19 (~73.7%) melalui pipeline penuh (bukan cuma OP-07 langsung seperti §7.2 test #1) — buktikan hand-off employee-fan-out → OP-07 scope=cohort bekerja end-to-end | Tidak ada (policy default, sama seperti §7.2 test #1) |
| 5 | `demo_mode` gagal cepat | `cmd_84e8a4eb3c0381ce6c898c38d053c4af` | Satu child yang gagal langsung jadi `system_exception` **tanpa** backoff 5/20/60s (retry_demo_profile: `max_attempts=1`, tanpa backoff) — total waktu gagal jauh lebih cepat dibanding test #3 | Buat draft policy baru dengan `demo_mode=true`, simulate → approve → activate; buat satu child gagal (toggle yang sama seperti test #3); setelah test, kembalikan `policy_round2_v1` (`demo_mode=false`) sebagai active |
| 6 | Run terjadwal kelihatan lewat reconciliation | `cmd_9352c5679f2cf296ea88f5c99963fb4e` | Parent run ini muncul dan bisa dikorelasikan lewat `POST /runs/reconcile` di Command Center walau tidak dipicu dari Command Center | Trigger via manual test trigger di parent workflow (bukan tombol run di Command Center) |

Setelah test #2, #3, dan #5, kembalikan semua toggle/policy ke kondisi normal
(`policy_round2_v1` aktif, `demo_mode=false`, page size default) sebelum
lanjut ke stage lain.

## 9. End-to-end acceptance suite

Do not mark the build complete until these are captured from live Auto Activity
Timeline plus Supabase/API evidence.

Tabel ini bukan test baru — ini checklist bukti mana yang sudah dihasilkan
oleh test-test di §2–§8, dan mana yang butuh satu langkah tambahan manual.
Isi kolom terakhir dengan link Activity Timeline run atau query Supabase
sebagai evidence, bukan centang tanpa bukti.

| Gate | Required proof | Sumber evidence (test yang sudah ada) | Langkah tambahan kalau belum cukup |
|---|---|---|---|
| Architecture | Satu Orchestrator manggil ≥5 Operator distinct; branch Round 2 paralel; perilaku terjadwal & stateful kelihatan | ORCH-01 O.1 test #1 (`EMP7032`, timestamp overlap OP-05/OP-06/OP-07 di Activity Timeline); Daily Sweep S.1 test #6 (terjadwal) | Screenshot/link Activity Timeline yang menunjukkan overlap waktu run, bukan cuma klaim selesai |
| Live data | Operator baca Supabase via custom REST, bukan CSV/Airtable/native DB block | Inspeksi visual step config di Auto Studio untuk tiap Operator (OP-01 s/d OP-07) | Buka tiap step satu-satu, pastikan block-nya "Custom REST"/Code, bukan native Supabase/Airtable block |
| Policy | ≥3 policy threshold yang bisa diedit benar-benar mengubah hasil terukur; tiap evaluasi mencatat `policy_version_id`+`as_of` | §6.2 test #7a/#7b (`first_payroll_cutoff_days` 30→60); §7.2 test #2/#3 (`bottleneck_min_workers`/`bottleneck_min_percent`); §5 OP-02/OP-03 threshold test (`task_stalled_overdue_days` atau `engagement_low_score`) | Pilih minimal 3 dari yang sudah ada; tidak perlu bikin threshold baru |
| Workbench | Exception nyata dibuat, di-claim/acknowledge, dan di-resolve manusia; recurring risk reopen bukan duplikat | §6.3 test #1 (create) + §OP-04 4.R2.1 test #15 (reopen setelah resolve) | Tambahan manual: buka Command Center Workbench, klik claim → resolve satu case nyata (bukan lewat SQL) untuk bukti UI manusia benar-benar berfungsi |
| Integrations | Supabase REST + Slack native + Typeform native polling, ketiganya live | §5 OP-01 test (Typeform submission nyata); §6 4.R2.1 test #8/#9 (Slack ke Day-1/manager route); semua test Supabase REST di seluruh guide | Konfirmasi Slack benar-benar terkirim ke channel (bukan cuma tercatat di `Cases_Audit_Log`) untuk minimal satu test |
| Privacy | Sentinel confidential dan payroll tidak muncul di dashboard/queue standar/event/log/response/pesan | §6.1 test #3 (`PAYROLL_SECRET_XYZ`); §5 OP-03 test #4 (`SENTINEL_HEALTH_XYZ`); §6 4.R2.2 test (`SENTINEL_SECRET_HEALTH_XYZ`) | Tidak ada, tiga ini sudah cukup mewakili payroll + confidential |
| Idempotency | Retry `execution_id`/source event yang sama tidak menduplikasi evaluasi/case/state/notifikasi | §5.2 test #7 (duplicate delivery OP-05); §6.2 test #4; §7.3 test #2 (duplicate delivery manager event, `successful_reminder_count` tetap 1); ORCH-01 O.1 test #3, O.2 test #2 | Tidak ada, sudah cukup lintas 4 layer berbeda (policy_evaluations, workbench_cases, manager_action_states, workflow_events) |
| Degraded mode | Satu kegagalan Operator/integrasi jadi system_exception yang kelihatan, branch lain tetap jalan | ORCH-01 O.1 test #2; §5.3 test #1–#3; §6.3 test #8 | Tidak ada |
| Generality | Logika rule-based, dipakai di banyak employee/cohort; tidak ada perilaku yang di-hardcode ke satu fixture ID | Seluruh guide sudah memakai >20 `employee_id` berbeda (`EMP7000`–`EMP7147`) lintas §5–§8 plus `COH-2026-W22` | Tidak ada — kalau reviewer minta bukti tambahan, tunjuk baris-baris test di §2–§8 sebagai daftar |

## 9.1 Live verification update — 2026-08-07

This section is the current handoff checkpoint after the 2026-08-06/07 live
Auto session. Raw Activity Timeline outputs and direct Supabase queries remain
the source of truth; builder summaries are not accepted when they disagree.

### Policy, schema, identity, and runtime gates

- The additive Supabase schema, Keycloak setup, payroll RBAC, manager-action
  state contract, and Command Center UI gates remain passed.
- Exactly one policy was active at the latest check:
  `policy_9ccde26035e0415da4291cabe210868a`, parent
  `policy_round2_v1`, `change_summary="Rollback candidate from policy_round2_v1"`,
  config version `2.0`, and `demo_mode=false`.
- Earlier evidence under `policy_a9c97994724541148b8697ad8ccc64f8` and
  `policy_29dfdf8bbb3441d0aa758b2b020773fe` remains valid historical evidence,
  but final integration smoke tests must use the policy active at rehearsal
  time.
- `thresholds.manager_max_reminders` is currently structured as
  `{"default":2}`; Operators must accept the object shape as well as a direct
  scalar where the contract permits it.
- Stale Auto executions were terminated after the workspace showed nine
  lingering `Running` jobs. The post-cleanup runtime state was `Running=0`,
  `Waiting=0`, `Completed=46`, and `Cancelled=53`. Total history count was not
  treated as a documented hard limit.

### OP-05 live evidence

- Clear (`EMP7099`), legal-breach (`EMP7054`), deterministic replay, and all
  three failure-behavior tests remain passed.
- `EMP7054` produced `COMPLIANCE_LEGAL_BREACH` for `CMP-80109`; `CMP-80110` and
  work authorization remained clear. Replaying the same execution preserved one
  deterministic evaluation row per evaluated object/rule.
- Before ORCH-01 integration, run one regression against the then-current active
  policy and confirm the final OP-05 finding objects still match the common
  envelope. The full work-auth threshold matrix is useful evidence but is not on
  the immediate critical path.

### OP-06 live evidence

- OP-06 remains a detector-only workflow. `EMP7062` produced the privacy-safe
  `PAYROLL_ERROR_DETECTED` finding for `payroll:PAY-40063` with severity
  `critical`, owner `people_ops_payroll`, and no salary/error detail exposure.
- Execution `cmd_op06_detector_audit_002` persisted deterministic evaluation
  `eval_384f4e323463fcab9ab42c921a6992be`; replay kept `row_count=1` and
  `evaluation_count=1`.
- OP-06 no longer writes Workbench cases. OP-04 owns the canonical restricted
  case `payroll:EMP7062`.
- Historical cleanup remains: close the legacy direct-writer case
  `payroll-PAY-40063` through a human Workbench action, not a SQL delete.

### OP-07 live evidence — core verified

Saved integrated checkpoint:
`OP-07 Cross-Team Readiness — Core Verified` with commit
`fix(op07): preserve normalized cohort bottleneck evidence and ownership`.

Employee mode:

- Execution `cmd_op07_employee_positive_003` for `EMP7063` returned exactly two
  normalized findings: `DAY_ONE_DEPENDENCY_BLOCKED` and
  `LEARNING_MILESTONE_OVERDUE`.
- Seven deterministic evaluations were persisted: four dependency decisions and
  three learning decisions. Replaying the same execution kept the count at
  seven.

Manager accountability regression after the final step rebuild:

- Fixture `CASE-73-01` for `EMP7009` was in `delivered` state with
  `successful_reminder_count=1`, an expired acknowledgment deadline, and no
  acknowledgment.
- Execution `cmd_op07_manager_smoke_001` returned exactly one
  `MANAGER_ACKNOWLEDGMENT_OVERDUE` finding with evidence
  `case:CASE-73-01`; Day-1 and Learning were clear.
- Direct SQL confirmed eight evaluation rows. State remained `delivered`, count
  remained `1`, and `escalated_at` remained null because `1 < 2`.

Cohort mode:

- The final regression `cmd_op07_cohort_manager_normalization_003` evaluated
  `COH-2026-W22` with denominator `19` and thresholds `2` workers / `25%`.
- Security fired at `14/19 = 73.68%`; Facilities `4/19`, IT `3/19`, and Payroll
  `1/19` were suppressed.
- The final finding preserves 14 sorted safe `dependency:<DEP-...>` evidence
  references, `cohort`, `team`, `affected_count`, `denominator`, `percentage`,
  owner `people_ops_operations`, and the specific cohort-review action.
- Four deterministic cohort-team evaluations were persisted: three `clear`, one
  `non_compliant`. Final status was `completed` with no system exceptions.
- Learning and Manager Accountability correctly bypassed in cohort mode.

Remaining OP-07 technical debt:

- Real result-page pagination for `Cross_Team_Dependencies` is still blocked.
  The code chunks employee IDs for the `in.()` filter but does not yet implement
  a `limit`/`offset` or `Range` loop over result pages. This is documented and is
  not required for the next OP-04/ORCH critical-path tests unless expected live
  volume can exceed one response page.
- The top-level final cohort envelope does not separately repeat `cohort`; the
  value is preserved inside the finding. This is non-blocking for OP-04 but may
  be polished later if the ORCH contract requires it at top level.

### OP-04 live evidence

Verified and saved:

- Compliance route: canonical case `compliance:EMP7054:SG`, idempotent merge,
  no manager Slack.
- Payroll route: canonical restricted case `payroll:EMP7062` with sanitized
  context and no manager-visible fallback.
- Unknown-code route: `XYZ_UNREGISTERED_CODE` produced deterministic system
  exception case `exception:EMP7008:invalid_code`, target `ops_triage`, and no
  Slack. Re-run `cmd_op04_unknown_dedup_002` kept exactly one case.

Remaining OP-04 work:

- route-test the five OP-07 outputs:
  `DAY_ONE_DEPENDENCY_BLOCKED`, `LEARNING_MILESTONE_OVERDUE`,
  `MANAGER_ACKNOWLEDGMENT_OVERDUE`, `MANAGER_ACTION_OVERDUE`, and
  `COHORT_DEPENDENCY_BOTTLENECK`;
- prove the cohort code creates insight/audit only and no per-employee case;
- prove reopen after human resolution and that CLEAR never auto-closes a case;
- prove confidential and standard findings proceed independently;
- replace any temporary exact `reason_code_count == 18` validation with
  non-empty active-policy/engineering-registry parity;
- add/verify sanitized workflow-event correlation where it belongs in the
  ORCH/Command Center flow.

### OP-01, OP-02, and OP-03 compatibility migration

- A teammate reports that the active-policy compatibility amendments have been
  applied to OP-01, OP-02, and OP-03.
- These changes are **not yet accepted as verified**. No saved-builder summary is
  sufficient by itself; run the essential live regression tables and inspect
  Activity Timeline plus `policy_evaluations`.
- Priority order for evidence:
  1. OP-02 boundary pair proving `as_of_date` is read from the active policy;
  2. OP-03 latest-score/disclosure/privacy sentinel behavior;
  3. OP-01 create/update/middle-band/ambiguous-manager behavior and one policy
     threshold-change proof.

### Current critical path for the next session

1. Verify OP-01/02/03 migrations with a minimal high-value regression set; do
   not rebuild unless raw evidence fails.
2. Finish OP-04 routing for all OP-07 reason codes, including cohort insight-only
   behavior.
3. Verify OP-04 lifecycle: reopen after human resolution, CLEAR does not close,
   and confidential/standard independence.
4. Run one current-policy regression for OP-05 and OP-06, then freeze the
   detector contracts.
5. Build/test ORCH-01 parallel fan-out, deterministic merge, branch-failure
   isolation, and OP-04 handoff.
6. Complete G-04 workflow UUID mapping and command/event correlation.
7. Build/test the Daily Cohort Sweep.
8. Run the live acceptance rehearsal and capture screenshots/query evidence.

Low-priority/defer-until-after-core items:

- OP-07 result-page pagination fix and its blocked test;
- exhaustive OP-05 threshold/work-auth matrix beyond the current core evidence;
- closing the legacy payroll case, unless needed for a clean demo Workbench;
- top-level duplicate `cohort` field polish in OP-07.

## 9.2 OP-01 step-level rebuild — 2026-08-08

The six OP-01 Code steps were rewritten one at a time through the Auto builder
and verified with single mock submissions. These are **step-level** results. The
five essential tests in §5 have not been run, so C.1 stays untested.

### Verified by direct step output or database query

- Fetch Active Policy reads the live `status=active` row; the reported
  `version_id` tracked three separate policy activations during the session.
- Manager Resolution returns `halt_pipeline` with reason `ambiguous_manager` for
  the duplicated `Kevin Goh` directory entry, and no worker row is written.
- Fuzzy Dedup reads its thresholds from `config_snapshot`. Proof: with the
  test-5 policy active it reported `0.7 / 0.7 / 3`, where the previous build
  reported a hardcoded `0.9 / 0.75 / 30`. The value `0.75` exists in no policy
  version, which is what identified the hardcoded dictionary — a matching
  current value would have been inconclusive.
- The canvas edge condition `Dedup Requires Review` correctly routes the renamed
  `intake_possible_duplicate` result to the human escalation form, so the
  vocabulary change did not fail open into the write step.
- Supabase Write create path: `Employee_ID` stays null, `Manager_WID` holds the
  resolved WID, the audit row carries `outcome = "clear"`, and `execution_id` is
  a real Auto run UUID rather than a constant.
- The `service_role` JWT the builder had embedded in three steps is gone; every
  step now reads credentials from environment variables with no fallback. The
  key was rotated.

### Essential test results — 2026-08-07, 18:53–18:56 UTC

All five §5 OP-01 essentials ran live and passed. Correlated from
`policy_evaluations` by `execution_id`; each run's rows share one Auto run UUID.

| Run | Active policy | Dedup decision | Persistence | Test |
|---|---|---|---|---|
| `019fdd92-e3a5` | `…f5384757` | `WILL_CREATE` | `clear` / `created` | #1 clean create |
| `019fdd93-1757` | `…f5384757` | `WILL_UPDATE` | `clear` / `updated` | #2 name variant, band ≥ upper |
| `019fdd93-4a31` | `…f5384757` | `INTAKE_POSSIBLE_DUPLICATE` | — | #3 middle band escalates |
| `019fdd93-cd34` | `…f5384757` | — (not reached) | — | #4 ambiguous manager halts |
| `019fdd95-34b4` | `…03a4d111` | `WILL_UPDATE` | `clear` / `updated` | #5 threshold change |

Tests #3 and #5 submit the identical payload and differ only in the active
policy version, so the changed result cannot be explained by changed data. That
pair is the migration proof. `policy_be088f616c1a42a895c34d7003a4d111` (parent
`policy_2ed96ee…`, the lowered-band draft) was activated at 18:55:58 and #5 ran
at 18:56:19.

Known caveat, not a failure: a stale branch condition after Date Parsing fires
the escalation edge even on a successful parse, so each run also raised a Date
Parsing Escalation and ended in `awaiting_human_input` rather than `completed`.
The business decisions and the persisted rows above are unaffected because the
success edge fired as well. A rewrite covering both the step and the two edge
conditions is pending. Resolve the leftover human-review items before the §9
acceptance rehearsal, where a clean terminal state does matter.

### Optional, non-blocking debt

None of the items below changes a decision, and none affected the five passing
essentials. Fix opportunistically.

- Supabase Write stores `evidence` as a one-element array instead of an object,
  so queries need `evidence->0->>'key'`.
- Supabase Write reports the success status code in `error_status_code` (201 on
  create) instead of null.
- Supabase Write writes `action = "created"/"updated"` where Fuzzy Dedup writes
  `action = "will_create"/"will_update"`. The `intake_result` value is still
  preserved inside `evidence`, so no information is lost.
- Field Validation, Date Parsing, and Manager Resolution still name a constant
  `execution_id` fallback (`manual_execution`, `local_execution`,
  `manual_run_context`). In the live runs above the fallback never triggered —
  all four steps of each run shared one Auto run UUID — so correlation and
  replay idempotency hold in the global environment. The constant only surfaces
  in local builder runs, where it makes two applies of the same payload collide
  on one `evaluation_id`. Low priority; remove the fallback when those steps are
  next rewritten. Fuzzy Dedup and Supabase Write already fall back to
  `workflow_run_id` instead of a constant.
- Those same three steps write `evidence` as a `json.dumps` string into a
  `jsonb` column and use `PASS`/`SKIP`/`FAIL` vocabulary instead of lowercase
  `clear`.

## 10. Build status tracker

Update this table only from raw Activity Timeline and direct database/API
proof. `Builder says done` is not evidence.

| ID | Workflow | Build step | Build | Tests | Evidence / notes |
|---|---|---|---|---|---|
| G-01 | Policy Studio | Active Round 2 policy | Done | Passed | Latest observed active version: `policy_9ccde26035e0415da4291cabe210868a`, config `2.0`, `demo_mode=false`. Re-query before every test block. |
| G-02 | Command Center | Restricted payroll RBAC | Done | Passed | Admin/payroll-reviewer login and restricted payroll visibility verified. |
| G-03 | Command Center | Manager action-state contract | Done | Passed | Live table/RPC contract and manager state fixtures verified. |
| G-04 | Runtime config | Published workflow UUID mapping | Not started / unverified | Not started | Required before ORCH-01 publish and Command Center production invocation. |
| UI | Command Center | Policy Studio, Workbench, Dashboard, Data Manager | Done | Passed core build/login | Human Workbench action still needed as acceptance evidence. |
| 5.1 | OP-05 | Context/policy/timezone | Done | Passed core | Valid SG/AU contexts and safe failure behavior verified. |
| 5.2 | OP-05 | Compliance/work-auth rules + logs | Saved | Core passed | Clear, legal breach, and replay idempotency passed; run one final current-policy/common-envelope regression. |
| 5.3 | OP-05 | Failure behavior | Done | Passed 3/3 | Read failure, malformed-item isolation, and exhausted write retry verified. |
| 6.1 | OP-06 | Restricted payroll context | Saved | Core passed | Privacy-safe field allowlist verified; final sentinel evidence remains optional for acceptance. |
| 6.2 | OP-06 | Payroll rules + audit | Done | Passed | Detector replay persisted one deterministic row. |
| 6.3 | OP-06/OP-04 | Restricted payroll route | Saved | Core passed, lifecycle partial | Canonical `payroll:EMP7062`; OP-06 is detector-only. Reopen/CLEAR/failure-route tests remain. |
| 7.1 | OP-07 | Employee dependencies + learning | Done | Passed | `EMP7063` final contract and seven-row replay verified after downstream rebuild. |
| 7.2 | OP-07 | Cohort bottlenecks | Core verified | Passed core; pagination blocked | Security 14/19, complete safe metadata/evidence, four team audit rows. True result pagination remains technical debt. |
| 7.3 | OP-07 | Manager accountability | Done | Passed + post-rebuild smoke | `EMP7009`/`CASE-73-01`: one overdue finding, eight rows, no false escalation. |
| C.1 | OP-01 | Active-policy compatibility | Rebuilt, verified | **Passed 5/5** | Runs `019fdd92-e3a5` … `019fdd95-34b4`, 2026-08-07 18:53–18:56; see §9.2 for the per-test table. Migration proof is the #3/#5 pair: identical payload, `…f5384757` escalates and `…03a4d111` updates. Caveat: a stale Date Parsing branch condition also raises a spurious escalation, so runs end `awaiting_human_input` instead of `completed`; decisions and persisted rows unaffected, fix pending. Remaining §9.2 items are optional. |
| C.2 | OP-02 | Active-policy compatibility | Updated by teammate | Not tested | Boundary `as_of_date` pair is mandatory evidence. |
| C.3 | OP-03 | Active-policy compatibility | Updated by teammate | Not tested | Latest-score, disclosure scan, and privacy sentinel are mandatory evidence. |
| 4.R2.1 | OP-04 | Round 2 routing/grouped cases | Saved | Partial | Compliance, payroll, unknown code, and dedup passed. All OP-07 routes and lifecycle remain. |
| 4.R2.2 | OP-04 | Confidential independence | Not started | Not started | Required before final privacy acceptance. |
| O.1 | ORCH-01 | Parallel fan-out/merge/handoff | Not started | Not started | Next major build after Operator regressions/routing. |
| O.2 | ORCH-01 | Command/event correlation | Not started | Not started | Depends on O.1 and G-04. |
| S.1 | Daily Sweep | Schedule/fan-out/cohort aggregation | Not started | Not started | Depends on ORCH-01 and verified OP-07 cohort mode. |
| E2E | All | Live acceptance rehearsal | Not started | Not started | Policy change → Auto → OP-04 → human Workbench → Dashboard/audit evidence. |
