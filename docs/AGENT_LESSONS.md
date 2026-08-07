# Agent Lessons

Persistent lessons for future Codex/Claude sessions. Add a short entry whenever
an implementation or verification attempt fails; record the prevention, not
credentials or confidential payloads.

- Split unrelated `apply_patch` changes. A missing line (especially with mixed
  encodings) otherwise rejects the entire patch; inspect the exact target first.
- After a file has changed repeatedly, re-read the current block before a
  multi-file patch. A stale reconciliation context rejected an otherwise valid
  cancellation patch; applying the files separately avoided hidden omissions.
- Run Python tests in the backend image when host dependencies are absent.
  Do not assume host `pytest` is installed, and do not retry it after this
  condition has already been recorded; use `compileall` separately, then Docker.
- In additive SQL scripts, create a table before any `alter table` targeting it.
  Re-read migration order after moving blocks, including clean-install behavior.
- Validate frontend changes with `docker compose build frontend`; the production
  container does not include source files for an in-container rebuild.
- Normalize the POSIX entrypoint inside the Docker image because Windows CRLF
  checkouts can make `/bin/sh` fail before the application starts.
- Do not infer Auto credential validity from one ambiguous HTTP response. Use
  read-only control requests and report an upstream ambiguity when valid and
  deliberately-invalid credentials produce the same response.
- Check `rg --files` output before reading an assumed root dependency file;
  this repository keeps Python requirements under `packages/`.
- If Docker is inactive and a temporary dependency download is network-blocked,
  record verification as blocked after one bounded attempt. Do not leave an
  escalated package-install process waiting indefinitely; terminate and use
  offline compile/smoke checks.
- Do not assume tools listed in `packages/requirements.txt` are installed on the
  Windows host (`pytest`, `flake8`, and transitive imports such as SQLAlchemy may
  be absent). Use the complete backend image for authoritative tests; keep host
  checks limited to modules whose import graph is available.
- Do not guess seed/config filenames after a search result. Read only the paths
  returned by `rg --files` (the policy seed is a script, not a SQL seed file).
- Apply the same rule to runtime configuration: enumerate `gunicorn/` before
  opening a presumed shared config; this repository has only `dev.py` and
  `prod.py`.
- A Docker test image must include every repository-relative fixture directory
  used by tests (`config/` and `dataset/csv/` here). Compose should mount test
  inputs read-only so local changes do not require an image rebuild.
- Current HTTPX uses `ASGITransport(app=...)`; do not pass `app=` directly to
  `AsyncClient`, because that compatibility argument has been removed.
- Authentication tests must set the module-level `AUTH_BYPASS` explicitly;
  Compose enables bypass for development, so inheriting its environment turns
  an unauthorized-request assertion into a misleading 200 response.
- Leave cleanup headroom above the pytest runtime when wrapping `docker compose
  run` in a command timeout; a suite finishing near the limit can otherwise be
  reported as exit 124 during container removal.
- Check whether `pdftotext` exists before relying on it. If it is unavailable,
  use a temporary PDF library outside the repository and keep the repo clean.
- Force UTF-8 stdout before printing extracted PDF text on Windows; the default
  code page can fail on punctuation such as non-breaking hyphens.
- A `400` from Auto's workflow-run listing is not proof that the API key,
  organization, or workflow UUID is invalid. Treat it as an endpoint/parameter
  contract mismatch until a documented read-only control request distinguishes
  those causes; never print the upstream response body because it may contain
  operational context.
- On Windows, even `repr()` output can contain Unicode that fails under the
  active console code page. For source inspections, print
  `text.encode("unicode_escape").decode("ascii")` instead of relying on repr or
  changing the file to accommodate the terminal.
- Do not assume the repository's `scripts/` directory imports as the intended
  namespace in an ad-hoc host Python process; another `scripts` package can win
  resolution. Import a script by its explicit file path or keep a tiny
  verification helper self-contained, while pytest may continue using its
  configured repository import path.
- When a zero-match `rg` result is the desired validation outcome, handle exit
  code 1 explicitly instead of chaining it as an ordinary success command; this
  keeps a clean privacy/language scan from being reported as a failed check.
- Do not place a role-specific companion endpoint in an unconditional frontend
  `Promise.all`; one expected 403 then hides data the same user may legitimately
  read. Gate optional requests with the exact backend capability contract and
  use an empty safe projection when the role lacks it.
- Keep mixed-role behavior identical in list, detail, action, and UI capability
  checks. A dedicated payroll role must not accidentally elevate a Manager or a
  general People Ops session through a looser action-path helper.
- PostgreSQL `CREATE DATABASE` cannot share a transactional `psql -c` batch with
  role or schema statements. Run the exact temporary-database creation as its
  own command, then create helper roles while connected to an existing database.
- When reconstructing an EAV policy snapshot, handle reserved categories before
  testing whether the category name already exists as a top-level key. Otherwise
  the first `retry` row creates that key and later retry-profile rows can be
  silently nested under it. Always round-trip the canonical JSON in a test.
### API error details are not always strings

- Mistake: the frontend API client passed FastAPI's structured `detail` object directly to `new Error()`, causing policy validation failures to appear as `[object Object]`.
- Prevention: normalize string, validation-list, and structured error details into a safe readable message at the shared API-client boundary.

### Allow enough time for Docker frontend builds

- Mistake: `docker compose up -d --build frontend` was given a 120-second tool timeout even though this repository's clean Next.js image build can take longer.
- Prevention: build the frontend image separately with a longer bounded timeout, then restart only the already-built frontend service.

### Keep PowerShell ripgrep patterns literal and small

- Mistake: a combined `rg` expression was over-escaped inside a PowerShell command and failed before inspecting the repository methods.
- Prevention: use single-quoted PowerShell regex patterns or separate simple `rg` searches instead of nesting escaped alternatives across shells.

### Respect the configured backend base path

- Mistake: a live OpenAPI check assumed `/openapi.json` even though this repository serves FastAPI under a configured base path, producing a misleading 404.
- Prevention: read `BASE_PATH` or the compose environment before probing documentation and API routes.

### Do not pass Windows wildcard paths directly to ripgrep

- Mistake: a PowerShell inspection passed `frontend/tailwind.config.*` directly to `rg`, which Windows treated as an invalid literal path.
- Prevention: discover matching files with `rg --files` first, or search the containing directory with a glob filter such as `-g 'tailwind.config.*'`.

### Verify identity infrastructure before recommending Admin UI provisioning

- Mistake: role creation through `/admin/roles` was recommended without first confirming that `AUTH_BYPASS` was disabled, Keycloak was configured, and `app/services/keycloak_admin.py` existed. The visible UI called a deliberate 501 stub.
- Prevention: inspect the effective auth mode, Compose services, required environment names, and admin-service implementation before treating an identity-management screen as functional.

### Validate runtime secrets at runtime, not during Next.js route collection

- Mistake: a top-level `NEXTAUTH_SECRET` assertion in the NextAuth route made the standard host production build fail because the root runtime `.env` is not loaded by a build launched from `frontend/`.
- Prevention: allow a build-only placeholder during compilation and fail the production container entrypoint when the runtime secret is absent.

### Prefer the actual service container for identity smoke tests

- Mistake: a piped inline Python smoke test used `docker compose run --rm` and timed out before producing evidence, conflating one-off container startup/stdio behavior with Keycloak client health.
- Prevention: recreate the real backend with the intended environment, then run bounded checks inside it; independently verify Keycloak REST readiness from the host.

### Keep optional-file probes out of required inspection batches

- Mistake: an auth audit batched real files with optional dependency paths that did not exist; the expected miss returned exit code 1 and obscured otherwise useful output.
- Prevention: discover optional paths first, then run required reads separately or explicitly normalize expected no-match exits.
- Recurrence: the same mistake later used an assumed `tests/test_auth_bypass.py` path in a parallel verification batch. Treat test-file discovery as mandatory, not optional, before every targeted pytest command.

### Do not truncate Docker manifest output with a terminating pipeline

- Mistake: piping `docker manifest inspect` into `Select-Object -First` closed stdout early and made Docker return exit code 1 even though the image manifest existed.
- Prevention: capture the full manifest first, then inspect the parsed or stored result without terminating the producer's stream.

### Use a header-oriented client for expected redirect checks

- Mistake: `Invoke-WebRequest -MaximumRedirection 0` raised an internal PowerShell null-reference error while checking a valid Next.js 307 response, obscuring the application result.
- Prevention: use `curl.exe -I` (or another client that exposes redirect headers without following them) when the expected evidence is an HTTP status and `Location` header.

### Match OAuth smoke tests to the framework response contract

- Mistake: an over-complex inline PowerShell/curl command for the NextAuth CSRF flow was rejected by command policy, and the first replacement assumed the sign-in endpoint returned a redirect even though `json=true` returns HTTP 200 with the authorization URL in JSON.
- Prevention: use a small in-memory Node request sequence for CSRF-protected NextAuth checks, and validate `payload.url` when JSON mode is requested.

### Verify an Auto Studio test form's real field scope and UI constraints before writing test tables

- Mistake: designed OP-07 §7.2/§7.3 test tables assuming each guide section had its own test-input fields, and assuming `scope` was free text. The actual Auto Studio form turned out to be one shared form reused across §7.1/§7.2/§7.3 (cohort/threshold fields appear in the manager-accountability form too), and `scope` was a required 2-option dropdown that can never be blank or invalid — an entire planned "scope kosong/invalid" test was unreachable through the UI.
- Prevention: before writing input-validation test cases for an Auto Studio form, ask what fields actually exist on that form and whether each is free text or a constrained control (dropdown/select). A "system_exception on invalid X" test is dead weight if the UI structurally prevents that input; the underlying code branch (if any) still belongs in a code-review checklist, not a live test.

### A prompt asking for "paginated REST" does not mean the build has result-page pagination

- Mistake: assumed the OP-07 cohort step's `Cross_Team_Dependencies` read was paginated because the original build prompt said "using paginated REST." The actual code only chunked the `employee_id` list for the `in.()` filter (`chunk_size=200`, an unrelated URL-length concern) with no `limit`/`offset` on the dependency read itself — for a 19-worker cohort this collapsed to one unpaginated HTTP call with nothing to shrink for a pagination test.
- Prevention: when a build prompt claims "paginated REST," read the actual REST call for an explicit `limit`/`offset` loop or `Range` header before designing a test that shrinks the page size. Chunking an ID list for a filter and paginating a result set are different problems that read as the same thing in prose.

### A wrong `select=` column list in a Supabase REST call fails silently, not loudly

- Mistake: an OP-07 Learning Logic step queried `Learning_Milestones?select=id,milestone_name,due_day,status`, but the table's real columns are `milestone_id,employee_id,course,due_day,status`. PostgREST likely rejects the unknown columns, and the step's broad `try/except` swallowed that into an empty result set — `LEARNING_MILESTONE_OVERDUE` silently never fired for anyone, with no visible error anywhere in the step's own output.
- Prevention: verify every `select=` field list in an Auto Code step against the actual table header (CSV export or `information_schema`) before trusting it, especially when the step wraps its REST call in a broad exception handler. A column-name typo here looks identical to "no data yet," not to a crash.

### `raise` inside an Auto Code step can discard an already-built system_exception before it reaches the output

- Mistake: a Day-1 Readiness step appended a `DATA_MISSING` entry to its exceptions list on worker-not-found, then immediately `raise`d — before the line that assigns the global output variable ever ran. The structured exception was built but never actually surfaced in the step's output; the caller would see a raw crash instead of a safe envelope. This is the same failure category already logged for OP-05 (`EMP-NOT-FOUND` returning a raw 401 instead of a structured `WORKER_NOT_FOUND`).
- Prevention: in any Auto Code step, treat `raise`/unhandled exceptions as suspect on sight. Every early-return path for invalid/missing input or data must assign the global output variable (or otherwise return the safe envelope) *before* stopping, never after — check this specifically whenever a step accumulates exceptions into a list and only "returns" them at the end of the function.

### Read a PostgREST RPC's real argument names before writing the call

- Mistake: OP-07's escalation step posted `{case_id, source_event_id, new_state, event_timestamp}` to `rpc/record_manager_action_event`, inferring the argument names from the positional SQL fixtures in the build guide. The real signature is `(target_case_id, new_source_event_id, new_event_type, event_occurred_at, new_next_reminder_at, new_acknowledgment_deadline, new_action_deadline)` — all four supplied names were wrong, so PostgREST could not resolve the function at all.
- Prevention: PostgREST matches RPC calls by argument *name*, and a mismatch returns `PGRST202` (function not found) rather than a defaulted call, so the failure is total and looks like a missing function rather than a bad payload. Run `select pg_get_function_arguments(p.oid) from pg_proc p where p.proname = '<fn>';` and copy the names verbatim before writing any RPC body. A positional `select fn(a, b, c)` in a SQL fixture proves argument *order and types*, never their names.

### A server-side guard can make a planned negative test unconstructible

- Mistake: §7.3's payroll-exclusion test tried to seed a `manager_action_states` row for a `case_type='payroll'` case. The RPC itself rejects that with `P0001: Payroll case cannot enter manager action state`, so the fixture could never be created and the test could not run as written.
- Prevention: when a negative test needs a state the system deliberately forbids, check whether the guard lives in the database before assuming the fixture is possible. If it does, construct the state through an allowed shape first and mutate it afterwards (here: insert the case as `dependency`, record the events, then `update` the `case_type` to `payroll`) so the Operator-side filter is still exercised. Note in the test which layer each guard belongs to — a rule enforced in the RPC does not need a live test of the Operator's copy of the same rule, but the reverse is not true.

### Auto builder applies full-specification prompts and silently drops surgical ones

- Mistake: across roughly eight rounds, prompts phrased as targeted edits ("delete this line", "change this condition", even with literal before/after code) never reached the saved step — the pasted code came back byte-identical every time. Prompts phrased as a complete regeneration of the step ("rewrite the entire function from scratch" followed by the full behavioural spec) landed on every attempt. Several rounds were lost re-diagnosing already-correct analysis.
- Prevention: in Auto Studio, express every change as a full-step specification with the fix embedded in the desired behaviour, not as a diff against the current code. Open a fresh builder chat per step — a long chat also cross-contaminates, at one point applying a Learning Logic instruction to the Manager Accountability step. Before reviewing pasted code again, check one or two literal markers from the previous request; if they are absent, the change never saved and re-reviewing the logic is wasted effort.

### Confirm a multi-step Auto pipeline is actually wired together, not just internally correct

- Mistake: reviewed a proposed manager-accountability step in isolation without first checking whether the pipeline's final step ("Write Evaluation and Output") ever reads its output variable. It read `step_learning_eval_output` directly — a fourth step would have executed and produced findings that never reached the final envelope or `policy_evaluations`, silently, with no error anywhere.
- Prevention: when reviewing or extending a multi-step Auto pipeline, trace the actual `globals()[f"step_..._output"]` write in each step against the `globals().get(...)` read in the next one, end to end, before reviewing any single step's internal logic. A step can be perfectly correct and still contribute nothing if the chain isn't wired to it.

## Auto Studio live-build lessons — 2026-08-06

### Treat Activity Timeline and database rows as the source of truth

- Mistake: builder summaries claimed four scenarios had passed, named a different
  deterministic ID, or said persistence succeeded while the Activity Timeline
  showed only one run or `INTEGRATION_FAILURE`.
- Prevention: accept a result only after checking the raw step outputs and a
  direct Supabase query. When the summary disagrees, quote the actual Timeline
  value back to the builder and do not save the workflow as final.

### Unsaved chat builds and saved Operator versions are different execution targets

- Mistake: trying to rerun a changed workflow from **My Operators** before the
  chat version was committed; My Operators executes the last saved version, not
  the in-chat draft.
- Prevention: ask the builder to run the exact same inputs again inside the same
  chat before saving. If the builder cannot rerun, save a clearly named
  checkpoint (`... Pending`), test the saved version, and only then create the
  verified final version.

### Keep automatic builder auto-fix off for deterministic contract bugs

- Mistake: treating policy parsing, shared-state propagation, REST contract, or
  idempotency errors as transient step failures that automatic retries could
  repair.
- Prevention: leave `Allow automatic step retries (auto-fix)` off while
  rebuilding deterministic logic. Use application-level retry only from the
  active policy profile after the request and state contract are correct.

### Policy thresholds can be structured objects, not only scalars

- Mistake: rejecting active policy values such as
  `{"default":14}` and `{"default":30}` as invalid numeric thresholds, causing
  `POLICY_CONTEXT_INVALID` even though the database snapshot was valid.
- Prevention: validate both non-negative numeric values and objects with a
  non-negative numeric `default` plus optional jurisdiction overrides. Verify
  the live JSON shape in SQL before rebuilding Auto logic.

### Log sanitization must not delete internal routing state

- Mistake: a sanitization rebuild hid the full policy and worker record but also
  removed the internal `reason_codes` array and `jurisdiction`, producing
  `reason_code_count=0` and `exception:<employee>:missing_jurisdiction`.
- Prevention: separate internal shared state from display/log projections.
  Preserve the minimum internal fields required by the next step, while logging
  only counts and safe identifiers. Trace the global/shared-state write and read
  after every sanitization change.

### Do not hard-code the current reason-code count

- Mistake: temporarily requiring exactly 18 codes fixed one test but would reject
  a future approved policy that safely extends the registry.
- Prevention: require a non-empty active-policy registry and parity with the
  engineering registry. Use the observed count only as a test assertion for the
  current version, not as permanent business logic.

### Deterministic identities are required at every persistence layer

- Mistake: OP-06 initially generated a random UUID for each
  `policy_evaluations` write. A replay with the same execution ID increased the
  row count from one to two even though the business outcome was identical.
- Prevention: derive the evaluation ID from stable execution, Operator, policy,
  object, and rule/classification inputs; upsert with
  `on_conflict=evaluation_id`; prove idempotency with the same execution ID and
  direct `count(*)` queries.

### Detectors must not also be governed case writers

- Mistake: OP-06 wrote `payroll-PAY-40063` directly while OP-04 also wrote the
  canonical `payroll:EMP7062`, leaving two open cases for one signal.
- Prevention: OP-05/06/07 return safe findings only. ORCH-01 merges them and
  OP-04 is the single governed Workbench/notification writer. Preserve old cases
  as audit history and close the legacy duplicate through a human Workbench
  action rather than deleting it in SQL.

### Scope authentication fixes to the one failing REST request

- Mistake: a plan to fix one HTTP 401 proposed adding `httpx`, changing all
  communication steps, and optimizing already-verified worker/payroll reads.
- Prevention: reject broad plans. Rebuild only the failing Custom REST upsert,
  reuse the saved Supabase credential already proven in neighboring steps, and
  keep all other behavior unchanged.

### Re-query the active policy before every test block

- Mistake: assuming the previously verified policy ID was still active while a
  teammate had activated a new `7.3` version concurrently.
- Prevention: query `policy_versions where status='active'` immediately before a
  test series. Record the exact `policy_version_id` in evidence and rerun the
  final OP-05/OP-04 smoke tests after policy changes.

### Case identity evidence must come from the persisted Round 2 key

- Mistake: treating the legacy `Generate Case ID` UUID as proof of Round 2 case
  determinism.
- Prevention: a legacy UUID may remain for Round 1 branches, but verify the
  actual Round 2 `workbench_cases.case_id`, such as
  `compliance:EMP7054:SG` or `payroll:EMP7062`, and prove repeat delivery keeps
  `case_count=1`.

### Inspect the actual table schema before writing verification SQL

- Mistake: querying `workbench_cases.updated_at` when that column did not exist,
  interrupting an otherwise valid verification sequence.
- Prevention: inspect `information_schema.columns` or the repository schema
  before selecting convenience timestamps. Use only confirmed columns in live
  evidence queries.

## Auto Studio live-build lessons — 2026-08-07

### Diagnose planner hangs from active executions, not total history count

- Mistake: treating `Total Run = 99` as evidence that the Audit Trail had hit a
  documented hard limit, while nine executions were still marked `Running` and
  two builder chats were stuck in repeated planning phases.
- Prevention: inspect `Running` and `Waiting` first. If stale executions remain
  and no teammate owns them, terminate only the active runs, confirm both counts
  return to zero, refresh, and reopen one fresh builder chat from the last saved
  checkpoint. Completed/cancelled history count alone is not proof of a limit.

### Use one fresh builder chat and one complete step specification at a time

- Mistake: opening multiple chats and asking for multi-step cohort fixes caused
  the planner to loop through analysis without producing an executable plan.
- Prevention: branch from the latest saved version, keep only one builder chat
  active, rebuild one complete existing step, verify it, save a distinctly named
  checkpoint, then open a new chat for the next step. Keep auto-fix off for
  deterministic contract changes.

### Generic finding normalization can erase valid extension fields

- Mistake: the cohort detector correctly produced `team`, `affected_count`,
  `denominator`, `percent`, and `dependency_ids`, but the downstream generic
  normalizer reduced the finding to the common six fields and emitted empty
  evidence, null ownership, and no recommended action.
- Prevention: when a common envelope permits domain-specific safe metadata,
  explicitly preserve those fields through every step. For
  `COHORT_DEPENDENCY_BOTTLENECK`, carry cohort/team/count/denominator/percentage
  and convert each safe dependency ID to `dependency:<id>` without dropping the
  original team results.

### Verify persistence with exact execution correlation, but account for timing

- Mistake: an immediate `count(*)` query returned zero and was interpreted as a
  failed cohort audit write, while a later time-window query showed all four
  deterministic rows under the correct execution ID.
- Prevention: first query the exact `execution_id`; if the result conflicts with
  a just-finished Timeline, re-run once after completion and inspect a narrow
  `evaluated_at` window plus the deterministic ID prefix. Never accept the UI
  `Records Written` count by itself, but do not declare persistence failure from
  one possibly premature read either.

### Save verified intermediate contracts under new checkpoint names

- Mistake: overwriting a broad verified version name with a partially changed
  cohort contract would have made rollback and regression attribution unclear.
- Prevention: save incremental milestones under distinct names, for example
  `OP-07 Cohort Dependency Evidence — Verified`, then save the integrated result
  as `OP-07 Cross-Team Readiness — Core Verified` only after downstream
  normalization and database persistence both pass.

### Prefer copied Markdown query results as verification evidence

- Prevention: use Supabase's “copy as Markdown” output for multi-row evidence.
  It preserves column names and row alignment, reduces transcription mistakes,
  and makes deterministic IDs, outcomes, and execution correlation reviewable.

## Auto Studio live-build lessons — 2026-08-08 (OP-01 compatibility migration)

### Every builder fix prompt must ship with exactly one test

- Mistake: treating a fix prompt and its verification as separate activities,
  sending a rewrite prompt with no designated test or with a multi-row test
  table attached.
- Prevention: Auto only persists a builder change by executing the workflow
  once, so that execution should be spent proving the specific defect is fixed.
  Pair every rewrite prompt with exactly one test whose result *differs*
  depending on whether the fix landed — a passing-looking number that both
  branches produce (a 97% similarity score here) discriminates nothing. Prefer
  asserting on the step's stdout envelope over database side effects, since
  stdout is visible in the Activity Timeline either way.

### A correct `policy_version_id` is not evidence the policy was read

- Mistake: OP-01's fuzzy dedup step reported the active `policy_version_id` in
  both its output and its `policy_evaluations` row while deciding from
  `{confidence: 0.9, flag_band: 0.75, proximity_days: 30}` — the hardcoded
  Round 1 defaults. The active snapshot held `{0.7, 0.7, 3}`. The audit trail
  looked fully migrated; only the decision numbers were stale, which would have
  read as a data bug rather than a migration bug during the policy-change test.
- Prevention: require every migrated step to echo the *resolved threshold
  values* it actually used, not just the version ID, and assert on those
  numbers. Design the proving test around a policy key whose live value differs
  from the hardcoded default. The strongest tell is a value that exists in **no**
  policy version at all (`0.75` was never any version's `dedup_flag_band_low`),
  because matching the current active value can happen by coincidence.

### A saved prompt is not a satisfied requirement

- Mistake: the existing lesson about checking literal markers was followed and
  the marker did appear — the rewrite genuinely added `thresholds_used`,
  `halt_pipeline`, the new intake vocabulary, and the previously missing
  evaluation row. The one requirement the rewrite existed for, reading
  thresholds from the snapshot, was still silently unmet because a default
  dictionary survived underneath.
- Prevention: marker presence proves the prompt reached the step; only the
  marker's *value* proves the requirement. When a rewrite must remove a
  fallback, name the forbidden constructs explicitly — the literal numbers, a
  `dict.get` with a default, a `try/except` that substitutes a value — and make
  the test assert the value rather than the field's existence.

### Renaming an output value can break a canvas branch condition

- Mistake: a rewrite replaced fuzzy dedup's `review` result with
  `intake_possible_duplicate`. The workflow canvas routes on a separate
  "Dedup Requires Review" edge condition that may still match the old string.
  The verifying run happened to return `will_update`, never exercised that
  branch, and left the mismatch invisible.
- Prevention: in a branched Auto workflow, step code and canvas edge conditions
  are two separate places the same vocabulary appears. After changing any value
  a branch dispatches on, inspect the edge condition on the canvas and run one
  case that traverses the renamed branch. A stale condition fails open —
  execution continues down the success edge instead of escalating.

### Builder "implementation" runs write to the live database

- Mistake: accepted that a builder implementation run was a write-free mock and
  read an empty `Workers` result as proof that an escalation branch had halted
  the pipeline. Those same runs had already persisted `policy_evaluations` rows,
  and a later one updated a fixture row's `Legal_Name` and `Hire_Date`.
- Prevention: treat every builder execution as a real write against Supabase.
  Reset fixtures before each verification run and clean up afterwards, and never
  use an unchanged table as evidence about control flow without first proving
  that the run writes at all.

### Builder-generated code can embed a real credential

- Mistake: three OP-01 steps contained a literal `service_role` JWT for the live
  project, introduced by the builder itself and framed in comments as
  "placeholder detection" with a fallback that read as defensive engineering.
- Prevention: scan every generated step for literal keys, tokens, and project
  refs before reviewing its logic. Specify env-only credential reads with **no**
  default argument, so a missing variable fails loudly instead of silently
  falling back to an embedded key. Rotating the key does not remove the leak
  from the workflow source or from the builder chat history.

### "Keep everything else unchanged" turns a rewrite prompt back into a diff

- Mistake: a Supabase-write rewrite opened with "Rewrite the entire step from
  scratch" but added "Keep every behaviour not mentioned below exactly as it is
  now." The builder dropped it silently — the returned step kept the old
  `status` string, omitted the newly required `reasons` field, and left the old
  `error` field in place. The earlier fuzzy-dedup rewrite, which restated the
  full behavioural spec and explicitly said not to assume anything carried over,
  landed on the first attempt.
- Prevention: a rewrite prompt must be self-contained. Restate every behaviour
  the step needs, including the parts that are already correct, and never point
  at the current code as the source for anything. One sentence deferring to the
  existing implementation is enough to make the whole prompt read as a change
  list, which is the shape that never saves.

### Specify nested JSON with a literal shape example, not prose

- Mistake: a prompt said `evidence` "must be passed as a Python dict inside a
  bare JSON array body". The builder inverted both halves — it sent the row
  object directly as the body and wrapped `evidence` in a list, producing
  `evidence` = `[{...}]` in a `jsonb` column. Prose that describes two nesting
  levels at once is read as one.
- Prevention: when a request body or a JSON column has structure, paste the
  literal shape into the prompt and say which part is which, for example
  `[ { "policy_key": "...", "evidence": { "worker_wid": "..." } } ]`. Then state
  the two failure modes explicitly: do not put the row object directly in the
  body, and do not wrap evidence in a list.

### Stop rewriting once the decision path is correct

- Mistake: after the Supabase Write step already produced correct decisions,
  correct gating, a real run `execution_id`, `outcome = "clear"`, and a null
  `Employee_ID`, another rebuild round was proposed for three audit-shape items
  — evidence nesting, a success code reported in an `error_status_code` field,
  and an `action` label that disagreed with the dedup step. None of them changes
  what the Operator decides, and no essential test measures any of them.
- Prevention: before spending a builder round, ask which live test would fail if
  the defect stayed. If the answer is none, record it as optional debt in the
  guide and move on — every round costs an execution, and Operators that have
  not been verified at all are worth more than polish on one that already works.
  Separate "changes a decision" from "changes how the audit row looks" when
  triaging a review, and say which category each finding is in.

### Audit columns drift apart unless the convention is restated every time

- Mistake: four OP-01 steps each invented their own `execution_id`
  (`manual_execution`, `local_execution`, `manual_run_context`,
  `manual_execution_for_implementation`), wrote `evidence` as a `json.dumps`
  string into a `jsonb` column, and disagreed on vocabulary (`PASS`/`SKIP`/`FAIL`
  and `MANDATORY_HIRE_DATE` against `clear` and `manager_resolution`). One step
  also placed a submitted manager name into `evidence` despite the prompt
  forbidding it.
- Prevention: repeat the audit conventions verbatim in every per-step prompt
  rather than assuming they carry over — a single shared `execution_id` source,
  `evidence` passed as a dict, lowercase snake_case `policy_key`/`outcome`, and
  identifiers-and-counts only. Rows written by separate steps of one run cannot
  be proven to belong to that run when each step names the run differently.

