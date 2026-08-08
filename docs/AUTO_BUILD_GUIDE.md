# AUTO_BUILD_GUIDE.md — Round 2 Auto Operator Build Prompts

## Purpose

This is the copy-paste runbook for the work that remains on the Round 2 HR Ops
build in Supervity Auto: finishing `OP-04` routing, integrating `ORCH-01`, building
the Daily Cohort Sweep, and running the end-to-end (E2E) acceptance suite.

Full historical build content for OP-01, OP-02, OP-03, OP-05, OP-06, and OP-07
(all frozen/verified except one pending current-policy smoke test each for OP-05
and OP-06) has been moved to `docs/AUTO_BUILD_GUIDE_ARCHIVE_2026-08-08.md`. This
file covers only what remains: OP-04, ORCH-01, the Daily Cohort Sweep, and
end-to-end acceptance.

Build scope still open:

- finish the routing rewrite for the existing notification Operator (`OP-04`)
  and its MVP verification;
- integrate the Orchestrator (`ORCH-01`) parallel fan-out, merge, and
  command/event correlation;
- build the scheduled parent workflow for the 09:00 UTC daily cohort sweep;
- run the E2E acceptance rehearsal.

Auto hosts the Orchestrator and Operators; this repository remains the Command
Center, policy API, data view, and human Workbench.

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

## Frozen Operators — OP-01, OP-02, OP-03, OP-05, OP-06, OP-07

Full build prompts and test matrices: `docs/AUTO_BUILD_GUIDE_ARCHIVE_2026-08-08.md`
§2-§5 (OP-05, OP-06, OP-07) and the archived §5/§9 material for OP-01/02/03.

- **OP-01:** teammate completed all five essential live tests on 2026-08-08.
  Clean create, name-variant update, middle-band escalation, ambiguous-manager
  halt, and threshold-change proof all passed. The threshold-change pair used
  identical payloads under different active policy versions, so it is valid
  migration evidence. One remaining OP-01 defect is still relevant to final E2E:
  a stale Date Parsing canvas edge also raises a spurious escalation after a
  successful parse, leaving runs in `awaiting_human_input` instead of a clean
  terminal state. Business decisions and persisted rows are correct; a teammate
  still needs to fix this edge before the final rehearsal.
- **OP-02:** accepted as verified. Live EMP7000 regression produced all four
  expected reasons under the active policy, semantic `policy_key` values were
  persisted, deterministic evaluation IDs were proven, full policy snapshot
  logging was sanitized, and the normalized final envelope contains
  `confidence=1.0` and `system_exceptions=[]`. Freeze OP-02 unless ORCH
  integration exposes a regression.
- **OP-03:** accepted as fully verified and frozen. Tests proved:
  latest-semantic-milestone scoring (`EMP7046`), recovery ordering (`EMP7021`),
  confidential disclosure (`EMP7003`), historical disclosure surviving a newer
  healthy survey (`EMP7090`), zero-leakage sentinel behavior, and active-policy
  behavior change through Policy Studio (`engagement_low_score 5 -> 2`) followed
  by a successful restore to baseline. OP-03 also established an end-to-end
  policy-control proof: Policy Studio -> immutable `policy_versions` snapshot ->
  Auto policy fetch -> changed deterministic rule outcome without editing the
  Operator.
- **OP-07:** employee mode (Day-1 dependencies + learning), cohort mode
  (bottleneck thresholds), and the manager-accountability state machine are all
  core-verified. `EMP7063` returns `DAY_ONE_DEPENDENCY_BLOCKED` and
  `LEARNING_MILESTONE_OVERDUE` with seven deterministic evaluation rows; cohort
  `COH-2026-W22` correctly fires Security at 14/19 and suppresses the other three
  teams; `EMP7009`/`CASE-73-01` produces one `MANAGER_ACKNOWLEDGMENT_OVERDUE`
  finding with no false escalation. Remaining technical debt, non-blocking for
  now: real result-page pagination for `Cross_Team_Dependencies` is not yet
  implemented (only relevant if live result volume exceeds one response page).
- **OP-05:** core context/policy/timezone handling and failure behavior are
  verified (clean/unknown/missing-policy/timezone-ambiguity contexts; legal
  breach and deadline-at-risk rule evaluation; read-failure, malformed-item, and
  exhausted-write-retry isolation all passed). One action remains: run a
  current-policy smoke regression — `EMP7054` -> `COMPLIANCE_LEGAL_BREACH`
  (evidence `compliance-item:CMP-80109`) — against whichever policy is active at
  test time, and confirm the finding still matches the common envelope, then
  freeze the contract.
- **OP-06:** detector-only core evaluation and idempotency are verified.
  `EMP7062` produces the privacy-safe `PAYROLL_ERROR_DETECTED` finding for
  `payroll:PAY-40063`, severity `critical`, owner `people_ops_payroll`, with no
  `error_reason`, `gross`, or `net` exposed. One action remains: run the same
  current-policy smoke regression — `EMP7062` -> `PAYROLL_ERROR_DETECTED`,
  critical, evidence `payroll:PAY-40063`, no `error_reason`/`gross`/`net` — against
  whichever policy is active at test time, then freeze the contract.

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

> **Jangan jalankan blok ini dulu.** Setelah code review §4.R2.3, OP-04 ditulis
> ulang lebih dahulu. Untuk MVP jalankan hanya dua test di §4.R2.4; matriks
> `testing1`–`testing19` di bawah adalah cakupan lengkap untuk sesudah demo.

Gunakan form OP-04 yang benar-benar terlihat di Auto Studio. Semua input di
bawah ditulis dalam urutan field UI yang sama. `execution_id` dan `command_id`
selalu identik agar mudah dicari di Activity Timeline. Nilai
`<ACTIVE_POLICY_VERSION_ID>` wajib diganti dengan hasil query policy aktif tepat
sebelum blok test; jangan memakai ID dari sesi lama. `Allow automatic step
retries`/auto-fix tetap **OFF** di semua test.

Direct form ini menguji kontrak **routing OP-04**, bukan mengulang deteksi
OP-05/06/07 yang sudah diverifikasi. Karena itu finding sengaja tidak mengirim
`domain`, `severity`, `owner`, atau target route. OP-04 harus menurunkan semua
itu dari `reason_code` yang tervalidasi, bukan mempercayai petunjuk route dari
caller.

| # | Trace ID | Scenario | Expected evidence |
|---|---|---|---|
| 1 | `testing1` | Compliance deadline at risk | Canonical compliance Workbench; tidak ada Slack manager |
| 2 | `testing2` | Compliance legal breach | Canonical compliance Workbench; tidak ada Slack manager |
| 3 | `testing3` | Work authorization at risk | Canonical compliance/work-auth Workbench; tidak ada Slack manager |
| 4 | `testing4` | Work authorization expired | Canonical compliance/work-auth Workbench; tidak ada Slack manager |
| 5 | `testing5` | Payroll error | Restricted payroll Workbench saja; tidak ada manager route |
| 6 | `testing6` | Payroll not confirmed | Restricted payroll Workbench saja |
| 7 | `testing7` | Payroll record missing | Restricted payroll Workbench saja; tidak perlu menghapus source payroll karena ini routing-only |
| 8 | `testing8` | Day-1 blockers grouped | Satu `dependency:EMP7063` dengan tiga evidence refs |
| 9 | `testing9` | Learning overdue grouped | Satu `learning:EMP7101`; standard manager-to-People-Ops route |
| 10 | `testing10` | Manager acknowledgment overdue | People Ops accountability; bukan nudge ulang ke manager |
| 11 | `testing11` | Manager action overdue | People Ops accountability; bukan nudge ulang ke manager |
| 12 | `testing12` | Cohort bottleneck | Insight/audit-only; nol case per employee dan nol notification |
| 13 | `testing13` | Unknown code | Satu safe system exception; nol standard/payroll case dan nol Slack |
| 14 | `testing14` | Recurring finding | Update canonical case test #1; jumlah case tetap satu |
| 15 | `testing15` | Multi-code grouping | Dua findings compliance/work-auth menjadi satu canonical case dengan union reason/evidence |
| 16 | `testing16` | Reopen after human resolution | Case Day-1 yang sama kembali `open`; `resolved_at` kembali null |
| 17 | `testing17` | CLEAR/no findings | Tidak mengubah atau auto-resolve case yang sudah ada |
| 18 | `testing18` | Invalid supplied policy | Structured policy exception, `halt_pipeline=true`, nol write/notification |

Full test payloads for `testing1`-`testing19` (the individual per-scenario
`text` blocks for tests 1-18 above, plus test 19 in §4.R2.2 below):
`docs/AUTO_BUILD_GUIDE_ARCHIVE_2026-08-08.md` §6, 4.R2.1/4.R2.2. `testing18`'s
payload is not repeated here; it is inline in §4.R2.4 (MVP-2 — fail-closed
gate), which is the currently active use of that test.

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

**Test 19 — confidential and standard findings remain independent:**

Direct OP-04 form proves partition/routing with a sanitized payload: one
restricted confidential route and one standard Day-1 case for `EMP7003`,
neither suppressing the other, with no confidential payload reaching the
standard case/message. It does not prove OP-03/ORCH never leaks the source
comment; that still needs an end-to-end repeat through ORCH-01 O.1's
confidential + standard test. Full payload:
`docs/AUTO_BUILD_GUIDE_ARCHIVE_2026-08-08.md` §6, 4.R2.2.

### 4.R2.3 — Hasil code review lima step OP-04 — 2026-08-08

> Status bagian ini adalah **source-code review**, bukan bukti live run. Temuan baru boleh ditandai selesai setelah step di-rewrite, disimpan, lalu test diskriminatif terkait lulus dengan bukti Timeline dan SQL. Lima step yang direview adalah `Fetch Active Policy`, `Process Findings and Routes`, `Insert Workbench Cases`, `Render Outbound Message`, dan `Send to Slack`.

| Step | Verdict saat review | Risiko tertinggi | Test utama yang terdampak |
|---|---|---|---|
| Fetch Active Policy | **BLOCKER** | Policy tidak lengkap/unknown masih dapat dianggap valid; active policy tunggal tidak benar-benar dibuktikan | `testing18` dan seluruh positive-path test |
| Process Findings and Routes | **BLOCKER** | Route dan identity ditentukan dari `finding.domain` milik caller, bukan mapping exact `reason_code`; grouping belum dilakukan | `testing1`–`testing15`, `testing19` |
| Insert Workbench Cases | **BLOCKER** | Retry masih hardcoded dan duplicate identity dipost paralel sehingga reason/evidence dapat saling menimpa | `testing8`, `testing14`–`testing17` |
| Render Outbound Message | **BLOCKER** untuk route Round 2 yang membutuhkan notifikasi | Template masih dibaca dari legacy `policy_config`, sedangkan output Round 2 tidak mengisi dependency yang dibutuhkan renderer | `testing9`–`testing11`, `testing19` |
| Send to Slack | **BLOCKER** untuk dynamic retry dan failure observability | Retry/profile masih dibaca/hardcoded dari legacy config; failure hanya membuat object in-memory | Notification test yang diizinkan serta negative no-Slack assertions |

#### 1. Fetch Active Policy

Temuan:

1. Query mengambil policy berdasarkan `version_id` dari form dengan `select=*`. Step tidak melakukan query active-policy tunggal seperti `status=eq.active`, `limit=2`, lalu memastikan hasil tepat satu row. Status global "exactly one active policy" belum terbukti.
2. Status dianggap aktif bila `status == 'active'` **atau** legacy `is_active is True`. Fallback legacy ini melemahkan contract policy versioned.
3. Validasi registry hanya memastikan `reason_codes` berupa list non-empty, string nonblank, dan unik. Step tidak membandingkannya dengan engineering registry exact, sehingga registry yang kurang atau berisi code asing masih bisa menghasilkan `validation_status = Valid`.
4. Validasi retry menerima Python boolean sebagai integer/number (`isinstance(True, int)` bernilai true). `max_attempts=true` atau boolean pada `backoff_seconds` dapat lolos secara keliru.
5. Full `config_snapshot` dan retry object disimpan ke shared output. Response body Supabase juga dicetak saat HTTP error. Ini memperbesar risiko policy/internal detail muncul di Timeline atau downstream output.
6. Missing credential, malformed JSON snapshot, dan error fetch lain dapat di-raise sebagai raw exception, belum menjadi safe structured `system_exception`.
7. `policy_version_id` pada output berasal dari input caller, bukan ID row active yang benar-benar dikembalikan database.

Yang sudah benar:

- Tidak ada hardcoded assertion jumlah reason code `== 18`.
- Pemilihan retry profile membedakan top-level `retry` dan `retry_demo_profile` berdasarkan `demo_mode`.
- Baseline check `max_attempts >= 1` dan backoff nonnegative sudah ada, tetapi type check perlu diperketat agar boolean ditolak.

Perbaikan/bukti wajib:

- Query hanya field aman yang diperlukan, buktikan tepat satu row `status=active`, validasi exact parity terhadap engineering registry, dan fail closed tanpa mengeluarkan full snapshot.
- Jalankan `testing18` untuk missing/invalid policy dan satu positive test. Timeline harus menunjukkan downstream benar-benar skipped; bukan hanya Process step berjalan lalu early-return.

#### 2. Process Findings and Routes

Temuan:

1. **Critical:** route, identity, dan target ditentukan terutama dari `finding.domain` yang dikirim caller. Exact `reason_code` belum menjadi sumber keputusan. Caller dapat mengirim unknown reason dengan domain yang diizinkan, atau reason payroll dengan `domain=learning`, lalu memperoleh route normal yang salah.
2. Reason code hanya dibandingkan dengan registry dari policy, belum dengan engineering registry. Unknown code baru diubah ke `system_exception` jika caller juga memberikan domain di luar allowlist; unknown code dengan domain `learning`, `payroll`, `dependency`, atau `compliance` masih dapat lolos.
3. Tidak ada grouping deterministik. Setiap finding langsung menjadi satu case. Dua finding dengan identity sama diteruskan sebagai dua item terpisah, sehingga downstream upsert dapat saling overwrite alih-alih melakukan union reason/evidence.
4. `scope` default ke `employee`; invalid scope tidak ditolak. Cohort kosong juga tidak ditolak dan menghasilkan identity `cohort:unknown`.
5. Semua finding dengan `scope=cohort` diperlakukan sebagai audit-only. Logic belum membatasi zero-fan-out hanya untuk reason cohort yang memang diizinkan, misalnya `COHORT_DEPENDENCY_BOTTLENECK`.
6. Worker lookup dapat gagal, mengembalikan zero row, atau ambigu, tetapi workflow tetap lanjut. Compliance case dapat terbentuk dengan jurisdiction kosong seperti `compliance:<subject>:`.
7. `worker_wid` dapat langsung dipakai sebagai subject identity tanpa resolusi canonical employee identity.
8. Tidak ada mapping exact untuk learning, manager accountability, restricted payroll, compliance, dan system exception. Sebagian besar behavior hanya mengikuti caller domain lalu default ke `workbench`.
9. Output tidak menyediakan list `system_exceptions` yang terstruktur.
10. JSON input invalid diam-diam dikonversi menjadi list kosong. Input error menjadi sulit dibedakan dari no-findings run.
11. Saat policy invalid, step tetap dijalankan oleh canvas dan hanya early-return. Ini belum memenuhi fail-closed gate pada level orchestration.

Yang sudah benar:

- Cohort output memasang `should_create_workbench_case=false` dan `should_notify=false`.
- Pola dasar identity per domain sudah deterministik, tetapi baru aman setelah domain diturunkan dari exact reason-code mapping, bukan dari caller.

Perbaikan/bukti wajib:

- Abaikan `finding.domain` sebagai authority. Derive domain, identity key, target, privacy, dan notification behavior dari exact reason code yang sudah lolos dual-registry validation.
- Group semua finding berdasarkan canonical identity key sebelum output; union dan urutkan deterministically `reason_codes` serta `evidence_refs`.
- Uji grouping (`testing14`), unknown code (`testing13`), worker lookup failure (`testing12`), cohort zero-fan-out (`testing8`), learning tanpa caller-domain hint (`testing9`), dan accountability (`testing10`–`testing11`).

#### 3. Insert Workbench Cases

Temuan:

1. Retry masih hardcoded: demo satu attempt, production tiga attempt, backoff `[2, 5]`. Step tidak mengonsumsi retry object tervalidasi dari active policy.
2. Upsert memakai `Prefer: resolution=merge-duplicates` tetapi URL tidak menyatakan `on_conflict=case_id` secara eksplisit. Contract conflict target belum terlihat jelas.
3. Semua raw case dipost paralel. Karena Process belum melakukan grouping, duplicate `case_id` dapat race dan write terakhir dapat membuang reason/evidence dari write lain.
4. Dedup menggunakan `set()`, sehingga urutan `reason_codes` dan `evidence_refs` tidak deterministik.
5. Reopen selalu menulis `status='open'`, tetapi tidak mengosongkan `resolved_at`. Row dapat menjadi `open` dengan timestamp resolved lama.
6. `policy_version_id` pada sanitized context berasal dari form caller, bukan active version tervalidasi dari Fetch.
7. Evidence, domain, dan severity dari caller dimasukkan ke `sanitized_context` tanpa shape/prefix allowlist yang cukup.
8. Raw `resp.text` dan exception string dimasukkan ke error output. Failure belum dinormalisasi menjadi safe structured integration exception.
9. `partial_success` hanya menjadi summary output; belum ada persisted exception/task yang dapat dioperasikan.

Yang sudah benar:

- Case hanya diproses bila `should_create_workbench_case is True`; cohort audit-only terfilter.
- `case_id = identity_key` mendukung canonical upsert.
- Empty case list tidak menutup case existing secara otomatis.

Perbaikan/bukti wajib:

- Terima hanya case yang sudah grouped dan sanitized dari Process; gunakan active retry profile, conflict target eksplisit, deterministic sort, dan clear `resolved_at` saat reopen.
- Jalankan grouping/upsert (`testing14`), idempotent rerun (`testing15`), reopen (`testing16`), dan empty direct envelope/no-auto-close (`testing17`) dengan SQL before/after.

#### 4. Render Outbound Message

Temuan:

1. Template masih dibaca dari legacy table `policy_config`, bukan dari active `policy_versions.config_snapshot`. Ini mencampur dua sumber konfigurasi dalam satu run.
2. Jalur Round 2 pada Process tidak mengisi `user_inputs['resolve_channel']`; akibatnya Render melihat routing unresolved dan skip. Notification route Round 2 belum dapat dibuktikan end-to-end.
3. Renderer memakai UUID dari legacy `Generate Case ID`, bukan canonical identity key Round 2.
4. `reason_summary` dibentuk dari raw `reasons[].detail` milik caller. Raw/free-text input dapat masuk ke pesan keluar.
5. Confidential branch memang hanya memakai milestone dan link, tetapi fallback link masih menunjuk legacy `Cases_Audit_Log` dan UUID, bukan canonical secure case reference.
6. Manager day number memakai `date.today()` dan dapat menjadi `unknown`; source time/worker data contract belum eksplisit.
7. Full rendered message dicetak ke stdout dan UI. Ini hanya aman bila seluruh interpolasi sudah allowlisted dan disanitasi.
8. Template fetch failure melempar `RuntimeError` yang membawa exception text, belum structured safe failure.
9. Konstruksi Supabase URL tidak konsisten dengan step lain jika env berisi full project URL.

Yang sudah benar:

- `workbench_log` dan unresolved route tidak mengirim pesan.
- Confidential renderer tidak secara langsung menginterpolasi raw internal comment/driver; milestone + case link adalah arah privacy yang benar.

Perbaikan/bukti wajib:

- Ambil template dari snapshot policy yang sama dengan run, gunakan canonical Round 2 case reference, dan hanya interpolasikan field allowlisted per reason/route.
- Uji learning (`testing9`), accountability suppression/escalation (`testing10`–`testing11`), dan confidential privacy (`testing19`) dengan inspeksi Timeline/output payload.

#### 5. Send to Slack

Temuan:

1. `demo_mode` dibaca ulang dari legacy `policy_config`, bukan dari output Fetch yang sudah tervalidasi.
2. Attempt/backoff masih hardcoded (`1` atau `3`; `[5, 20, 60]`) alih-alih memakai retry profile active policy. Nilainya mungkin kebetulan sama dengan seed saat ini, tetapi behavior tidak dynamic.
3. Step mempercayai `target_channel` dan `rendered_message` dari upstream tanpa mengulang guard route/privacy yang eksplisit sebelum side effect.
4. Setelah retry gagal, step hanya membuat object `workbench_task` in-memory. Tidak ada persisted `system_exception` atau workbench task yang dapat ditrace setelah run berakhir.
5. Slack API error dan exception string dicetak ke stderr; log-safety belum dibuktikan.
6. Tidak ada idempotency/source-event key untuk mencegah duplicate notification pada rerun.
7. Direct `chat.postMessage` masih perlu dibuktikan menggunakan credential/integration yang disetujui untuk environment tersebut.

Yang sudah benar:

- Step skip untuk `workbench_log` atau rendered message kosong.
- Slack token hanya dibaca dari environment, tidak di-hardcode di source.

Perbaikan/bukti wajib:

- Konsumsi target, privacy decision, idempotency key, dan retry profile dari state tervalidasi yang sama; persist safe notification failure tanpa raw secret/error payload.
- Untuk route yang tidak boleh notify, Timeline harus membuktikan Slack step skipped/no call. Untuk route yang diizinkan, capture success response yang aman dan pastikan rerun tidak menggandakan notification.

#### Temuan integrasi canvas lintas lima step

1. Canvas menjalankan `Fetch Active Policy` dan `Generate Case ID` paralel lalu merge ke Process, tetapi tidak terlihat condition gate `halt_pipeline == false`. Invalid policy tetap mencapai Process sebagai early-return, bukan menghentikan downstream secara struktural.
2. Jalur Round 2 terlihat `Process -> Insert Workbench Cases -> Audit`. `Render Outbound Message -> Send to Slack` berada pada branch legacy Round 1. Dengan wiring dan shared-output sekarang, route Round 2 yang memang membutuhkan notifikasi belum tersambung end-to-end.
3. UUID dari `Generate Case ID` masih berguna untuk legacy message/audit correlation, tetapi tidak boleh menggantikan canonical Round 2 identity key.
4. Fetch memakai `policy_versions`, sedangkan Render dan Slack kembali membaca `policy_config`. Satu execution dapat memakai policy dan template/retry dari versi berbeda.

Urutan repair yang direkomendasikan:

1. Rewrite `Fetch Active Policy` agar exact-active, dual-registry, safe-output, dan fail-closed.
2. Tambahkan condition gate canvas sebelum Process/downstream.
3. Rewrite `Process Findings and Routes` dengan exact reason mapping, canonical identity, grouping, privacy, dan structured exceptions.
4. Rewrite `Insert Workbench Cases` untuk grouped deterministic upsert, dynamic retry, reopen semantics, dan safe failures.
5. Refactor `Render Outbound Message` dan `Send to Slack` agar memakai active snapshot/state yang sama dan hanya aktif untuk notification route yang disetujui.

Kerjakan satu full-step rewrite per chat, lalu jalankan minimal satu test diskriminatif untuk bug step tersebut. Simpan step, commit build di Auto Studio, dan ambil bukti Timeline/SQL sebelum pindah ke step berikutnya. Jangan menandai temuan sebagai fixed hanya dari code preview.

### 4.R2.4 — Prompt rewrite pasca code review dan verifikasi MVP — 2026-08-08

> Bagian ini adalah urutan kerja OP-04 yang berlaku sampai demo. Matriks
> `testing1`–`testing19` di §4.R2.1/4.R2.2 **tidak** dijalankan seluruhnya lebih
> dulu; ia tetap menjadi matriks lengkap untuk sesudah demo. Untuk MVP jalankan
> hanya dua test di "Verifikasi MVP" di bawah.

#### Kenapa satu prompt gabungan, dan apa risikonya

§4.R2.3 merekomendasikan satu full-step rewrite per chat. Karena waktu terbatas,
prompt di bawah menggabungkan kelima step ditambah dua perbaikan canvas dalam
satu eksekusi build. Risikonya nyata dan tidak dihilangkan oleh apa pun di sini:
kalau test gagal, kegagalannya tidak otomatis menunjuk satu step.

Dua mitigasi dipasang. Prompt dipecah menjadi enam blok yang masing-masing bisa
berdiri sendiri, jadi kalau builder mandek kamu paste satu blok saja tanpa
menulis ulang apa pun. Dan setiap assertion test dipetakan ke nomor temuan
§4.R2.3, jadi kegagalan tetap bisa dilokalisasi ke step.

Aturan anggaran yang berlaku: **yang memakan satu eksekusi build adalah prompt,
bukan run test form.** Satu prompt ditambah tiga submit form tetap patuh
one-fix-one-test.

#### Prasyarat — selesaikan sebelum membuka chat builder

1. **Konfirmasi versi OP-04 terakhir yang benar-benar ter-commit.** Chat builder
   baru mulai dari versi ter-commit, bukan dari draft di layar. Checkpoint
   `OP-04 Day-1 Route & Dynamic Policy Context — Verified` disiapkan pada sesi
   sebelumnya tetapi tidak pernah terbukti tersimpan. Kalau belum, save/commit
   dulu.
2. **Salin kode kelima step ke file** (`docs/op04/before/01-fetch-active-policy.py`
   … `05-send-to-slack.py`). Tanpa "before" tidak ada bukti rewrite memperbaiki
   apa pun, dan tidak ada jalan rollback.
3. **Cek apakah snapshot policy aktif punya key `templates`.** Render harus
   berhenti membaca `policy_config`; kalau snapshot tidak menyimpan template,
   prompt di bawah memakai `builtin_default` dan kamu perlu tahu mana yang
   berlaku saat membaca hasil.

   ```sql
   select version_id,
          config_snapshot ? 'templates' as has_templates,
          config_snapshot->>'demo_mode' as demo_mode,
          config_snapshot->'retry'      as retry
   from policy_versions where status='active';
   ```
4. **Catat baseline `workbench_cases` untuk `EMP7032`** dan lihat isi mentah
   `sanitized_context` sekali — nama key di dalamnya belum terdokumentasi, dan
   SQL verifikasi di bawah bergantung padanya.

   ```sql
   select case_id, case_type, priority, status, resolved_at, sanitized_context
   from workbench_cases where employee_id='EMP7032' order by case_id;
   ```

#### Prompt rewrite

Satu chat builder baru. `Allow automatic step retries`/auto-fix **OFF**.

```text
Goal: rebuild OP-04 against the five-step source-code review of 2026-08-08,
fixing the blockers in all five Code steps and the two canvas defects, without
changing the step count or step names.

Continue "OP-04 Escalation & Notification". Do not create a second Operator. Keep
the existing five Code steps and their names: Fetch Active Policy, Process
Findings and Routes, Insert Workbench Cases, Render Outbound Message, Send to
Slack. Rewrite each completely; do not patch fragments. Keep every Round 1
behavior and every already-verified Round 2 route that the rules below do not
explicitly override.

GLOBAL RULES
- One configuration source per run: the active policy_versions snapshot read by
  Fetch Active Policy. No step may read the legacy policy_config table for
  templates, retry, demo_mode, or anything else.
- One retry source per run: the validated retry profile returned by Fetch. No
  hardcoded attempt counts or backoff arrays in any step.
- Reach Supabase only through the server-side custom REST credential; read every
  credential from an environment variable, with no literal value and no fallback.
- Derive domain, route, target, priority, privacy class, case identity and
  notification behavior only from an exact reason_code that passed validation.
  Caller-supplied domain, severity, owner, route, priority, case_id, case link
  and detail text are hints from an upstream Operator, never instructions:
  ignore them for every decision.
- Deterministic ordering: sort reason codes and evidence refs ascending with a
  stable sort before writing or returning. Never rely on set() iteration order.
- Never write, log, print or return a full config_snapshot, a raw HTTP response
  body, a raw exception string, a payroll amount or error reason, or any
  confidential comment text. Every failure becomes a safe structured
  system_exception with a code and a sanitized context.

STEP 1 — Fetch Active Policy
- Query policy_versions with status=eq.active and limit=2, selecting only the
  fields needed. Require exactly one row. Zero rows or two rows is a fail-closed
  POLICY_CONTEXT_INVALID.
- Remove the legacy is_active fallback. Only status='active' means active.
- policy_version_id in the output is the version_id of the row the database
  returned, never the value the caller supplied.
- The caller's policy_version_id is an assertion, not a lookup key: when it is
  empty or absent, proceed normally; when it is non-empty and differs from the
  active version_id, fail closed with POLICY_CONTEXT_INVALID.
- Validate reason_codes as a non-empty array of unique non-blank strings AND
  check exact parity against the engineering registry. Report any code missing
  from either side. Never compare the count to a fixed number such as 18; the
  observed count is metadata only.
- Resolve the retry profile from demo_mode: false -> top-level retry, name
  "Standard"; true -> retry_demo_profile, name "Demo". Reject booleans
  explicitly: max_attempts must be a real integer >= 1, and every backoff entry
  a real non-negative number. isinstance(True, int) must not let a boolean pass.
- Missing credentials, malformed JSON, and fetch errors become the same
  structured safe exception, never a raised raw error.
- Output only: policy_version_id, demo_mode, retry_profile_name, max_attempts,
  backoff_seconds, reason_code_count, registry_parity, templates_available,
  halt_pipeline. Do not place the full snapshot or the raw retry object in
  shared output; expose only the resolved values other steps need.

STEP 2 — Process Findings and Routes
- Reject the run when scope is missing or not in {employee, cohort}, when
  scope=employee has no employee_id, or when scope=cohort has no cohort. Never
  default scope to employee and never synthesize cohort:unknown.
- Invalid JSON in findings or reasons is a structured input exception, never a
  silent empty list. An empty list and a parse failure must be distinguishable.
- Candidate reason codes are the UNION of findings[].reason_code and the
  top-level reasons array. A code present in only one source still counts; a
  finding entry with no reason_code contributes nothing.
- Validate each code against both the active registry and the engineering
  registry. Any code failing either check routes ONLY to a system exception,
  regardless of the domain the caller attached to it.
- Derive domain from an exact reason_code -> route table. Never read
  finding.domain. Required mapping:
    COMPLIANCE_DEADLINE_AT_RISK, COMPLIANCE_LEGAL_BREACH,
    WORK_AUTH_EXPIRY_AT_RISK, WORK_AUTH_EXPIRED
      -> People Ops compliance Workbench, no notification
    PAYROLL_ERROR_DETECTED, PAYROLL_NOT_CONFIRMED, PAYROLL_RECORD_MISSING
      -> restricted People Ops/payroll Workbench only, never a manager route
    DAY_ONE_DEPENDENCY_BLOCKED
      -> standard Day-1 Workbench and the approved dependency owner route
    LEARNING_MILESTONE_OVERDUE
      -> standard manager-to-People-Ops route, notification allowed
    MANAGER_ACKNOWLEDGMENT_OVERDUE, MANAGER_ACTION_OVERDUE
      -> People Ops accountability escalation, never another nudge to the
         same manager
    COHORT_DEPENDENCY_BOTTLENECK
      -> cohort insight/audit only: no case, no notification, while preserving
         cohort, team, affected_count, denominator, percentage and safe
         evidence refs in the audit record
    any code failing validation
      -> one system exception case, target ops_triage, no notification
- Zero-fan-out applies only to reason codes whose mapping says cohort
  insight/audit. scope=cohort alone must not make every finding audit-only.
- Canonical identity keys, derived and never taken from the caller:
    compliance/work authorization  compliance:<employee_id>:<jurisdiction>
    payroll                        payroll:<employee_id>
    Day-1 readiness                dependency:<employee_id>
    learning                       learning:<employee_id>:<learning_domain>
    failed-validation code         exception:<employee_id>:invalid_code
- Resolve subject identity to a canonical employee_id. worker_wid alone is not a
  subject identity: resolve it first. Resolve <jurisdiction> once per run from
  Workers, selecting only Employee_ID and jurisdiction. Zero rows, multiple
  rows, or a blank jurisdiction is a structured exception for that group; never
  emit an identity ending in a bare colon. Use <learning_domain> from the
  upstream envelope when present, otherwise the literal general.
- GROUP findings by canonical identity key before returning. One identity key
  produces exactly one route object, carrying the sorted union of its reason
  codes and the sorted union of its evidence refs. Never return two objects with
  the same identity key.
- A group's priority is the highest priority among its codes.
- Standard and restricted branches never read internal_case_payload; only the
  confidential branch may, and only for employee_id, milestone and the secure
  case reference.
- Output a structured system_exceptions list alongside the route objects, plus a
  per-route notification decision and privacy class.

STEP 3 — Insert Workbench Cases
- Accept only grouped, sanitized route objects from Process. If two objects
  share a case_id, that is an upstream contract violation: raise a structured
  exception rather than posting both.
- Use the retry profile from Fetch. Remove every hardcoded attempt count and
  backoff array.
- Upsert with an explicit conflict target: on_conflict=case_id together with
  Prefer: resolution=merge-duplicates. Post sequentially per case_id so two
  writes can never race on one identity.
- Merge on an existing case: union the stored reason codes and evidence refs
  with the incoming ones, sort ascending, and write the result. Never let one
  write discard another's reasons or evidence.
- Reopen semantics: recurring risk on a resolved case sets status='open' AND
  resolved_at=null in the same write. A case must never be open with a stale
  resolved_at.
- Write the policy_version_id from Fetch into sanitized_context. Never write the
  caller's value. The table has no policy_version_id column.
- Apply a shape and prefix allowlist to everything entering sanitized_context.
  Caller-supplied evidence, domain and severity are not written verbatim.
- A write failure becomes a persisted, operable safe system exception, not only
  a partial_success summary field and not a raw response body.

STEP 4 — Render Outbound Message
- Read templates from the same active snapshot Fetch returned. Never read
  policy_config. When the snapshot carries no template for a route, use a
  deterministic built-in default and report template_source="builtin_default".
- Render for every route whose notification decision from Process is "send",
  including Round 2 routes. Do not depend on a legacy resolve_channel value; the
  route object carries its own target.
- Reference the canonical Round 2 identity key. The legacy Generate Case ID UUID
  may still appear in legacy audit correlation, but never as the case reference
  in a Round 2 message.
- Interpolate only allowlisted fields per route: employee_id, canonical case
  reference, reason codes, and counts. Never interpolate caller free text such
  as reasons[].detail or finding.detail.
- The confidential message contains only employee_id, milestone and the secure
  canonical case reference; its fallback link is the canonical secure reference,
  not a legacy audit UUID.
- Any date used in a message comes from the run's resolved as_of context, not
  date.today(), and an unresolved date is a structured exception, not the string
  "unknown".
- Build the Supabase URL exactly as the other steps do, so a full project URL in
  the environment behaves identically everywhere.
- Do not print the full rendered message to stdout or the UI; return it as
  structured output.

STEP 5 — Send to Slack
- Read demo_mode, max_attempts and backoff_seconds from Fetch. Remove every
  hardcoded value.
- Re-check the route and privacy decision immediately before the side effect. Do
  not send on the strength of an upstream target_channel alone. Compliance, work
  authorization, payroll and failed-validation routes send nothing.
- Compute a deterministic idempotency key from canonical case_id + sorted reason
  codes + policy_version_id, and skip a send whose key was already delivered, so
  a rerun never duplicates a notification.
- After retries are exhausted, persist a safe system exception and an operable
  workbench task. An in-memory object that dies with the run is not a result.
- Never print Slack error bodies or exception strings; return a sanitized
  outcome per attempt.

CANVAS — two structural changes, not code
1. Add a condition gate after Fetch Active Policy that only allows Process
   Findings and Routes and everything downstream to run when halt_pipeline is
   false. An invalid policy must stop the pipeline structurally; an early-return
   inside Process is not sufficient.
2. Connect the Round 2 route path to Render Outbound Message and Send to Slack.
   Today those two sit only on the legacy Round 1 branch, so an approved Round 2
   notification can never be delivered. Keep Generate Case ID for legacy audit
   correlation only; it must not supply Round 2 identity.
```

Verifikasi canvas secara visual sesudah builder selesai. Builder pernah
melaporkan langkah yang tidak ada di Timeline; klaim "gate ditambahkan" dan
"Round 2 tersambung ke Slack" harus terlihat di kanvas, bukan di ringkasan.

#### Verifikasi MVP

Dua test, tiga submit form. Semuanya dengan auto-fix **OFF**.

##### MVP-1 — composite route test (`testing20`, replay `testing21`)

Satu payload memicu lima route sekaligus dari satu employee, dengan tiga racun
yang membuat perilaku lama gagal secara terlihat, bukan sekadar "tidak
terbukti": `domain` yang salah pada finding payroll, `domain` yang diizinkan
pada unknown code, dan free-text sentinel pada finding learning.

**Pre-seed, sekali sebelum Run A.** Seed lewat SQL sah untuk test rewrite ini;
ia **bukan** bukti acceptance untuk `testing16`, yang tetap harus lewat
claim/resolve manusia di Workbench.

```sql
insert into workbench_cases
  (case_id, employee_id, case_type, priority, status, recommended_action,
   sanitized_context, resolved_at)
values
  ('dependency:EMP7032','EMP7032','dependency','high','resolved',
   'Review and resolve the Day-1 dependency blockers',
   '{"reason_codes":["DAY_ONE_DEPENDENCY_BLOCKED"],
     "evidence_refs":["dependency:DEP-10253"],
     "policy_version_id":"seed_not_a_real_version"}'::jsonb,
   now())
on conflict (case_id) do update
set status='resolved', resolved_at=now(),
    sanitized_context=excluded.sanitized_context;
```

**Run A.** `Policy Version ID` di form ini wajib diisi (bukan optional field),
jadi isi dengan id policy aktif saat ini — query dulu, jangan menebak atau
memakai id dari sesi lama:

```sql
select version_id, status, activated_at
from policy_versions where status = 'active';
```

Urutan `Findings` sengaja tidak terurut, dan `WORK_AUTH_EXPIRY_AT_RISK` sengaja
tidak ada di `Reasons`.

```text
Case Type: round_2_findings
Employee ID: EMP7032
Worker WID: kosong
Reasons (JSON array): ["COMPLIANCE_DEADLINE_AT_RISK","PAYROLL_NOT_CONFIRMED","LEARNING_MILESTONE_OVERDUE","DAY_ONE_DEPENDENCY_BLOCKED","XYZ_UNREGISTERED_CODE"]
Internal Case Payload (JSON): {}
Workbench Case Link: kosong
Execution ID: testing20
Command ID: testing20
Trigger Source: command_center
Cohort: kosong
Scope: employee
Policy Version ID: <ACTIVE_POLICY_VERSION_ID>
Findings (JSON array): [{"reason_code":"WORK_AUTH_EXPIRY_AT_RISK","domain":"payroll","severity":"low","evidence_refs":["worker:EMP7032"]},{"reason_code":"PAYROLL_NOT_CONFIRMED","domain":"learning","owner":"manager","evidence_refs":["payroll:PAY-40032"]},{"reason_code":"XYZ_UNREGISTERED_CODE","domain":"compliance","evidence_refs":["compliance-item:CMP-80999"]},{"reason_code":"LEARNING_MILESTONE_OVERDUE","detail":"SENTINEL_RAW_DETAIL_9271","evidence_refs":["LRN-30304"]},{"reason_code":"COMPLIANCE_DEADLINE_AT_RISK","evidence_refs":["compliance-item:CMP-80065"]},{"reason_code":"DAY_ONE_DEPENDENCY_BLOCKED","evidence_refs":["dependency:DEP-10256","dependency:DEP-10253","dependency:DEP-10255"]}]
```

**Run B.** Identik, termasuk `<ACTIVE_POLICY_VERSION_ID>` yang sama, hanya
`Execution ID` dan `Command ID` menjadi `testing21`. Ini murni replay untuk
membuktikan idempotensi (assertion #16) — dedup/grouping dan nol Slack kedua
lebih kritis untuk MVP daripada memaksa field kosong, jadi Run B tidak
dipakai untuk menguji itu.

Sesudah Run A harus ada tepat **lima** case untuk `EMP7032`:
`compliance:EMP7032:<JUR>`, `payroll:EMP7032`, `learning:EMP7032:general`,
`dependency:EMP7032` (reopened), dan `exception:EMP7032:invalid_code`.

| # | Assertion | Temuan §4.R2.3 yang dibuktikan |
|---|---|---|
| 1 | Envelope melaporkan `policy_version_id` = versi aktif nyata yang dikirim di form | Fetch #1, #7 (parsial — lihat catatan di bawah) |
| 2 | `retry_profile_name=Standard`, `max_attempts=3`, `registry_parity` dilaporkan, count hanya metadata | Insert #1, Slack #2 |
| 3 | `PAYROLL_NOT_CONFIRMED` mendarat di `payroll:EMP7032` **walaupun** `domain:"learning"`, `owner:"manager"` | Process #1 — inti blocker |
| 4 | `XYZ_UNREGISTERED_CODE` hanya menjadi `exception:EMP7032:invalid_code` **walaupun** `domain:"compliance"` | Process #2 |
| 5 | Satu case `compliance:EMP7032:<JUR>` memuat dua reason code dan dua evidence ref, bukan dua case | Process #3, Insert #3 |
| 6 | `WORK_AUTH_EXPIRY_AT_RISK` ikut walau tidak ada di `Reasons` | union findings/reasons |
| 7 | `<JUR>` terisi; tidak ada `case_id` yang berakhir titik dua | Process #6 |
| 8 | Priority compliance bukan `low`; case learning bukan payroll | Process #1, Insert #7 |
| 9 | `reason_codes` dan `evidence_refs` terurut naik — Day-1 harus `DEP-10253, 10255, 10256` | Insert #4 |
| 10 | `dependency:EMP7032` menjadi `status='open'` **dan** `resolved_at` null | Insert #5 |
| 11 | `sanitized_context->>'policy_version_id'` tidak lagi `seed_not_a_real_version` | Insert #6 |
| 12 | Timeline: Slack benar-benar dipanggil **satu kali**, untuk route learning | Render #2, canvas #2 |
| 13 | `SENTINEL_RAW_DETAIL_9271` nol kemunculan di message, payload Slack, case, dan Timeline | Render #4 |
| 14 | Message learning menyebut `learning:EMP7032:general`, bukan UUID | Render #3, canvas #3 |
| 15 | Nol panggilan Slack untuk compliance, payroll, dan exception | Process #1, Slack #3 |
| 16 | Run B: `case_id` dan jumlahnya identik, evidence tidak berlipat, **nol** Slack kedua | Insert #3, Slack #6 |

Catatan assertion #1: karena form mewajibkan `Policy Version ID`, Run A tidak
bisa membuktikan sendirian bahwa step benar-benar query `status=eq.active`
dan bukan sekadar menggemakan input — kalau kamu kebetulan mengisi id yang
benar, kedua perilaku menghasilkan output yang identik. Bagian yang tidak
tertutup di sini (Fetch #1: exact-active query; Fetch #7: output berasal dari
row database, bukan input) ditutup oleh `testing18` di bawah, yang mengirim id
yang **berbeda** dari versi aktif dan membuktikan step benar-benar membandingkan
keduanya, bukan mempercayainya begitu saja.

```sql
select case_id, case_type, priority, status, resolved_at,
       sanitized_context->'reason_codes'       as reason_codes,
       sanitized_context->'evidence_refs'      as evidence_refs,
       sanitized_context->>'policy_version_id' as policy_version_id
from workbench_cases where employee_id='EMP7032' order by case_id;

select count(*) as case_count from workbench_cases where employee_id='EMP7032';

-- leak check: kedua query harus nol baris
select case_id from workbench_cases
where sanitized_context::text ilike '%SENTINEL_RAW_DETAIL_9271%';

select case_id from workbench_cases
where employee_id='EMP7032'
  and (sanitized_context::text ilike '%gross%'
    or sanitized_context::text ilike '%net%'
    or sanitized_context::text ilike '%error_reason%');
```

##### MVP-2 — fail-closed gate (`testing18`)

Satu-satunya bukti bahwa gate canvas benar-benar ada. Tanpa test ini, policy
invalid tetap mencapai writer dan tidak ada yang menyadarinya.

```text
Case Type: round_2_findings
Employee ID: EMP7101
Worker WID: kosong
Reasons (JSON array): ["LEARNING_MILESTONE_OVERDUE"]
Internal Case Payload (JSON): {}
Workbench Case Link: kosong
Execution ID: testing18
Command ID: testing18
Trigger Source: command_center
Cohort: kosong
Scope: employee
Policy Version ID: policy_invalid_for_testing18
Findings (JSON array): [{"reason_code":"LEARNING_MILESTONE_OVERDUE","evidence_refs":["LRN-30304"]}]
```

Pass hanya jika ada tepat satu `POLICY_CONTEXT_INVALID` dengan
`halt_pipeline=true`, dan di raw Activity Timeline step Process, Insert, Render,
serta Slack benar-benar **skipped**. Step yang tetap berjalan lalu early-return
adalah FAIL: itu persis temuan canvas #1 dan Process #11. Catat mana yang
terlihat, jangan simpulkan dari status akhir run.

```sql
select count(*) as case_count from workbench_cases where employee_id='EMP7101';
-- harus sama dengan hitungan sebelum run
```

**Hasil — Passed sebagian, dengan satu temuan tetap terbuka.**

Yang terbukti, dan ini properti yang paling menentukan: workflow **tidak pernah
berlanjut** setelah Fetch Active Policy. Nol case ditulis, nol case berubah, nol
pesan Slack. Gate fail-closed nyata ada — temuan canvas #1 dan Process #11
tertutup.

Yang **tidak** sesuai spesifikasi: STEP 1 seharusnya mengembalikan
`POLICY_CONTEXT_INVALID` terstruktur dengan `halt_pipeline=true` dan run berakhir
di terminal state yang bersih. Yang terjadi, step keluar sebagai **error** dan
run parkir di **waiting review**. Jadi:

- **Temuan Fetch #6 tetap TERBUKA** — error masih di-raise sebagai raw exception,
  belum dinormalisasi menjadi safe structured `system_exception`. Jangan tandai
  selesai.
- Ini kelas defect yang sama dengan cacat OP-01 yang sudah tercatat di §9.4
  ("stale Date Parsing canvas edge ... leaving runs in `awaiting_human_input`
  instead of a clean terminal state"). Dua-duanya membuat run berakhir kotor
  walaupun keputusan bisnisnya benar.

**Keputusan: tidak diperbaiki sebelum demo.** Jalur ini hanya terpicu ketika
policy aktif memang invalid, yang tidak terjadi pada demo yang sehat, dan
memperbaikinya memakan satu eksekusi build ditambah retest. Risiko sisa yang
nyata: kalau kondisi ini terpicu saat rehearsal, akan muncul satu item
"waiting review" yang mengotori Workbench. Periksa dan bersihkan sebelum demo
kalau sempat terpicu.

##### MVP-3 — bukti Slack terkirim (`testing22`, replay `testing23`) — **Passed**

Ditambahkan setelah MVP-1 lulus. `testing20` membuktikan Slack terpanggil satu
kali, tetapi bercampur lima route sekaligus. Test ini mengisolasi satu route
supaya isi pesan, channel tujuan, dan perilaku replay bisa diperiksa bersih.
`LEARNING_MILESTONE_OVERDUE` dipakai karena hanya route inilah yang di §4.R2.4
ditandai "notification allowed".

Ini juga satu-satunya bukti untuk baris Integrations di §9: *"Konfirmasi Slack
benar-benar terkirim ke channel (bukan cuma tercatat di `Cases_Audit_Log`) untuk
minimal satu test."*

**Dua defect yang ditemukan lewat test ini, dan sudah diperbaiki:**

1. Process menetapkan `should_notify=false` untuk route learning, padahal
   §4.R2.4 mewajibkan `true`. Render ikut kosong, Slack melaporkan
   `No Slack-eligible routes identified for delivery`.
2. Setelah #1 diperbaiki, Slack tetap `SKIPPED` dengan alasan
   `RESTRICTED_PRIVACY_OR_INTERNAL_ROUTE`. Penyebabnya **gap di §4.R2.4 sendiri**,
   bukan bug builder: peta channel Slack hanya ada di tabel legacy
   `policy_config`, yang justru dilarang dibaca oleh prompt rewrite, sementara
   `policy_versions.config_snapshot` tidak menyimpan blok `routing` maupun
   `templates` (terbukti dari `template_source: "builtin_default"`). Process
   akhirnya mengarang `target_channel: "learning_workbench"` dari nama case-nya
   sendiri, dan guard Send to Slack benar menolaknya.

Perbaikannya memisahkan `case_target` (tujuan Workbench) dari `slack_channel_id`
(channel Slack), dan menaruh peta channel sebagai konstanta di dalam step
Process. Lihat "Hutang konfigurasi" di bawah.

**Payload Run A:**

```text
Case Type: round_2_findings
Employee ID: EMP7101
Worker WID: kosong
Reasons (JSON array): ["LEARNING_MILESTONE_OVERDUE"]
Internal Case Payload (JSON): {}
Workbench Case Link: kosong
Execution ID: testing22
Command ID: testing22
Trigger Source: command_center
Cohort: kosong
Scope: employee
Policy Version ID: <ACTIVE_POLICY_VERSION_ID>
Findings (JSON array): [{"reason_code":"LEARNING_MILESTONE_OVERDUE","detail":"SENTINEL_LEARNING_LEAK_4471","evidence_refs":["LRN-30304","LRN-30305","LRN-30306"]}]
```

**Run B:** identik, hanya `Execution ID`/`Command ID` menjadi `testing23`.

| # | Assertion | Hasil |
|---|---|---|
| 1 | Satu case `learning:EMP7101:general` — default `general` dipakai saat finding tidak membawa `learning_domain` | Passed |
| 2 | Step Send to Slack benar-benar dieksekusi dengan `delivery_count: 1`, dan pesannya terlihat di channel `C0BJ4PZ8961` | Passed |
| 3 | Pesan hanya berisi field allowlisted (`employee_id`, referensi case kanonik, reason code, tanggal); `template_source: "builtin_default"` | Passed |
| 4 | `SENTINEL_LEARNING_LEAK_4471` nol kemunculan di pesan, `sanitized_context`, dan Timeline | Passed |
| 5 | Run B: nol pengiriman kedua — idempotency key STEP 5 bekerja; case tetap satu | Passed |

```sql
select case_id, case_type, priority, status,
       sanitized_context->'reason_codes'  as reason_codes,
       sanitized_context->'evidence_refs' as evidence_refs
from workbench_cases where employee_id='EMP7101';
-- tepat satu baris, case_id = 'learning:EMP7101:general'

select case_id from workbench_cases
where sanitized_context::text ilike '%SENTINEL_LEARNING_LEAK_4471%';
-- nol baris
```

Yang **tidak** dibuktikan test ini: `Date:` di pesan diambil dari `as_of` policy
dan bukan `date.today()`. Nilainya kebetulan sama pada hari test dijalankan, jadi
keduanya tak terbedakan. Sisa dari temuan Render #6.

###### Hutang konfigurasi — peta channel sebagai konstanta

Peta channel Slack sekarang tertanam sebagai konstanta di step Process:

```text
manager_channel_by_org: Finance C0BJA0P1M6V, Sales C0BJBQ02U2Y, Ops C0BHSMV328P,
                        Engineering C0BJ4PYGV5K, People C0BJ4PZ8961
confidential_channel    C0BK2CRJ596
it_escalation_channel   C0BJ839B24A
```

Ini **melanggar prinsip "satu sumber konfigurasi per run"** yang menjadi dasar
seluruh rewrite §4.R2.4. Perbaikan sebenarnya adalah memindahkan blok `routing`
dan `templates` dari `config/policy_config.json` ke
`policy_versions.config_snapshot` lewat Policy Studio, supaya channel ikut
ter-governance dan ikut berubah ketika policy berubah.

Sengaja tidak dikerjakan sekarang: siklus draft → simulate → approve → activate
akan mengubah `policy_version_id` aktif di tengah workstream ORCH yang berjalan
paralel, dan membatalkan basis bukti `testing20`/`testing21` yang memakai
`policy_15a51b4e58cc4400a8a63ceb49b3cf92`. Kerjakan sesudah E2E, dan umumkan
dulu sesuai aturan koordinasi §9.3.

#### Sengaja tidak dicakup MVP

Dua test di atas tidak membuktikan semua 27 temuan. Yang tetap terbuka, dengan
alasannya:

- **Fetch #2** (fallback legacy `is_active`), **#3** (parity registry exact),
  **#4** (boolean lolos sebagai integer) — butuh policy row yang sengaja cacat.
  Menonaktifkannya menuntut aktivasi policy uji, dan itu mengganggu workstream
  ORCH yang berjalan paralel.
- **Fetch #5/#6, Insert #8, Render #8, Slack #4/#5** (normalisasi failure menjadi
  exception aman) — butuh kegagalan yang disengaja pada credential atau endpoint.
- **Process #4** (scope invalid) dan **#5** (cohort zero-fan-out) — jalur cohort
  hanya aktif lewat Daily Cohort Sweep (S.1), yang belum dibangun.
- **4.R2.2 / `testing19`** (independensi confidential dan standard) — vektor
  kebocoran renderer sudah tertutup assertion #13, tetapi partisi
  confidential/standard belum pernah dijalankan end-to-end. Tetap wajib sebelum
  acceptance privacy final.
- **Slack #7** (credential/integration yang disetujui untuk environment) — review
  konfigurasi, bukan run.

Jangan menandai temuan-temuan itu selesai karena MVP hijau. Kalau ada waktu
tersisa sesudah E2E, urutan termurah untuk menutupnya adalah `testing12`
(cohort), `testing19` (confidential), lalu satu policy cacat untuk Fetch #2–#4.

#### Kalau builder mandek

Jangan repaste seluruh prompt; §1.1 mencatat itu justru memperburuk. Paste ulang
**satu blok STEP** saja, mengikuti urutan repair §4.R2.3: Fetch → gate canvas →
Process → Insert → Render/Slack. Keenam blok di atas ditulis supaya bisa berdiri
sendiri.

## 7. ORCH-01 — Round 2 orchestration

Continue the existing Orchestrator. It coordinates Operators and performs no
direct source-system or Slack reads/writes.

### O.1 — Parallel fan-out and deterministic merge

**Prompt:**

```text
Goal: extend the existing HR Orchestrator with parallel Round 2 evaluation while
keeping external I/O inside specialized Operators.

Continue the existing ORCH-01. Do not create a new Orchestrator.

INPUT CONTRACT — the Command Center sends exactly these five keys as a JSON
object and nothing else:
  scope, employee_id, cohort, reason_code, command_id
There is no execution_id input key: derive execution_id from command_id, and
when command_id is absent (scheduled or Typeform-parented runs) use the stable
Auto run ID instead. There is no trigger_source input key either: treat the run
as "command_center" when command_id is present and "scheduled" otherwise.
ORCH-01 does not read the active policy and does not need Supabase credentials
in this stage: every Operator resolves config_snapshot itself, which is what
makes each one's policy_version_id independent evidence. Forward an as_of only
when a parent workflow supplied one, as the Daily Cohort Sweep does to share a
single instant across its children; otherwise leave it absent and let the
Operators resolve it. Never synthesize an as_of date.
reason_code may be null; it is a filter hint, never a finding.
Pass the derived execution_id down to every child Operator, because OP-02,
OP-03, OP-05, OP-06, and OP-07 take employee_id and execution_id as their own
inputs.

For scope=employee:
1. Validate that contract: reject the run only when scope is missing, when
   scope="employee" without employee_id, or when scope="cohort" without cohort.
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

Field yang sama: `scope=employee`. Kolom di tabel bawah adalah **`command_id`,
dan itu memang field input** yang diisi manual — nilai `cmd_...` di kolom itu
diketik apa adanya ke field `command_id`. `execution_id` **bukan** field input
dan tidak pernah bisa diketik: ORCH-01 menurunkannya dari `command_id`, dan
`trigger_source` dideteksi sendiri. Karena penurunannya deterministik,
`command_id` yang sama selalu menghasilkan `execution_id` yang sama — itulah
yang membuat baris replay/idempotensi di bawah tetap bisa dijalankan dari test
form. `as_of_date` diambil dari `config_snapshot` policy aktif; kalau sebuah
baris menuntut `as_of` tertentu, pin lewat Policy Studio, bukan lewat input run.
Jalankan dari Command Center supaya `command_id` benar-benar berasal dari
`app/services/hr.py`; test form Auto langsung hanya sah untuk baris yang memang
menguji jalur non-Command-Center.

**Run tanpa `command_id`.** Untuk run terjadwal atau yang diparenti Typeform,
tidak ada `command_id` sama sekali dan `execution_id` benar-benar dibangkitkan
saat run: ORCH-01 membentuknya sebagai `cmd_auto_` + 24 karakter hex pertama
dari `sha256(auto_run_id)`. Nilai itu tidak bisa diketik di mana pun — **baca
dari output step 1 (atau dari Activity Timeline) setelah run selesai**, lalu
pakai nilai itu sebagai `<cmd>` di SQL verifikasi. Ini hanya berlaku untuk run
tanpa `command_id`; semua baris tabel di bawah memakai `command_id` yang
diketik.

**Pre-flight — jalankan sebelum baris mana pun.** Setiap angka yang diharapkan
di bawah mengasumsikan policy baseline yang aktif, bukan turunan draft test.
Konfirmasi dulu, jangan ditebak:

```sql
select "version_id", "status", "activated_at",
       "config_snapshot"->'thresholds'->'compliance_at_risk_days' as compliance_days,
       "config_snapshot"->>'as_of_date' as as_of
from "policy_versions" where "status" = 'active';
```

Kalau `version_id` yang muncul bukan baseline, kembalikan lewat Policy Studio
(draft → simulate → approve → activate; versi `retired` tidak bisa diaktifkan
langsung) sebelum melanjutkan. Catat `version_id` ini — semua baris di bawah
membandingkan terhadapnya.

**Kalau dijalankan dari test form Auto, bukan Command Center.** Selama `G-04`
belum selesai, jalur Command Center belum tersedia dan baris-baris ini boleh
dijalankan dari test form. Konsekuensinya harus dicatat, bukan diabaikan: tanpa
baris `command_runs`, `persist_workflow_event` menolak dengan
`Command run not found`, jadi **tidak akan ada baris lifecycle di
`workflow_events` sama sekali** — query verifikasi ketiga di bawah akan kosong,
dan itu bukan kegagalan O.1. Begitu RPC `record_finding_event` sudah di-apply,
run test form juga akan gagal menulis finding, karena `cmd_` + 32 hex yang tidak
punya baris `command_runs` bukan bentuk yang sah.

Untuk membuat run test form berperilaku seperti run Command Center, tanam dulu
baris `command_runs`-nya. Ganti `<cmd>` dan `<employee>`:

```sql
insert into "command_runs"
  ("command_id", "created_by", "status", "scope", "employee_id",
   "workflow_key", "trigger_source", "reconciliation_status")
values
  ('<cmd>', 'auto_test_form', 'running', 'employee', '<employee>',
   'hr_orchestrator', 'auto', 'pending')
on conflict ("command_id") do nothing;
```

Catat di kolom bukti baris mana yang dijalankan dengan cara ini. Bukti fan-out,
merge, routing, dan idempotensi tetap sah; bukti korelasi command/event tidak,
dan itu memang milik O.2.

Catat juga garis dasar jumlah baris supaya test idempotensi punya pembanding:

```sql
select count(*) as evaluations from "policy_evaluations" where "employee_id" = 'EMP7032';
select count(*) as cases from "workbench_cases" where "employee_id" = 'EMP7032';
```

| # | Scenario | employee_id | command_id (input; `execution_id` diturunkan darinya) | Expected output | Fixture |
|---|---|---|---|---|---|
| 1 | Multi-domain, dua Operator sekaligus | `EMP7032` | `cmd_685e727f698af6056739c1cb0d3493f2` | Hasil OP-05 (`COMPLIANCE_DEADLINE_AT_RISK`) **dan** OP-06 (tergantung status payroll `EMP7032` saat ini) sama-sama selamat di merge; masing-masing route ke case terpisah (compliance vs payroll), tidak tercampur. Di Activity Timeline, stempel waktu OP-05/OP-06/OP-07 harus **tumpang tindih**, bukan berurutan — itu bukti fan-out paralel yang diminta §9, dan tidak bisa digantikan klaim selesai | Tidak ada |
| 2 | Satu branch gagal, yang lain tetap jalan | `EMP7032` | `cmd_cc2392e2c28db7cb5245cefe620c97be` | Temuan OP-05 tetap ada dan ter-route normal; branch OP-06 yang gagal muncul sebagai satu `system_exception` terpisah, **tidak** menghapus temuan OP-05 | Sebelum run: `revoke select on "Payroll_Records" from service_role;`<br>Sesudah run, **wajib**: `grant select on "Payroll_Records" to service_role;`<br>Verifikasi kembali pulih: `select count(*) from "Payroll_Records";` |
| 3 | Duplicate finding delivery (retry execution_id sama) | `EMP7032` | `cmd_685e727f698af6056739c1cb0d3493f2` (**sama persis** dengan #1) | Satu finding gabungan, satu case idempotent — tidak ada duplikat di `workbench_cases`/`policy_evaluations` | Jalankan langsung setelah #1, tanpa mengubah data apa pun. Ketik `command_id` yang identik dengan #1 supaya ORCH-01 menurunkan `execution_id` yang sama. Bandingkan sesudahnya: `select count(*) from "policy_evaluations" where "execution_id" = 'cmd_685e727f698af6056739c1cb0d3493f2';` dan `select count(*) from "workbench_cases" where "employee_id" = 'EMP7032';` — keduanya harus sama dengan angka sesudah #1 |
| 4 | Reason code tidak dikenal dari salah satu branch | `EMP7008` | `cmd_75a27d34818030aef4d5ac5b329959e5` | Tidak ada case/Slack apa pun untuk kode ini — hanya satu `system_exception`; branch lain untuk `EMP7008` (kalau ada) tetap jalan normal | **Tidak bisa dijalankan lewat Command Center**: `app/routers/hr.py:621` menolak `reason_code` di luar `KNOWN_REASON_CODES` dengan HTTP 422 sebelum Auto dipanggil sama sekali. Jalankan dari test form Auto langsung dengan `reason_code="XYZ_UNREGISTERED_CODE"`. Perlu diketahui: cara ini menguji guard ORCH atas *input hint*, bukan atas kode yang dipancarkan sebuah branch. Untuk menguji jalur branch yang sebenarnya, satu Operator harus diprompt sementara agar memancarkan kode itu, lalu dikembalikan — dua eksekusi builder. Catat mana yang dipakai |
| 5 | Confidential + standard bersamaan | `EMP7003` | `cmd_10fbb44d3d8a71e412e869c3cc3e2ab0` | Dua route independen jalan (confidential + Day-1 standar); tidak ada data sensitif nyeberang ke branch standar. String `SENTINEL_SECRET_HEALTH_XYZ` tidak muncul di case standar, `workflow_events`, Activity Timeline, log, maupun di teks alert confidential itu sendiri | Sebelum run:<br>`update "Peakon_Engagement" set "Comment" = 'Managing, though I have been dealing with SENTINEL_SECRET_HEALTH_XYZ and have not felt able to raise it with my manager yet.' where "Response_ID" = 'PK-5006';`<br>`update "Cross_Team_Dependencies" set "status" = 'In Progress' where "dep_id" = 'DEP-10015';`<br>Sesudah run, **wajib**:<br>`update "Peakon_Engagement" set "Comment" = 'Managing, though I have been dealing with a health matter and have not felt able to raise it with my manager yet.' where "Response_ID" = 'PK-5006';`<br>`update "Cross_Team_Dependencies" set "status" = 'Done' where "dep_id" = 'DEP-10015';` |

**Verifikasi tiap baris.** Ganti `<cmd>` dengan `command_id` baris yang
bersangkutan; `execution_id` yang tersimpan adalah turunannya. Khusus run tanpa
`command_id` (terjadwal/Typeform), baca dulu `execution_id` bentuk `cmd_auto_...`
dari output step 1 atau Activity Timeline dan pakai nilai itu. Jalankan
keempatnya, bukan hanya yang pertama — bukti yang diminta tracker adalah baris
database, bukan output step.

```sql
select "policy_key", "outcome", "action", "policy_version_id", "evaluated_at"
from "policy_evaluations" where "execution_id" = '<cmd>' order by "evaluated_at";

select "operator_id", "event_type", "status", "reason_codes", "details", "occurred_at"
from "workflow_events" where "execution_id" = '<cmd>' order by "sequence_no";

select "command_id", "status", "auto_run_id", "reconciliation_status", "error_code"
from "command_runs" where "command_id" = '<cmd>';

select "case_id", "case_type", "priority", "status", "created_at"
from "workbench_cases" where "employee_id" = 'EMP7032' order by "created_at" desc limit 10;
```

**Cek kebocoran privasi setelah #5** — harus mengembalikan nol baris:

```sql
select "event_id", "execution_id" from "workflow_events"
where "details"::text like '%SENTINEL_SECRET_HEALTH_XYZ%'
   or "reason_codes"::text like '%SENTINEL_SECRET_HEALTH_XYZ%';

select "case_id" from "workbench_cases"
where "sanitized_context"::text like '%SENTINEL_SECRET_HEALTH_XYZ%';
```

**Bersih-bersih setelah kelima baris selesai.** Semua wajib, tidak opsional:

```sql
grant select on "Payroll_Records" to service_role;

update "Peakon_Engagement" set "Comment" = 'Managing, though I have been dealing with a health matter and have not felt able to raise it with my manager yet.' where "Response_ID" = 'PK-5006';

update "Cross_Team_Dependencies" set "status" = 'Done' where "dep_id" = 'DEP-10015';

select "Response_ID", "Comment" from "Peakon_Engagement" where "Response_ID" = 'PK-5006';
select "dep_id", "status" from "Cross_Team_Dependencies" where "dep_id" = 'DEP-10015';
```

`PK-5006` dipakai juga oleh §5 OP-03 test #4/#5 dan §6 4.R2.2, jadi komentar yang
tidak dikembalikan akan mencemari ketiganya.

### O.2 — Command event correlation

**Pembagian kepemilikan event — baca sebelum menjalankan prompt.** Command Center
sudah menulis seluruh siklus hidup sendiri: `AutoWorkflowClient.execute_stream`
(`app/services/auto.py`) membaca SSE Auto dan memanggil `persist_workflow_event`
untuk tiap event `queued`/`running`/terminal. Kalau ORCH-01 ikut memancarkan
event lifecycle, ada dua penulis pada satu state machine — `event_id`-nya
berbeda sehingga `on conflict do nothing` tidak menolong, jumlah baris
`workflow_events` berlipat (persis metrik test #2), dan terminal yang ditulis
ORCH lebih dulu mengunci `command_runs` sehingga semua persist klien berikutnya
mengembalikan `false`. Jadi: **lifecycle milik Command Center, finding milik
ORCH-01.**

`persist_workflow_event` tidak bisa dipakai untuk finding — ia menanam
`operator_id` sebagai literal `'orchestrator'`, tidak punya parameter
`reason_codes`, dan ikut memutasi `command_runs.status`. Untuk itu ada RPC
terpisah `record_finding_event` yang hanya menulis ke `workflow_events`.

**Prompt:**

```text
Goal: make ORCH-01 observable by the Command Center without exposing raw data.

Continue ORCH-01.

- Preserve command_id from Command Center input as execution_id.

- For scheduled or Typeform-parented runs there is no command_id. Derive the
  execution_id instead as the literal string "cmd_auto_" followed by the first
  24 lowercase hex characters of sha256(auto_run_id), where auto_run_id is the
  stable Auto run UUID. That is exactly the id the FastAPI reconciler
  synthesizes when it adopts an orphan Auto run, so findings written under it
  correlate the moment the command_runs row appears. Do not use the bare Auto
  run UUID: the reconciler stores that in auto_run_id, not command_id, and every
  run view queries on execution_id, so those findings stay invisible.

- Do NOT emit queued, running, or terminal lifecycle events, and do not call
  persist_workflow_event. The Command Center already derives those from the Auto
  SSE stream and owns the command_runs state machine. A second writer duplicates
  the ledger and can lock the run terminal early.

- Emit one finding event per Operator finding by calling the RPC
  record_finding_event over Supabase REST. Its arguments are matched by name, so
  send exactly these keys and no others:
    target_command_id     the execution_id derived above: the Command Center
                          command_id, or the cmd_auto_ form for scheduled and
                          Typeform-parented runs. Lowercase. Any other value is
                          rejected, because a finding written against an unknown
                          execution id is invisible to every run view. Never
                          send null, and never send the bare Auto run UUID.
    new_event_id          sha256 of execution_id|operator|reason_code|employee_id
    new_source_event_id   the same sha256 input, so a replay of the same finding
                          recomputes both identifiers unchanged
    operator              "OP-01".."OP-07", or "orchestrator"
    subject_employee_id   employee this finding is about, or null
    subject_cohort        cohort for cohort-scope runs, or null
    safe_reason_codes     JSON array of registered reason codes
    safe_details          exactly {"source": "auto_workflow"}
  Both identifiers must include execution_id in their input. Deriving them from
  the finding alone makes two different runs collide on one event_id, and the
  second run's finding is then rejected as a replay and lost.
  Pass an employee or a cohort, never both. Both must already exist in Workers;
  the RPC rejects an unknown subject rather than storing it.

  The RPC returns true when a row was inserted and false when it was suppressed
  — because the run is already terminal, because cancellation was requested,
  because that finding was already recorded, or because no registered reason
  code survived filtering. A false return is a normal outcome, not an error:
  never retry it and never raise on it. An actual error response means malformed
  input (unknown operator, missing identifier, unknown subject); surface that as
  a system exception, because retrying it will fail identically.

- Never put REST responses, finding prose, or any payroll field into
  safe_details. The RPC drops every key except "source" and "error_type", so
  anything else is silently lost rather than delivered.

- An unregistered reason code must never be sent to record_finding_event. Route
  it as a system exception instead, exactly as O.1 step 6 requires.

- A cancellation request prevents new downstream actions: once it is set, stop
  starting new branches and stop routing findings to OP-04.
```

**Tests:**

Sama seperti O.1: kolom di bawah adalah **`command_id`, field input yang
diketik**; `execution_id` bukan field input dan diturunkan ORCH-01 dari
`command_id`, jadi `command_id` yang sama menghasilkan `execution_id` yang sama.
Baris #5 tidak punya `command_id` sama sekali — di situ `execution_id` berbentuk
`cmd_auto_` + 24 hex pertama `sha256(auto_run_id)` dan **harus dibaca dari output
step 1 atau Activity Timeline** sebelum bisa dipakai di SQL verifikasi.

| # | Scenario | employee_id | command_id (input; `execution_id` diturunkan darinya) | Expected output | Tindakan tambahan |
|---|---|---|---|---|---|
| 1 | Korelasi Command Center run | `EMP7032` | `cmd_16fc077348809fd328f874daf71be609` | Query `command_runs` dan `workflow_events` untuk `command_id`/`execution_id` ini: nilainya **identik**; urutan event `queued -> running -> completed` konsisten dengan Activity Timeline Auto. Tambahan setelah pembagian kepemilikan event: setiap baris `event_type='finding'` harus punya `operator_id` yang benar-benar `OP-0x` (bukan `orchestrator`) dan `details` persis `{"source":"auto_workflow"}`; sebaliknya **tidak boleh** ada baris lifecycle dengan `operator_id` selain `orchestrator`, karena itu berarti ORCH ikut menulis lifecycle | Jalankan lewat Command Center (bukan test form Auto langsung) supaya `command_id` benar-benar berasal dari `app/services/hr.py` |
| 2 | Replay source_event_id sama | `EMP7032` | `cmd_16fc077348809fd328f874daf71be609` (**sama persis** dengan #1) | `select count(*) from "workflow_events" where execution_id=...;` jumlahnya **tidak bertambah** dibanding setelah #1 — replay tidak menambah event baru. Dua mekanisme berbeda yang menahannya, dan keduanya harus dibuktikan: run yang sudah terminal membuat `execute_stream` gagal klaim sehingga tidak ada event lifecycle baru, dan `record_finding_event` menolak `new_source_event_id` yang sudah pernah tercatat sehingga tidak ada finding baru. Kalau jumlahnya bertambah, cek dulu `event_type` baris tambahannya untuk tahu mekanisme mana yang bocor | Jalankan ulang langsung setelah #1 dengan input identik. Dari Command Center: pakai idempotency key yang sama supaya `create_run` mengembalikan `command_id` yang sama. Dari test form Auto: ketik `command_id` yang sama persis dengan #1 — `execution_id` diturunkan darinya, jadi replay-nya tetap sah |
| 3 | Reconnect SSE di tengah run | `EMP7062` (payroll, biar durasinya cukup lama untuk sempat disconnect) | `cmd_f0bbcaa278c91ecbdf908f654291825f` | Setelah reconnect ke stream SSE Command Center, event yang diterima lanjut dari nomor urut terakhir yang sudah diterima sebelum disconnect — tidak mengulang dari awal, tidak ada gap | Manual: buka halaman yang subscribe SSE, matikan koneksi jaringan sebentar di tengah run, nyalakan lagi |
| 4 | Terminal state sekali walau sempat retry | `EMP7062` | `cmd_1ba458fa9c0d32d490bd2314b138d303` | Tepat satu event terminal (`completed`/`failed`/`cancelled`) di `workflow_events` untuk `execution_id` ini, walau salah satu Operator sempat retry beberapa kali sebelum akhirnya berhasil/gagal | Sebelum run, buat salah satu branch (mis. OP-06) gagal sekali lalu berhasil di percobaan retry berikutnya — gunakan teknik toggle env var yang sama seperti §5.3 test #3 |
| 5 | Run terjadwal tanpa command_id | — (`trigger_source=daily_schedule`) | Tidak diketik. `execution_id` dibangkitkan saat run sebagai `cmd_auto_` + 24 hex pertama `sha256(auto_run_id)`; baca nilainya dari output step 1 atau Activity Timeline setelah run, lalu pakai itu di SQL verifikasi | `command_runs`/`workflow_events` tetap punya baris yang bisa dikorelasikan lewat Auto run ID; endpoint `POST /runs/reconcile` di Command Center bisa menemukan run ini | Trigger manual test run dari Daily Cohort Sweep (§8), bukan dari Command Center |
| 6 | Cancellation mencegah aksi lanjutan | `EMP7062` | `cmd_ab53176b83db40ac5da36561c1bcbe52` | Setelah `cancel_requested_at` di-set, tidak ada case/notification baru yang tertulis untuk branch yang belum sempat jalan; event terminal `cancelled` tertulis sekali. Tidak ada baris `event_type='finding'` dengan `occurred_at` setelah `cancel_requested_at` — `record_finding_event` mengembalikan `false` begitu kolom itu terisi, jadi finding yang telat tidak masuk ledger meski branch-nya sudah terlanjur menghitung | Mulai run, lalu segera panggil `POST /runs/{command_id}/cancel` sebelum branch OP-06/OP-07 sempat selesai |

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
| Integrations | Supabase REST + Slack native + Typeform native polling, ketiganya live | §5 OP-01 test (Typeform submission nyata); **§4.R2.4 MVP-3 `testing22` — Passed**: Slack benar-benar terkirim ke channel `C0BJ4PZ8961`, terlihat di channel dan di raw Timeline, bukan hanya tercatat di `Cases_Audit_Log`; semua test Supabase REST di seluruh guide | **Terpenuhi.** Replay `testing23` juga membuktikan nol pengiriman ganda |
| Privacy | Sentinel confidential dan payroll tidak muncul di dashboard/queue standar/event/log/response/pesan | §6.1 test #3 (`PAYROLL_SECRET_XYZ`); §5 OP-03 test #4 (`SENTINEL_HEALTH_XYZ`); §6 4.R2.2 test (`SENTINEL_SECRET_HEALTH_XYZ`) | Tidak ada, tiga ini sudah cukup mewakili payroll + confidential |
| Idempotency | Retry `execution_id`/source event yang sama tidak menduplikasi evaluasi/case/state/notifikasi | §5.2 test #7 (duplicate delivery OP-05); §6.2 test #4; §7.3 test #2 (duplicate delivery manager event, `successful_reminder_count` tetap 1); ORCH-01 O.1 test #3, O.2 test #2 | Tidak ada, sudah cukup lintas 4 layer berbeda (policy_evaluations, workbench_cases, manager_action_states, workflow_events) |
| Degraded mode | Satu kegagalan Operator/integrasi jadi system_exception yang kelihatan, branch lain tetap jalan | ORCH-01 O.1 test #2; §5.3 test #1–#3; §6.3 test #8 | Tidak ada |
| Generality | Logika rule-based, dipakai di banyak employee/cohort; tidak ada perilaku yang di-hardcode ke satu fixture ID | Seluruh guide sudah memakai >20 `employee_id` berbeda (`EMP7000`–`EMP7147`) lintas §5–§8 plus `COH-2026-W22` | Tidak ada — kalau reviewer minta bukti tambahan, tunjuk baris-baris test di §2–§8 sebagai daftar |

## 9.1 Live verification update — 2026-08-07

This section originally also carried live-run evidence for the gates, OP-05,
OP-06, OP-07, OP-04 (2026-08-07 snapshot, since superseded by the §4.R2.3 code
review and §4.R2.4 rewrite), and OP-01/OP-02/OP-03. That evidence is
frozen-operator/historical and has moved to
`docs/AUTO_BUILD_GUIDE_ARCHIVE_2026-08-08.md` §9.1. The still-open checklist
below is current.

### Posisi terakhir — 2026-08-08, sesudah OP-04 MVP tuntas

Workstream user **selesai**. OP-04 lulus MVP 3/3 (§4.R2.4), OP-05 dan OP-06
sudah frozen setelah masing-masing lulus current-policy smoke. Semua Operator
kini frozen kecuali satu cacat OP-01 yang jadi tanggung jawab teammate.

Empat langkah tersisa menuju demo, berurutan:

1. **ORCH-01** — teammate. O.1 sudah Passed (essential); O.2 belum mulai dan
   butuh RPC `record_finding_event` di-apply ke Supabase lebih dulu.
2. **G-04** — mapping workflow UUID server-side. Bukti definitifnya satu run
   Command Center yang berhasil; masih tertahan blocker eksternal di §9.4.
3. **S.1 Daily Cohort Sweep** — belum dibangun, bergantung pada ORCH-01.
4. **E2E rehearsal** — Policy Studio → Command Center → ORCH → Operators →
   OP-04 → Workbench/Slack → human claim/resolve → Dashboard.

Dua hutang OP-04 yang sengaja dibawa ke demo, keduanya terdokumentasi di
§4.R2.4: peta channel Slack sebagai konstanta di step Process, dan temuan
Fetch #6 (raw error, bukan structured exception) yang membuat run policy-invalid
parkir di `waiting review`.

### Current critical path for the next session

1. Rewrite OP-04's five steps and add the two canvas fixes, using the single
   prompt in §4.R2.4. This supersedes the earlier "finish OP-04 routing test by
   test" plan: §4.R2.3 found that the routes which passed did so through
   `finding.domain` supplied by the caller, so per-route tests against the
   current build prove nothing about the contract.
2. Verify with the two MVP tests in §4.R2.4 — composite `testing20`/`testing21`
   and fail-closed `testing18` — and record which §4.R2.3 findings each
   assertion actually closes. The rest of §4.R2.1's matrix waits until after the
   demo; the deliberately uncovered items are listed in §4.R2.4.
3. Run one current-policy smoke regression each for OP-05 and OP-06, then freeze
   both detector contracts.
4. Teammate: fix OP-01's stale Date Parsing success/escalation canvas edge so a
   successful submission can reach a clean terminal state before E2E.
5. Build/test ORCH-01 parallel fan-out, deterministic merge, branch-failure
   isolation, confidential separation, dedup, and OP-04 handoff.
6. Complete G-04 server-side workflow UUID mapping and Command Center event
   correlation (`command_id == execution_id`, queued/running/terminal).
7. Build/test the Daily Cohort Sweep.
8. Run the live acceptance rehearsal:
   Policy Studio -> Command Center -> ORCH -> Operators -> OP-04 ->
   Workbench/Slack -> human claim/resolve -> Dashboard/audit evidence.

Low-priority/defer-until-after-core items:

- OP-07 result-page pagination fix and its blocked test;
- exhaustive OP-05 threshold/work-auth matrix beyond the current core evidence;
- closing the legacy payroll case, unless needed for a clean demo Workbench;
- top-level duplicate `cohort` field polish in OP-07.

## 9.2 OP-01 step-level rebuild — 2026-08-08

The full step-level rebuild record (per-step verification, the five essential
migration test runs with their Auto run UUIDs, and the "optional, non-blocking
debt" list of cosmetic OP-01 field-shape issues) is frozen-operator history and
has moved to `docs/AUTO_BUILD_GUIDE_ARCHIVE_2026-08-08.md` §9.2.

The one still-relevant fact — a stale branch condition after Date Parsing fires
the escalation edge even on a successful parse, so every OP-01 run also raises a
spurious human-review item and ends in `awaiting_human_input` instead of
`completed`, even though the underlying business decisions and persisted rows
are correct — is carried forward in the Frozen Operators section above and in
the deferred register (§9.4) below. Resolve it before the §9 acceptance
rehearsal, where a clean terminal state matters.

## 9.3 Day-H handoff — 2026-08-08

This is the operative checkpoint for the on-site build day. It supersedes older
"not tested" labels elsewhere in the document when those labels conflict with
the evidence below.

The frozen/accepted-operator summary, the OP-01 teammate handoff note, and the
OP-04 "already verified" / "still required" handoff notes that were originally
here are now superseded or duplicated: the frozen-operator status lives in the
Frozen Operators section above, and the OP-04 status is superseded by the
§4.R2.3 code review (which found the previously-passing routes proved nothing
about the contract) and current in the §4.R2.4 MVP verification. Full original
text: `docs/AUTO_BUILD_GUIDE_ARCHIVE_2026-08-08.md` §9.3.

### Active policy at handoff

Direct SQL / Policy Studio evidence:

```text
version_id = policy_15a51b4e58cc4400a8a63ceb49b3cf92
demo_mode = false
manager_max_reminders = {"default":2}
bottleneck_min_workers = 2
bottleneck_min_percent = 25
reason_code_count = 18
```

`policy_15a51b4e58cc4400a8a63ceb49b3cf92` is derived from
`policy_round2_v1`. Re-query before every OP-04/ORCH test because teammates may
activate a temporary policy for a proving run.

### Coordination rule for parallel work

Parallel work is allowed as long as teammates do not:
- edit the same Auto workflow simultaneously;
- activate temporary policies without announcing it;
- assume an older policy ID is still active.

Every test block starts by re-querying the active policy, and raw Activity
Timeline + direct Supabase rows remain the source of truth.

## 9.4 Deferred register — raise only after the E2E rehearsal

Everything below is known, deliberately deferred, and **not** to be raised again
until the §9 acceptance rehearsal has been completed. None of it blocks the MVP.
Work the list only after E2E, in roughly this order.

### Correctness, fix before a public demo

- ORCH-01 stage 1's step description in Auto Studio still reads "mocks config
  snapshot". The code no longer does; only the description text is stale. It is
  visible in the Activity Timeline and reads like the system is running on fake
  data. One sentence in a builder prompt, bundled with any other stage-1 change.
- OP-01 Date Parsing raises a spurious escalation on a successful parse, so every
  OP-01 run leaves one false human-review item in the Workbench. The rewrite
  prompt exists and is unrun. OP-01 is Typeform-parented and is not part of the
  ORCH fan-out, so it does not pollute an ORCH demo — but it does pollute the
  Workbench view.
- OP-01 Date Parsing resolves an ambiguous `10/08/2026` to 8 October instead of
  escalating. Covered by the same unrun prompt.
- Leftover OP-01 test worker `d20baf3d-abf2-4e8f-90be-8848437a5817`. Delete by
  `Worker_WID`, never by a `Legal_Name like 'Farah%'` pattern — `EMP7040`,
  `EMP7078` and `EMP7106` are real dataset workers.

### Contract debt

- The five Operators do not share one envelope. OP-02 omits `operator_id`,
  `employee_id` and `findings` entirely; OP-05 emits `findings` entries shaped
  `{item, status, due_date}` with no `reason_code`, so its routable codes live
  only in `reasons`; OP-06 returns `{action_taken, status, message}` with no
  envelope keys at all. ORCH-01's merge stage normalizes all three at the
  boundary and records the dialect in `extraction_debug`. Conforming the
  Operators is the real fix; the normalization is a documented stopgap, not a
  disguise.
- OP-06 returns no `policy_version_id` and no `evaluated_at`, so that branch
  cannot prove it read the active policy. Normalization lets it pass; it does not
  cure it.
- ORCH-01 no longer routes `system_exceptions` to OP-04, so an exception produces
  no Workbench case — it appears only in the final output. This was a deliberate
  trade: routing them was sending Slack notifications for branch failures, and a
  noisy demo channel costs more than a missing exception case. Restoring them
  requires changing OP-04's input contract too. Degraded-mode acceptance evidence
  is already satisfied by §5.3, which passed 3/3.
- `persist_workflow_event` carries the same defect that was removed from
  `record_finding_event`: `on conflict ("event_id") do nothing` followed by an
  unconditional `return true`, so a replayed lifecycle event reports success while
  dropping the row and still advancing `command_runs.status`. Its caller ignores
  the return value, so the live impact today is nil. Fix for symmetry once the
  lifecycle path is no longer under test.

### External blockers, not our work

- Auto's REST read surface returns `{"message":"Unexpected Server Error"}` with
  HTTP 400 on `GET /api/v1/workflows` and `GET /api/v1/workflow-runs`, identically
  for a valid and a deliberately-invalid key, with the documented parameters. The
  request contract in `app/services/auto.py` matches the published API docs, so
  this is upstream. Consequence: `AutoWorkflowClient.list_runs` and therefore
  `AutoRunReconciler` cannot function, which blocks ORCH-01 O.2 test #5 and the
  Daily Cohort Sweep discovery path. Re-probe before assuming it is still broken.

### Not run, with the reason each is safe to skip

- O.1 test #2 (branch failure) — degraded-mode acceptance is covered by §5.3
  tests #1–#3, already `Passed 3/3`.
- O.1 test #3 (replay idempotency) — covered across four other layers: §5.2 #7,
  §6.2 #4, §7.3 #2.
- O.1 test #4 (unregistered reason code) — cannot be driven through the Command
  Center at all, because `app/routers/hr.py` rejects an unknown `reason_code` with
  HTTP 422 before Auto is called. Driving it from the Auto test form tests the
  input-hint guard, not a code emitted by a branch; testing the branch path needs
  a temporary Operator change and two builder executions.
- O.1 test #5 (confidential + standard together) — privacy acceptance is covered
  by §6.1 test #3 and §5 OP-03 test #4; no sentinel string has leaked in any
  Operator-level test to date.
- Whole of O.2 — depends on the RPC below being applied and on the external
  blocker above. No acceptance criterion rests on O.2 alone.

### Pending application

- `public.record_finding_event` and `public.hr_known_reason_codes` exist in
  `config/supabase_schema.sql` but have **not** been applied to Supabase. They are
  verified across four empirical review rounds against a scratch PostgreSQL
  cluster. Apply immediately before O.2, not before — once live, an ORCH run
  launched from the Auto test form with a `cmd_`-shaped id that has no
  `command_runs` row will be rejected by the RPC's execution-id guard.
- O.1 test #5 was skipped on the basis that no sentinel string has leaked in any
  Operator-level test to date. That is evidence from OP-03 and OP-06 in isolation,
  not from a run where a confidential and a standard finding are routed
  simultaneously through ORCH-01 and OP-04. The merge stage partitions the two
  before deduplication and the routing stage passes `confidential_reasons` as a
  separate input, but that separation has been read in the code and never
  exercised end to end. Worth one run after E2E.

## 10. Build status tracker

Update this table only from raw Activity Timeline and direct database/API
proof. `Builder says done` is not evidence.

| ID | Workflow | Build step | Build | Tests | Evidence / notes |
|---|---|---|---|---|---|
| G-01 | Policy Studio | Active Round 2 policy | Done | Passed | Day-H active version: `policy_15a51b4e58cc4400a8a63ceb49b3cf92`, derived from `policy_round2_v1`; `demo_mode=false`, manager cap `{"default":2}`, bottleneck `2/25`, 18 observed codes. Re-query before every test block. |
| G-02 | Command Center | Restricted payroll RBAC | Done | Passed | Admin/payroll-reviewer login and restricted payroll visibility verified. |
| G-03 | Command Center | Manager action-state contract | Done | Passed | Live table/RPC contract and manager state fixtures verified. |
| G-04 | Runtime config | Published workflow UUID mapping | Configured | Partially verified | `AUTO_BASE_URL`, `AUTO_API_KEY`, `AUTO_ACTIVE_ORG`, `AUTO_HR_WORKFLOW_ID` semua terisi di `.env`; workflow id berbentuk UUID dan base URL cocok dengan `.env.example`; `auto.supervity.ai/health` 200. Validitas workflow id **tidak** bisa dikonfirmasi lewat API baca — lihat blocker eksternal di §9.4. Bukti definitifnya adalah satu run Command Center yang berhasil. |
| UI | Command Center | Policy Studio, Workbench, Dashboard, Data Manager | Done | Passed core build/login | Human Workbench action still needed as acceptance evidence. |
| 5.1-5.3 | OP-05 | Context/policy/timezone, rules+logs, failure behavior | Done | **Frozen** | Core + failure behavior passed, dan current-policy smoke `EMP7054` -> `COMPLIANCE_LEGAL_BREACH` lulus di bawah `policy_15a51b4e58cc4400a8a63ceb49b3cf92`. Tidak ada sisa tugas. Full detail in archive §2. |
| 6.1-6.3 | OP-06/OP-04 | Restricted context, rules+audit, restricted route | Done | **Frozen** | Detector-only. Core + idempotency passed, dan current-policy smoke `EMP7062` -> `PAYROLL_ERROR_DETECTED` (critical, evidence `payroll:PAY-40063`) lulus dengan leak check nol baris untuk `gross`/`net`/`error_reason`. Reopen/CLEAR/failure-route adalah scope OP-04, tercatat di 4.R2.x. Full detail in archive §3. |
| 7.1-7.3 | OP-07 | Employee dependencies+learning, cohort bottlenecks, manager accountability | Done/Core verified | Passed core | Frozen; true result-page pagination remains non-blocking technical debt. See archive §4. |
| C.1-C.3 | OP-01/02/03 | Active-policy compatibility | Rebuilt/Verified, frozen | Passed 5/5, Passed, Passed 6/6 | OP-02/OP-03 frozen. OP-01 passed all 5 essentials but has one remaining defect: a stale Date Parsing canvas edge raises a spurious escalation after a successful parse (runs end `awaiting_human_input` instead of `completed`); decisions/persisted rows unaffected, fix still pending before E2E. See Frozen Operators section above; full detail in archive §5. |
| 4.R2.1 | OP-04 | Round 2 routing/grouped cases | **Superseded — rewrite pending** | Partial, hasil lama tidak lagi dianggap valid | Code review §4.R2.3 menandai kelima step BLOCKER dan menemukan dua cacat canvas, jadi route yang dulu lulus pun lulus lewat jalur yang salah (route diturunkan dari `finding.domain` caller). Prompt rewrite dan dua test MVP ada di §4.R2.4. Matriks `testing1`–`testing19` ditunda sampai sesudah demo. |
| 4.R2.2 | OP-04 | Confidential independence | Not started | Not started | Required before final privacy acceptance. Sengaja di luar MVP §4.R2.4; vektor renderer tertutup assertion #13, partisi confidential/standard belum pernah dijalankan. |
| 4.R2.3 | OP-04 | Code review lima step | Done | N/A — review, bukan run | 27 temuan, kelima step BLOCKER, plus empat temuan integrasi canvas. Temuan hanya boleh ditandai selesai lewat test §4.R2.4 dengan bukti Timeline dan SQL. |
| 4.R2.4 | OP-04 | Rewrite lima step + gate canvas | **Done — MVP frozen** | **MVP 3/3 Passed** — MVP-1 Passed (`testing20`/`testing21`), MVP-2 Passed sebagian (`testing18`), MVP-3 Passed (`testing22`/`testing23`) | MVP-1: lima case benar, grouping/dedup benar, priority tidak ikut hint caller, nol leak, replay idempoten. MVP-2: fail-closed nyata — workflow berhenti di Fetch, nol write, nol Slack; **tapi** step keluar sebagai error dan run parkir `waiting review`, bukan structured exception, jadi **Fetch #6 tetap terbuka**. MVP-3: Slack benar-benar terkirim ke `C0BJ4PZ8961`, identity `learning:EMP7101:general`, replay nol kirim kedua — menutup baris Integrations §9. Dua defect ditemukan dan diperbaiki lewat MVP-3. Hutang peta channel konstanta dan Fetch #6 tercatat di §4.R2.4. |
| O.1 | ORCH-01 | Parallel fan-out/merge/handoff | Done | **Passed (essential)** | Run 2026-08-08 14:48:31–14:52:29 dari Auto test form, `EMP7032`. Fan-out paralel terbukti dari Activity Timeline: OP-02/03/05/06/07 mulai 14:48:48–14:48:52 (rentang 4 detik) dan berjalan bersamaan ±35 detik — mustahil pada eksekusi serial. Rantai keputusan utuh: Routing Logic completed, `Condition: No Escalation Needed` false, `Condition: Needs Escalation` true, `Call OP-04 Escalation Agent` completed. Merge menghasilkan `COMPLIANCE_LEGAL_BREACH` + `COMPLIANCE_DEADLINE_AT_RISK` (OP-05) dengan `policy_version_ids` nyata; OP-03/OP-06/OP-07 clear. Test #2–#5 sengaja tidak dijalankan — alasan dan bukti penggantinya di §9.4. Kontrak input: lima key dari `app/routers/hr.py`; `execution_id` dan `trigger_source` diturunkan sendiri; stage 1 tidak membaca policy. |
| O.2 | ORCH-01 | Command/event correlation | Not started | Not started | Depends on O.1 and G-04. Prompt direvisi 2026-08-08: lifecycle tetap milik Command Center (`AutoWorkflowClient.execute_stream`), ORCH hanya menulis finding lewat RPC baru `record_finding_event`. RPC itu harus sudah di-apply ke Supabase sebelum test O.2 dijalankan. |
| S.1 | Daily Sweep | Schedule/fan-out/cohort aggregation | Not started | Not started | Depends on ORCH-01 and verified OP-07 cohort mode. |
| E2E | All | Live acceptance rehearsal | Not started | Not started | Policy change → Auto → OP-04 → human Workbench → Dashboard/audit evidence. |

