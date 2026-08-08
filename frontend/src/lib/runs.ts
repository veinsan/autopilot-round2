/**
 * Domain vocabulary for HR reassessment runs.
 *
 * Every exported message here is written for the operator, not for an engineer.
 * Technical identifiers (run references, error codes, HTTP results) never
 * appear in a sentence returned from this module; they belong only in the
 * separate "details for support" affordance on the page.
 */

import { ApiError, NetworkError } from '@/lib/api-client'

export type RunScope = 'employee' | 'cohort'

export type RunRecord = {
  command_id: string
  created_at?: string | null
  created_by?: string | null
  status: string
  scope: string
  employee_id?: string | null
  cohort?: string | null
  requested_reason?: string | null
  workflow_key?: string | null
  trigger_source?: string | null
  last_event_at?: string | null
  last_reconciled_at?: string | null
  reconciliation_status?: string | null
  error_code?: string | null
}

export type RunEvent = {
  event_id: string
  sequence_no: number
  occurred_at?: string | null
  operator_id?: string | null
  event_type: string
  status?: string | null
  reason_codes?: string[] | null
  details?: { error_type?: string; source?: string } | null
}

/* -------------------------------------------------------------------------- */
/* Reason codes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The governed reason-code registry, in the operator's words. The keys match
 * the registry the backend accepts; an unknown key is never shown raw.
 */
const REASON_CODE_LABELS: Record<string, string> = {
  MISSING_DAY_ONE_ACCESS: 'Day-1 access is still missing',
  STALLED_COMPLIANCE_DOC: 'A compliance document has stalled',
  TASK_ALREADY_ESCALATED: 'The task was already escalated',
  PROVISIONING_DELAYED: 'Equipment or account setup is delayed',
  LOW_ENGAGEMENT_SCORE: 'The engagement score is low',
  SENSITIVE_DISCLOSURE_DETECTED:
    'A confidential review is required (details are not shown here)',
  COMPLIANCE_DEADLINE_AT_RISK: 'A compliance deadline is at risk',
  COMPLIANCE_LEGAL_BREACH: 'A compliance deadline has been missed',
  WORK_AUTH_EXPIRY_AT_RISK: 'Work authorisation is expiring soon',
  WORK_AUTH_EXPIRED: 'Work authorisation has expired',
  PAYROLL_ERROR_DETECTED: 'A payroll error was detected',
  PAYROLL_NOT_CONFIRMED: 'First payroll is not confirmed',
  PAYROLL_RECORD_MISSING: 'A payroll record is missing',
  DAY_ONE_DEPENDENCY_BLOCKED: 'A Day-1 dependency is blocked',
  LEARNING_MILESTONE_OVERDUE: 'A learning milestone is overdue',
  MANAGER_ACKNOWLEDGMENT_OVERDUE: 'A manager acknowledgement is overdue',
  MANAGER_ACTION_OVERDUE: 'A manager action is overdue',
  COHORT_DEPENDENCY_BOTTLENECK: 'A shared dependency is blocking a cohort',
}

export function reasonCodeLabel(code: string | null | undefined): string {
  if (!code) return 'No reason recorded'
  return REASON_CODE_LABELS[code] ?? 'An operational signal was recorded'
}

/**
 * The same governed registry, worded as an answer to "why am I asking for this
 * reassessment?" rather than "what did the system find?". The stored value is
 * unchanged — only the wording differs — because `create_run` rejects anything
 * outside the registry.
 */
const REASON_REQUEST_LABELS: Record<string, string> = {
  COMPLIANCE_DEADLINE_AT_RISK: 'A compliance deadline is approaching',
  COMPLIANCE_LEGAL_BREACH: 'A compliance deadline has been missed',
  STALLED_COMPLIANCE_DOC: 'A compliance document has not come back',
  WORK_AUTH_EXPIRY_AT_RISK: 'Work authorisation is expiring soon',
  WORK_AUTH_EXPIRED: 'Work authorisation has expired',

  PAYROLL_ERROR_DETECTED: 'Something looks wrong in their pay',
  PAYROLL_NOT_CONFIRMED: 'First payroll has not been confirmed',
  PAYROLL_RECORD_MISSING: 'There is no payroll record for them',

  MISSING_DAY_ONE_ACCESS: 'They still cannot get into what they need',
  PROVISIONING_DELAYED: 'Equipment or accounts are late',
  DAY_ONE_DEPENDENCY_BLOCKED: 'Another team is blocking their first day',
  COHORT_DEPENDENCY_BOTTLENECK: 'One dependency is holding up a whole cohort',

  LEARNING_MILESTONE_OVERDUE: 'A learning milestone is overdue',
  LOW_ENGAGEMENT_SCORE: 'Their engagement score has dropped',
  SENSITIVE_DISCLOSURE_DETECTED: 'A confidential matter needs reviewing',

  MANAGER_ACKNOWLEDGMENT_OVERDUE: 'Their manager has not acknowledged a nudge',
  MANAGER_ACTION_OVERDUE: 'Their manager has not completed an action',
  TASK_ALREADY_ESCALATED: 'This was escalated already and needs another look',
}

/** Grouped so eighteen options stay scannable in the picker. */
export const REASON_REQUEST_GROUPS: Array<{
  title: string
  options: Array<{ value: string; label: string }>
}> = [
  {
    title: 'Compliance and work authorisation',
    options: [
      'COMPLIANCE_DEADLINE_AT_RISK',
      'COMPLIANCE_LEGAL_BREACH',
      'STALLED_COMPLIANCE_DOC',
      'WORK_AUTH_EXPIRY_AT_RISK',
      'WORK_AUTH_EXPIRED',
    ],
  },
  {
    title: 'Pay',
    options: [
      'PAYROLL_ERROR_DETECTED',
      'PAYROLL_NOT_CONFIRMED',
      'PAYROLL_RECORD_MISSING',
    ],
  },
  {
    title: 'Getting set up',
    options: [
      'MISSING_DAY_ONE_ACCESS',
      'PROVISIONING_DELAYED',
      'DAY_ONE_DEPENDENCY_BLOCKED',
      'COHORT_DEPENDENCY_BOTTLENECK',
    ],
  },
  {
    title: 'Progress and engagement',
    options: [
      'LEARNING_MILESTONE_OVERDUE',
      'LOW_ENGAGEMENT_SCORE',
      'SENSITIVE_DISCLOSURE_DETECTED',
    ],
  },
  {
    title: 'Manager follow-up',
    options: [
      'MANAGER_ACKNOWLEDGMENT_OVERDUE',
      'MANAGER_ACTION_OVERDUE',
      'TASK_ALREADY_ESCALATED',
    ],
  },
].map((group) => ({
  title: group.title,
  options: group.options.map((value) => ({
    value,
    label: REASON_REQUEST_LABELS[value],
  })),
}))

/** How a requested reason reads once the reassessment exists. */
export function reasonRequestLabel(code: string | null | undefined): string {
  if (!code) return 'No reason given'
  return REASON_REQUEST_LABELS[code] ?? 'Reason recorded'
}

/* -------------------------------------------------------------------------- */
/* Phases                                                                      */
/* -------------------------------------------------------------------------- */

export type RunPhase =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'

export function runPhase(
  status: string | null | undefined,
  cancelRequested = false
): RunPhase {
  const value = String(status ?? '').toLowerCase()
  if (value === 'completed') return 'completed'
  if (value === 'failed') return 'failed'
  if (value === 'cancelled') return 'cancelled'
  if (cancelRequested) return 'stopping'
  if (value === 'queued') return 'queued'
  return 'running'
}

export const PHASE_LABEL: Record<RunPhase, string> = {
  queued: 'Waiting to start',
  running: 'In progress',
  stopping: 'Stopping',
  completed: 'Finished',
  failed: 'Did not finish',
  cancelled: 'Stopped',
}

export const PHASE_BADGE: Record<RunPhase, string> = {
  queued: 'border-slate-200 bg-slate-100 text-slate-700',
  running: 'border-blue-200 bg-blue-50 text-blue-800',
  stopping: 'border-amber-200 bg-amber-50 text-amber-800',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  failed: 'border-destructive/30 bg-red-50 text-red-800',
  cancelled: 'border-slate-200 bg-slate-100 text-slate-700',
}

export function isTerminalPhase(phase: RunPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled'
}

/** The plain description of a run's subject, used as its primary identity. */
export function runSubject(run: {
  scope?: string | null
  employee_id?: string | null
  cohort?: string | null
}): string {
  if (run.employee_id) return `Employee ${run.employee_id}`
  if (run.cohort) return `${run.cohort} cohort`
  return run.scope === 'cohort' ? 'A cohort' : 'An employee'
}

/** One honest sentence about where the run stands right now. */
export function phaseSentence(phase: RunPhase, run: RunRecord | null): string {
  const subject = run ? runSubject(run).toLowerCase() : 'this request'
  switch (phase) {
    case 'queued':
      return `The reassessment of ${subject} has been accepted and is waiting for the workflow to pick it up.`
    case 'running':
      return `The reassessment of ${subject} is running its policy checks now.`
    case 'stopping':
      return `Stopping the reassessment of ${subject}. The step that is already running finishes first.`
    case 'completed':
      return `The reassessment of ${subject} finished and its result has been recorded.`
    case 'failed':
      return `The reassessment of ${subject} stopped before it produced a result.`
    case 'cancelled':
      return `The reassessment of ${subject} was stopped. Anything recorded before it stopped is kept.`
  }
}

/* -------------------------------------------------------------------------- */
/* Stages                                                                      */
/* -------------------------------------------------------------------------- */

export type StageState = 'done' | 'active' | 'pending' | 'stopped'

export type RunStage = {
  key: string
  label: string
  state: StageState
  detail?: string
}

const PROGRESS_EVENTS = new Set([
  'workflow-run',
  'activity-run',
  'result',
  'reconciliation',
  'finding',
  'case_created',
  'case_updated',
])

export type RunSummary = {
  stages: RunStage[]
  checksCompleted: number
  findings: Array<{ code: string; label: string; count: number }>
  casesTouched: number
  trouble: string | null
}

/**
 * Fold the raw event stream into the few stages an operator actually decides
 * on. The individual events are deliberately not surfaced as a log.
 */
export function summariseRun(
  run: RunRecord | null,
  events: RunEvent[],
  cancelRequested = false
): RunSummary {
  const phase = runPhase(run?.status, cancelRequested)
  const terminal = isTerminalPhase(phase)
  const stopped = phase === 'cancelled'

  const checksCompleted = events.filter(
    (event) => event.event_type === 'activity-run'
  ).length
  const started =
    events.some((event) => PROGRESS_EVENTS.has(event.event_type)) ||
    (run !== null && String(run.status).toLowerCase() !== 'queued')

  const findingCounts = new Map<string, number>()
  for (const event of events) {
    if (event.event_type !== 'finding') continue
    for (const code of event.reason_codes ?? []) {
      findingCounts.set(code, (findingCounts.get(code) ?? 0) + 1)
    }
  }
  const findings = [...findingCounts.entries()]
    .map(([code, count]) => ({ code, label: reasonCodeLabel(code), count }))
    .sort((left, right) => right.count - left.count)

  const casesTouched = new Set(
    events
      .filter(
        (event) =>
          event.event_type === 'case_created' ||
          event.event_type === 'case_updated'
      )
      .map((event) => event.event_id)
  ).size

  const errorTypes = events
    .map((event) => event.details?.error_type)
    .filter((value): value is string => Boolean(value))
  const trouble =
    eventTroubleSentence(errorTypes) ?? runTroubleSentence(run?.error_code)

  const stageState = (
    done: boolean,
    active: boolean,
    unreachable: boolean
  ): StageState => {
    if (done) return 'done'
    if (stopped || unreachable) return 'stopped'
    return active ? 'active' : 'pending'
  }

  const stages: RunStage[] = [
    {
      key: 'accepted',
      label: 'Request accepted',
      state: 'done',
      detail: run?.created_at
        ? `Recorded at ${formatTime(run.created_at)}`
        : undefined,
    },
    {
      key: 'started',
      label: 'Workflow started',
      state: stageState(started, !started && !terminal, terminal && !started),
      detail: started
        ? undefined
        : 'Waiting for the workflow service to pick this up.',
    },
    {
      key: 'checks',
      label: 'Policy checks running',
      state: stageState(
        terminal && started,
        started && !terminal,
        terminal && !started
      ),
      detail:
        checksCompleted > 0
          ? `${checksCompleted} ${checksCompleted === 1 ? 'check' : 'checks'} completed`
          : undefined,
    },
    {
      key: 'result',
      label: 'Result recorded',
      state: stageState(phase === 'completed', !terminal, terminal),
      detail: terminal ? phaseSentence(phase, run) : undefined,
    },
  ]

  return { stages, checksCompleted, findings, casesTouched, trouble }
}

function formatTime(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? 'an earlier time'
    : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatTimestamp(value?: string | null): string {
  if (!value) return 'Not recorded'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'Not recorded' : parsed.toLocaleString()
}

export function formatElapsed(fromIso?: string | null, nowMs?: number): string {
  if (!fromIso) return ''
  const started = new Date(fromIso).getTime()
  if (Number.isNaN(started)) return ''
  const seconds = Math.max(0, Math.floor(((nowMs ?? Date.now()) - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/* -------------------------------------------------------------------------- */
/* Trouble that the run itself reported                                        */
/* -------------------------------------------------------------------------- */

/** A run-level problem recorded on the run record. */
export function runTroubleSentence(
  errorCode: string | null | undefined
): string | null {
  switch (errorCode) {
    case 'AUTO_TRANSPORT_ERROR':
      return 'The reassessment could not reach the workflow service, so it stopped early and produced no result. Nothing was changed for this employee or cohort. Starting it again in a few minutes is safe.'
    case 'STREAM_INTERRUPTED':
      return 'The workflow service stopped reporting before this reassessment announced a result. Anything it already recorded is kept, and the Command Center is re-checking the outcome automatically. Come back in a few minutes.'
    case 'AUTO_CANCEL_FAILED':
      return 'The request to stop this reassessment was recorded, but the workflow service never confirmed it. The work may still be running. Check again shortly and tell your platform support team if it has not stopped.'
    default:
      return null
  }
}

/** A problem reported inside the progress stream. */
function eventTroubleSentence(errorTypes: string[]): string | null {
  if (errorTypes.includes('auto_execution_error')) {
    return 'The workflow reported a problem while assessing, so this run may be incomplete. Review the result below, then start the reassessment again if anything is missing.'
  }
  if (errorTypes.includes('auto_transport_error')) {
    return 'The connection to the workflow service failed while this reassessment was running, so it may be incomplete. Starting it again in a few minutes is safe.'
  }
  if (
    errorTypes.includes('invalid_auto_event_shape') ||
    errorTypes.includes('unknown_auto_event')
  ) {
    return 'An update arrived in a form the Command Center does not recognise and was skipped. The reassessment itself continued.'
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Failure wording                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Why a request did not succeed.
 *
 * `fault` exists so an unexpected client-side failure is never reported as a
 * connection problem. Telling someone to check their network when the network
 * is fine sends them somewhere they cannot fix anything.
 */
type FailureKind = 'refused' | 'network' | 'auth' | 'fault'

type Classified = { status: number | null; detail: string; kind: FailureKind }

function classify(error: unknown, context: string): Classified {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      detail: String(error.message ?? '').toLowerCase(),
      kind: error.status === 401 ? 'auth' : 'refused',
    }
  }
  if (error instanceof NetworkError) {
    return { status: null, detail: '', kind: 'network' }
  }
  // Anything else is a defect rather than a condition. Keep the real error on
  // the console so the next occurrence can actually be diagnosed instead of
  // disappearing behind a friendly sentence.
  console.error(`[Reassessments] ${context} failed unexpectedly`, error)
  return { status: null, detail: '', kind: 'fault' }
}

const SESSION_EXPIRED =
  'You are not signed in any more, so nothing was sent. Sign in again, then repeat this.'

const SERVICE_UNREACHABLE =
  'The Command Center could not be reached, so nothing was sent. Check your connection, then try again.'

const UNEXPECTED_FAULT =
  'Something went wrong on this screen and nothing was sent. Your connection and sign-in are fine. Reload the page and try again; if it keeps happening, share the details for support with your platform team.'

/** What to tell the operator when starting a reassessment did not work. */
export function startRunMessage(error: unknown): string {
  const { status, detail, kind } = classify(error, 'Starting a reassessment')

  if (kind === 'network') return SERVICE_UNREACHABLE
  if (kind === 'fault') return UNEXPECTED_FAULT
  if (kind === 'auth') return SESSION_EXPIRED

  if (status === 503) {
    if (detail.includes('hr data')) {
      return 'The HR records service is unavailable right now, so no reassessment was started. Try again in a few minutes.'
    }
    return 'The automated workflow service is not connected, so no reassessment was started. Nothing was changed. Ask your platform administrator to restore the connection, then try again.'
  }

  if (status === 502) {
    return 'The HR records could not be read or written just now, so no reassessment was started. Nothing was changed. Try again in a few minutes.'
  }

  if (status === 409) {
    return 'These details were changed after this request had already been sent once, so nothing new was started. Choose "Start a separate reassessment" to send them as a new request.'
  }

  if (status === 403) {
    if (detail.includes('cohort') || detail.includes('direct report')) {
      if (detail.includes('managers may only')) {
        return 'Your access covers your own direct reports only, not a whole cohort, so nothing was started. Reassess one of your reports instead.'
      }
      return 'That employee is not one of your direct reports, so nothing was started. Choose someone who reports to you.'
    }
    return 'Your account is not allowed to start a reassessment, so nothing was started. Ask an HR administrator to grant you access.'
  }

  if (status === 404) {
    if (detail.includes('cohort')) {
      return 'No cohort with that name exists in the HR records, so nothing was started. Check the spelling and try again.'
    }
    return 'No employee with that ID exists in the HR records, so nothing was started. Check the ID and try again.'
  }

  if (status === 422) {
    if (detail.includes('reason')) {
      return 'That reason is not on the approved list, so nothing was started. Pick a reason from the list and submit again.'
    }
    return 'The request was incomplete, so nothing was started. Check the employee or cohort you chose and submit again.'
  }

  return 'The reassessment could not be started and nothing was changed. Try again; if it keeps happening, share the details for support below with your platform team.'
}

/** What to tell the operator when stopping a reassessment did not work. */
export function cancelRunMessage(error: unknown): string {
  const { status, detail, kind } = classify(error, 'Stopping a reassessment')

  if (kind === 'network') {
    return 'The Command Center could not be reached, so the stop request was not sent and the reassessment is still running. Check your connection, then try again.'
  }
  if (kind === 'fault') {
    return 'Something went wrong on this screen and the stop request was not sent, so the reassessment is still running. Your connection and sign-in are fine. Reload the page and try again.'
  }
  if (kind === 'auth') return SESSION_EXPIRED

  if (status === 409) {
    if (detail.includes('already requested')) {
      return 'A stop request was already sent for this reassessment. It will stop as soon as the step that is running ends.'
    }
    if (detail.includes('terminal state')) {
      return 'The reassessment finished on its own just before the stop request arrived, so nothing was stopped. Its result is shown above.'
    }
    return 'This reassessment has already finished, so there is nothing left to stop.'
  }

  if (status === 403) {
    return 'Your account is not allowed to stop a reassessment. It is still running. Ask an HR administrator or People Ops to stop it.'
  }

  if (status === 404) {
    return 'This reassessment is no longer on record, so there is nothing to stop.'
  }

  if (status === 502) {
    return 'The stop request was recorded, but the workflow service did not confirm it. The reassessment may keep running for a short while. Check again in a minute and tell your platform support team if it has not stopped.'
  }

  if (status === 503) {
    return 'The workflow service is not reachable right now, so the reassessment could not be stopped. Try again in a few minutes.'
  }

  return 'The reassessment could not be stopped, and it is still running. Try again; if it keeps happening, share the details for support below with your platform team.'
}

/** What to tell the operator when a run could not be opened or refreshed. */
export function loadRunMessage(error: unknown): string {
  const { status, kind } = classify(error, 'Opening a reassessment')

  if (kind === 'network') {
    return 'The Command Center could not be reached, so this reassessment cannot be shown right now. It keeps running on the server. Check your connection, then try again.'
  }
  if (kind === 'fault') {
    return 'Something went wrong on this screen, so this reassessment cannot be shown right now. It keeps running on the server. Reload the page to try again.'
  }
  if (kind === 'auth') return SESSION_EXPIRED
  if (status === 403) {
    return 'You do not have access to that reassessment, so it cannot be shown here.'
  }
  if (status === 404) {
    return 'No reassessment matches that reference. Check that you copied all of it.'
  }
  if (status === 502 || status === 503) {
    return 'The HR records service is unavailable right now, so this reassessment cannot be shown. Try again in a few minutes.'
  }
  return 'This reassessment could not be opened. Try again in a moment.'
}

/* -------------------------------------------------------------------------- */
/* The start form                                                              */
/* -------------------------------------------------------------------------- */

export type StartRunValues = {
  scope: RunScope
  employeeId: string
  cohort: string
  /** `null` means "no specific reason", which the API accepts. */
  reasonCode: string | null
}

export const EMPTY_START_VALUES: StartRunValues = {
  scope: 'employee',
  employeeId: '',
  cohort: '',
  reasonCode: null,
}

export function isStartRunValid(values: StartRunValues): boolean {
  return values.scope === 'employee'
    ? values.employeeId.trim().length > 0
    : values.cohort.trim().length > 0
}

/**
 * The request body. Only the field belonging to the chosen scope is sent, so
 * the "both an employee and a cohort" combination the API rejects can never be
 * produced from this screen.
 */
export function startRunPayload(values: StartRunValues) {
  const reason_code = values.reasonCode ?? undefined
  return values.scope === 'employee'
    ? { scope: 'employee' as const, employee_id: values.employeeId.trim(), reason_code }
    : { scope: 'cohort' as const, cohort: values.cohort.trim(), reason_code }
}

/**
 * A stable fingerprint of one operator intent. The same intent reuses the same
 * idempotency key, so a double submit returns the run that already exists
 * instead of starting a second one.
 */
export function startRunSignature(values: StartRunValues): string {
  return JSON.stringify([
    values.scope,
    values.scope === 'employee' ? values.employeeId.trim() : '',
    values.scope === 'cohort' ? values.cohort.trim() : '',
    values.reasonCode ?? '',
  ])
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `intent-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

/* -------------------------------------------------------------------------- */
/* Local history of runs started from this browser                             */
/* -------------------------------------------------------------------------- */

export type RunHistoryEntry = {
  command_id: string
  scope: RunScope
  employee_id?: string | null
  cohort?: string | null
  requested_reason?: string | null
  created_at: string
}

const HISTORY_LIMIT = 12

function historyKey(owner: string): string {
  return `autopilot.hr.reassessments.${owner}`
}

export function loadRunHistory(owner: string): RunHistoryEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(historyKey(owner))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (entry): entry is RunHistoryEntry =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as RunHistoryEntry).command_id === 'string'
      )
      .slice(0, HISTORY_LIMIT)
  } catch {
    return []
  }
}

function writeRunHistory(owner: string, entries: RunHistoryEntry[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      historyKey(owner),
      JSON.stringify(entries.slice(0, HISTORY_LIMIT))
    )
  } catch {
    /* A browser with storage disabled simply keeps no local history. */
  }
}

export function rememberRun(
  owner: string,
  entry: RunHistoryEntry
): RunHistoryEntry[] {
  const next = [
    entry,
    ...loadRunHistory(owner).filter(
      (item) => item.command_id !== entry.command_id
    ),
  ].slice(0, HISTORY_LIMIT)
  writeRunHistory(owner, next)
  return next
}

export function forgetRun(owner: string, commandId: string): RunHistoryEntry[] {
  const next = loadRunHistory(owner).filter(
    (item) => item.command_id !== commandId
  )
  writeRunHistory(owner, next)
  return next
}

export function historyEntryFromRun(run: RunRecord): RunHistoryEntry {
  return {
    command_id: run.command_id,
    scope: run.scope === 'cohort' ? 'cohort' : 'employee',
    employee_id: run.employee_id ?? null,
    cohort: run.cohort ?? null,
    requested_reason: run.requested_reason ?? null,
    created_at: run.created_at ?? new Date().toISOString(),
  }
}
