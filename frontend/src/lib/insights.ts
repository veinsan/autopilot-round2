/**
 * Domain vocabulary for the HR insights view.
 *
 * Every sentence exported here is written for the HR operator, not for an
 * engineer. Status codes, exception text, payload field names and raw reason
 * codes never appear in a returned string.
 *
 * The module also mirrors the backend's role contract, because a number is
 * misleading unless the screen can also say which population it was counted
 * over. The mirrored rules are kept identical to the server so the sentence and
 * the figure can never disagree.
 */

import { ApiError } from '@/lib/api-client'

/* -------------------------------------------------------------------------- */
/* Shapes returned by the two insight endpoints                                */
/* -------------------------------------------------------------------------- */

export type CaseMetrics = {
  as_of: string
  refreshed_at: string
  policy_version: string | null
  cohort: string | null
  open_case_count: number
  open_cases_by_type: Record<string, number>
  /** Open cases. */
  numerator: number
  /** Every case recorded for the scoped population, open or resolved. */
  denominator: number
}

export type CohortBottleneck = {
  dependency_team: string
  reason_code: string
  affected_workers: number
  affected_percent: number
  recommended_action: string
}

export type OperationalTwin = {
  as_of: string
  refreshed_at: string
  policy_version: string | null
  cohort: string | null
  /** People in scope for this analysis. */
  denominator: number
  /** Smallest group the active policy allows to be reported on. */
  minimum_cohort_size: number
  suppressed: boolean
  thresholds?: { minimum_workers: number; minimum_percent: number }
  bottlenecks: CohortBottleneck[]
}

/**
 * One case from the governed queue, as the case list returns it.
 *
 * This is the SAME population the figures above are counted over — the server
 * applies an identical payroll scope and manager narrowing to both — so the two
 * presentations are one dataset at two levels of detail, not two datasets.
 * `priority` and `created_at` are stored columns, which is why the matrix can be
 * built from them without inventing a score.
 */
export type WorkbenchCase = {
  case_id: string
  created_at?: string | null
  employee_id?: string | null
  case_type: string
  priority: string
  status: string
}

/**
 * What a section of the screen currently knows. `restricted` is deliberately
 * not a kind of failure: an account that may not read something is a normal
 * state of the product, and it is worded and styled as one.
 */
export type Loadable<T> =
  | { status: 'loading' }
  /**
   * `staleNotice` is set when a later refresh failed. The figures already on
   * screen are kept rather than blanked, and the sentence says why they have
   * not moved.
   */
  | { status: 'ready'; data: T; staleNotice?: string }
  | { status: 'restricted' }
  | { status: 'failed'; message: string }

/* -------------------------------------------------------------------------- */
/* Which presentation the reader chose                                         */
/* -------------------------------------------------------------------------- */

/** Two presentations of one dataset, not two datasets. */
export type InsightsView = 'breakdown' | 'matrix'

const VIEW_STORAGE_KEY = 'autopilot.hr.insights.view'

/**
 * Read on the client only, after mount, so the server-rendered markup and the
 * first client render always agree.
 */
export function loadInsightsView(): InsightsView {
  if (typeof window === 'undefined') return 'breakdown'
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'matrix'
      ? 'matrix'
      : 'breakdown'
  } catch {
    return 'breakdown'
  }
}

export function saveInsightsView(view: InsightsView): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view)
  } catch {
    /* A browser with storage disabled simply starts on the default view. */
  }
}

/* -------------------------------------------------------------------------- */
/* The role contract, mirrored from the backend                                */
/* -------------------------------------------------------------------------- */

/** Which case domains the server will return for this role set. */
export type CaseDomainScope = 'all' | 'payroll_only' | 'exclude_payroll'

/** Confidential access never widens standard HR capabilities. */
export function isManagerScoped(roles: ReadonlySet<string>): boolean {
  return roles.has('manager') && !roles.has('admin') && !roles.has('people_ops')
}

export function caseDomainScope(roles: ReadonlySet<string>): CaseDomainScope {
  if (roles.has('admin')) return 'all'
  if (
    roles.has('people_ops_payroll') &&
    !roles.has('manager') &&
    !roles.has('people_ops')
  ) {
    return 'payroll_only'
  }
  return 'exclude_payroll'
}

/** Roles the case-figures endpoint accepts. */
export function mayReadCaseMetrics(roles: ReadonlySet<string>): boolean {
  return (
    roles.has('admin') ||
    roles.has('people_ops') ||
    roles.has('people_ops_payroll') ||
    roles.has('manager')
  )
}

/**
 * Roles the cohort analysis accepts. A dedicated payroll reviewer may read the
 * case figures but not this, so the request is never sent on their behalf.
 */
export function mayReadCohortTwin(roles: ReadonlySet<string>): boolean {
  return roles.has('admin') || roles.has('people_ops') || roles.has('manager')
}

/** A short noun phrase naming the population behind the case figures. */
export function caseMetricsPopulation(roles: ReadonlySet<string>): string {
  if (isManagerScoped(roles)) return 'the people who report to you'
  if (caseDomainScope(roles) === 'payroll_only') {
    return 'the restricted payroll queue'
  }
  return 'everyone in the HR records'
}

/** The full explanation of what is and is not counted. */
export function caseMetricsScopeSentence(roles: ReadonlySet<string>): string {
  if (isManagerScoped(roles)) {
    return 'These figures cover the people who report to you. Payroll cases are handled in a separate restricted queue and are not counted here.'
  }
  if (caseDomainScope(roles) === 'payroll_only') {
    return 'These figures cover payroll cases only. Every other kind of case belongs to People Ops and is not counted here.'
  }
  if (roles.has('admin')) {
    return 'These figures cover everyone in the HR records, including payroll cases.'
  }
  return 'These figures cover everyone in the HR records. Payroll cases are handled in a separate restricted queue and are not counted here.'
}

/** A short noun phrase naming the population behind the cohort analysis. */
export function cohortPopulation(
  roles: ReadonlySet<string>,
  cohort: string | null
): string {
  const scoped = isManagerScoped(roles)
  if (cohort && scoped) return `your reports in the ${quoted(cohort)} group`
  if (cohort) return `the ${quoted(cohort)} group`
  if (scoped) return 'the people who report to you'
  return 'everyone in the HR records'
}

function quoted(value: string): string {
  return `“${value}”`
}

/* -------------------------------------------------------------------------- */
/* Case types                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The governed case-type registry in the operator's words. An unrecognized key
 * is never shown as it was stored.
 */
const CASE_TYPE_LABELS: Record<string, string> = {
  onboarding: 'Onboarding',
  provisioning: 'Provisioning',
  compliance: 'Compliance',
  work_authorization: 'Work authorization',
  payroll: 'Payroll',
  day_one_readiness: 'Day-1 readiness',
  learning: 'Learning',
  manager_accountability: 'Manager accountability',
  engagement: 'Engagement',
  data_quality: 'Data quality',
  system_exception: 'Operational exceptions',
}

export function caseTypeLabel(key: string): string {
  return CASE_TYPE_LABELS[key] ?? 'Other work'
}

/* -------------------------------------------------------------------------- */
/* The priority x time matrix                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Both axes are read straight off stored columns. Nothing here is scored,
 * weighted or combined:
 *
 *  - the row comes from `priority`, which the database constrains to exactly
 *    these four values, so the ladder is the product's own, not this file's;
 *  - the column comes from the elapsed time between the case's own start
 *    timestamp and the instant the figures were counted.
 *
 * The only authored choice is where the calendar bands are cut, and the UI says
 * so in plain words next to the grid.
 */
export const CASE_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const
export type CasePriority = (typeof CASE_PRIORITIES)[number]

/** A stored priority outside the governed four is shown, never re-labelled. */
export const UNRECORDED_PRIORITY = 'unrecorded'
export type MatrixRowKey = CasePriority | typeof UNRECORDED_PRIORITY

const PRIORITY_LABELS: Record<MatrixRowKey, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  [UNRECORDED_PRIORITY]: 'Not recorded',
}

export function priorityLabel(key: MatrixRowKey): string {
  return PRIORITY_LABELS[key]
}

/** Only critical and high are called out; the rest stay in neutral ink. */
export function isActingPriority(key: MatrixRowKey): boolean {
  return key === 'critical' || key === 'high'
}

export type AgeBand = {
  key: string
  label: string
  /** Exclusive upper bound in whole days since the case was raised. */
  belowDays: number
}

export const AGE_BANDS: readonly AgeBand[] = [
  { key: 'today', label: 'Today', belowDays: 1 },
  { key: 'days-1-3', label: '1–3 days', belowDays: 4 },
  { key: 'days-4-7', label: '4–7 days', belowDays: 8 },
  {
    key: 'over-a-week',
    label: 'Over a week',
    belowDays: Number.POSITIVE_INFINITY,
  },
]

/** Cases older than this many days count toward the "act first" headline. */
const ACT_FIRST_BELOW_DAYS = 4

export function isOpenCase(item: WorkbenchCase): boolean {
  return item.status !== 'resolved'
}

/** Whole days a case has been open, or `null` when it carries no start time. */
export function caseAgeDays(
  item: WorkbenchCase,
  referenceIso: string
): number | null {
  if (!item.created_at) return null
  const created = new Date(item.created_at).getTime()
  const reference = new Date(referenceIso).getTime()
  if (Number.isNaN(created) || Number.isNaN(reference)) return null
  return Math.max(0, Math.floor((reference - created) / 86_400_000))
}

/** How long one case has been waiting, as a phrase that reads in a sentence. */
export function openForPhrase(days: number | null): string {
  if (days === null) return 'open for an unrecorded length of time'
  if (days < 1) return 'raised today'
  return days === 1 ? 'open for 1 day' : `open for ${days} days`
}

function bandIndexFor(days: number): number {
  return AGE_BANDS.findIndex((band) => days < band.belowDays)
}

export type MatrixCell = {
  row: MatrixRowKey
  band: AgeBand
  cases: WorkbenchCase[]
  /** True for the older, higher-priority corner this view exists to surface. */
  actFirst: boolean
}

export type PriorityMatrix = {
  rows: MatrixRowKey[]
  bands: readonly AgeBand[]
  cellAt: (row: MatrixRowKey, bandKey: string) => MatrixCell
  /** Open cases placed on the grid. */
  placed: number
  /** Open cases with no start time recorded, which cannot be placed. */
  unplaced: number
  /** The busiest cell, used to scale the shading. */
  busiest: number
  /** Open, critical or high, and open longer than the act-first cut. */
  actFirstCount: number
}

/**
 * Group the open cases into the grid. Resolved cases are left out because there
 * is nothing left to act on, which also keeps the grid total equal to the open
 * count shown above it.
 */
export function buildPriorityMatrix(
  cases: WorkbenchCase[],
  referenceIso: string
): PriorityMatrix {
  const open = cases.filter(isOpenCase)
  const buckets = new Map<string, WorkbenchCase[]>()
  const usedRows = new Set<MatrixRowKey>()
  let unplaced = 0

  for (const item of open) {
    const stored = String(item.priority ?? '').toLowerCase()
    const row: MatrixRowKey = (CASE_PRIORITIES as readonly string[]).includes(
      stored
    )
      ? (stored as CasePriority)
      : UNRECORDED_PRIORITY
    const days = caseAgeDays(item, referenceIso)
    if (days === null) {
      unplaced += 1
      continue
    }
    const band = AGE_BANDS[bandIndexFor(days)]
    usedRows.add(row)
    const key = `${row}|${band.key}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }

  // The four governed rows are always drawn so the ladder stays readable even
  // when a rung is empty; "Not recorded" appears only if something landed there.
  const rows: MatrixRowKey[] = [...CASE_PRIORITIES]
  if (usedRows.has(UNRECORDED_PRIORITY)) rows.push(UNRECORDED_PRIORITY)

  const cellAt = (row: MatrixRowKey, bandKey: string): MatrixCell => {
    const band = AGE_BANDS.find((item) => item.key === bandKey) ?? AGE_BANDS[0]
    return {
      row,
      band,
      cases: buckets.get(`${row}|${band.key}`) ?? [],
      actFirst: isActingPriority(row) && band.belowDays > ACT_FIRST_BELOW_DAYS,
    }
  }

  let busiest = 0
  let actFirstCount = 0
  for (const row of rows) {
    for (const band of AGE_BANDS) {
      const cell = cellAt(row, band.key)
      busiest = Math.max(busiest, cell.cases.length)
      if (cell.actFirst) actFirstCount += cell.cases.length
    }
  }

  return {
    rows,
    bands: AGE_BANDS,
    cellAt,
    placed: open.length - unplaced,
    unplaced,
    busiest,
    actFirstCount,
  }
}

/** The one sentence that makes every placement explicable. */
export const MATRIX_DERIVATION =
  'Each case sits in the row of the priority recorded on it and the column for how long it has been open, counted from when the case was raised to the moment these figures were counted. Nothing is scored, weighted or predicted.'

export function actFirstSentence(matrix: PriorityMatrix): string {
  if (matrix.actFirstCount === 0) {
    return 'No open case is both critical or high priority and more than three days old.'
  }
  const cases = matrix.actFirstCount === 1 ? 'case is' : 'cases are'
  return `${matrix.actFirstCount} open ${cases} critical or high priority and more than three days old.`
}

/**
 * The two presentations must never contradict each other. The list and the
 * counted figures are separate reads of the same table, so a refresh in between
 * can leave them a case apart; when that happens the screen says so rather than
 * showing two numbers that quietly disagree.
 */
export function reconcileCaseViews(
  cases: WorkbenchCase[],
  metrics: CaseMetrics | null
): string | null {
  if (!metrics) return null
  const open = cases.filter(isOpenCase).length
  if (
    open === metrics.open_case_count &&
    cases.length === metrics.denominator
  ) {
    return null
  }
  return `The counted figures and the case list were read a moment apart, so they do not line up exactly: the list holds ${open} open ${open === 1 ? 'case' : 'cases'} against the ${metrics.open_case_count} counted above. Refresh to bring them back into step.`
}

export type CaseTypeShare = {
  key: string
  label: string
  count: number
  /** Share of the open cases, 0–100. */
  percent: number
}

/** Open cases per type, largest first, with each one's share of the backlog. */
export function caseTypeBreakdown(metrics: CaseMetrics): CaseTypeShare[] {
  const total = Object.values(metrics.open_cases_by_type).reduce(
    (sum, count) => sum + count,
    0
  )
  return Object.entries(metrics.open_cases_by_type)
    .map(([key, count]) => ({
      key,
      label: caseTypeLabel(key),
      count,
      percent: total > 0 ? (count * 100) / total : 0,
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.label.localeCompare(right.label)
    )
}

/** Share of every recorded case that is still open, 0–100, or null if none. */
export function openShare(metrics: CaseMetrics): number | null {
  if (metrics.denominator <= 0) return null
  return (metrics.numerator * 100) / metrics.denominator
}

/* -------------------------------------------------------------------------- */
/* The four meanings a cohort result can carry                                 */
/* -------------------------------------------------------------------------- */

/**
 * `empty`    nobody is in scope, so there was nothing to analyze
 * `withheld` the group is smaller than the policy's reporting minimum
 * `clear`    the group was analyzed and no shared blocker met the thresholds
 * `findings` at least one team is holding up enough of the group to report
 *
 * These are four different meanings and the screen must never let them look
 * alike: `withheld` in particular is a privacy control, not an absence of
 * problems and not a failure.
 */
export type CohortOutcome = 'empty' | 'withheld' | 'clear' | 'findings'

export function cohortOutcome(twin: OperationalTwin): CohortOutcome {
  if (twin.denominator <= 0) return 'empty'
  if (twin.suppressed) return 'withheld'
  return twin.bottlenecks.length > 0 ? 'findings' : 'clear'
}

/** Why nobody was in scope, which depends on whether a group was chosen. */
export function emptyScopeSentence(
  roles: ReadonlySet<string>,
  cohort: string | null
): string {
  if (cohort && isManagerScoped(roles)) {
    return `None of the people who report to you belong to the ${quoted(cohort)} group, so there was nothing to analyze. Check the group name, or clear it to look at all of your reports together.`
  }
  if (cohort) {
    return `Nobody in the HR records belongs to the ${quoted(cohort)} group, so there was nothing to analyze. Check the group name, or clear it to look at everyone together.`
  }
  if (isManagerScoped(roles)) {
    return 'Nobody is currently recorded as reporting to you, so there was nothing to analyze. If that looks wrong, ask People Ops to check your reporting line in the HR records.'
  }
  return 'No people are recorded in the HR records yet, so there was nothing to analyze. This view fills in once workers have been loaded.'
}

/** The k-anonymity suppression, explained as a protection rather than a fault. */
export function withheldSentence(twin: OperationalTwin): string {
  const people = twin.denominator === 1 ? 'person' : 'people'
  return `Only ${twin.denominator} ${people} are in this group. Results are reported for groups of ${twin.minimum_cohort_size} or more so that a finding can never be traced back to one individual, so nothing is shown for this group.`
}

/** What was actually checked when the analysis came back clear. */
export function clearSentence(twin: OperationalTwin): string {
  const people = twin.denominator === 1 ? 'person' : 'people'
  return `All ${twin.denominator} ${people} in this group were checked, and no team is holding up enough of them to report.`
}

/** The bar a team has to clear before it is named. `null` when unknown. */
export function thresholdSentence(twin: OperationalTwin): string | null {
  if (!twin.thresholds) return null
  const workers = twin.thresholds.minimum_workers
  const held = workers === 1 ? 'person' : 'people'
  return `A team is named once it is holding up at least ${workers} ${held} and at least ${twin.thresholds.minimum_percent}% of the group.`
}

/** What the listed teams mean, shown above the findings. */
export function findingsSentence(twin: OperationalTwin): string {
  const teams = twin.bottlenecks.length
  const people = twin.denominator === 1 ? 'person' : 'people'
  return `${teams === 1 ? 'One team is' : `${teams} teams are`} holding up enough of this group to report. Every share below is measured against the ${twin.denominator} ${people} in scope.`
}

/** Biggest blocker first, so the row that drives a decision leads. */
export function rankedBottlenecks(twin: OperationalTwin): CohortBottleneck[] {
  return [...twin.bottlenecks].sort(
    (left, right) =>
      right.affected_workers - left.affected_workers ||
      right.affected_percent - left.affected_percent ||
      left.dependency_team.localeCompare(right.dependency_team)
  )
}

/* -------------------------------------------------------------------------- */
/* Provenance                                                                  */
/* -------------------------------------------------------------------------- */

/** What the recorded policy version means for the case figures. */
export function caseMetricsProvenanceHint(version: string | null): string {
  return version
    ? 'Counted while this governed policy version was active, so the figures can be reconciled against it later.'
    : 'No policy version is active right now, so these figures cannot be tied to a governed version.'
}

/** What the recorded policy version means for the cohort analysis. */
export function cohortProvenanceHint(version: string | null): string {
  return version
    ? 'The smallest reportable group size and the thresholds a team must cross both come from this governed policy version.'
    : 'No policy version is active right now, so the built-in safety minimums were used instead.'
}

export function formatMoment(value?: string | null): string {
  if (!value) return 'Not recorded'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? 'Not recorded'
    : parsed.toLocaleString()
}

/* -------------------------------------------------------------------------- */
/* Failure wording                                                             */
/* -------------------------------------------------------------------------- */

type Classified = { status: number | null; offline: boolean }

function classify(error: unknown): Classified {
  if (error instanceof ApiError) {
    return { status: error.status, offline: false }
  }
  return { status: null, offline: true }
}

/** A refusal by role is a state of the screen, not a failure to report. */
export function isAccessRefusal(error: unknown): boolean {
  return classify(error).status === 403
}

const SESSION_EXPIRED =
  'Your sign-in has expired, so nothing could be loaded. Sign in again and the figures will come back.'

const UNREACHABLE =
  'The Command Center could not be reached, so nothing could be loaded. Check your connection and try again.'

/** What to tell the operator when the case figures could not be read. */
export function caseMetricsFailure(error: unknown): string {
  const { status, offline } = classify(error)

  if (offline) return UNREACHABLE
  if (status === 401) return SESSION_EXPIRED
  if (status === 403) {
    return 'Your account is not allowed to see case figures. Ask an HR administrator to grant you access.'
  }
  if (status === 502) {
    return 'The HR records could not be read just now, so the case figures are not available. Nothing is wrong with the cases themselves. Try again in a few minutes.'
  }
  if (status === 503) {
    return 'The HR records service is not available right now, so the case figures could not be loaded. Try again in a few minutes.'
  }
  return 'The case figures could not be loaded. Try again in a moment; if it keeps happening, tell your platform support team.'
}

/** What to tell the operator when the case list behind the matrix failed. */
export function caseQueueFailure(error: unknown): string {
  const { status, offline } = classify(error)

  if (offline) return UNREACHABLE
  if (status === 401) return SESSION_EXPIRED
  if (status === 403) {
    return 'Your account is not allowed to open the case list, so the matrix cannot be drawn. The counted figures above are unaffected.'
  }
  if (status === 502 || status === 503) {
    return 'The case list could not be read just now, so the matrix cannot be drawn. The counted figures above still stand. Try again in a few minutes.'
  }
  return 'The case list could not be read, so the matrix cannot be drawn. Try again in a moment; if it keeps happening, tell your platform support team.'
}

/** What to tell the operator when the cohort analysis could not be read. */
export function cohortTwinFailure(error: unknown): string {
  const { status, offline } = classify(error)

  if (offline) return UNREACHABLE
  if (status === 401) return SESSION_EXPIRED
  if (status === 403) {
    return 'Your account is not allowed to see the cohort analysis. Ask an HR administrator to grant you access.'
  }
  if (status === 502) {
    return 'The HR records could not be read just now, so this group could not be analyzed. Try again in a few minutes.'
  }
  if (status === 503) {
    return 'The HR records service is not available right now, so this group could not be analyzed. Try again in a few minutes.'
  }
  return 'This group could not be analyzed. Try again in a moment; if it keeps happening, tell your platform support team.'
}
