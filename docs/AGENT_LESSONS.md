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
