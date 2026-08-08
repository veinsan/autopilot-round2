'use client'

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useSession } from 'next-auth/react'
import apiClient from '@/lib/api-client'
import { reasonCodeLabel } from '@/lib/runs'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Icons } from '@/components/ui/icons'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type Policy = {
  version_id: string
  status: string
  created_at: string
  change_summary: string
  activated_at?: string
  parent_version_id?: string
  created_by?: string
  snapshot_hash?: string
  hidden_at?: string | null
  hidden_by?: string | null
}

type PolicyDetail = Policy & { config_snapshot: Record<string, unknown> }

type SimulationResult = {
  workers_evaluated: number
  active_policy_version: string | null
  candidate_findings_by_code: Record<string, number>
  delta_by_code: Record<string, number>
}

/** Stored keys. `IN` is India. Nothing here may be added or renamed from the UI. */
const jurisdictions = ['default', 'MY', 'SG', 'AU', 'IN', 'PH'] as const

const countryJurisdictions = jurisdictions.filter(
  (jurisdiction) => jurisdiction !== 'default'
)

/**
 * What the reader sees. Country names in full: the stored keys are codes, and
 * Windows has no flag font, so an emoji flag renders as the bare letters.
 */
const jurisdictionLabels: Record<string, string> = {
  default: 'Everywhere else',
  MY: 'Malaysia',
  SG: 'Singapore',
  AU: 'Australia',
  IN: 'India',
  PH: 'Philippines',
}

const registeredReasonCodes = [
  'MISSING_DAY_ONE_ACCESS',
  'STALLED_COMPLIANCE_DOC',
  'TASK_ALREADY_ESCALATED',
  'PROVISIONING_DELAYED',
  'LOW_ENGAGEMENT_SCORE',
  'SENSITIVE_DISCLOSURE_DETECTED',
  'COMPLIANCE_DEADLINE_AT_RISK',
  'COMPLIANCE_LEGAL_BREACH',
  'WORK_AUTH_EXPIRY_AT_RISK',
  'WORK_AUTH_EXPIRED',
  'PAYROLL_ERROR_DETECTED',
  'PAYROLL_NOT_CONFIRMED',
  'PAYROLL_RECORD_MISSING',
  'DAY_ONE_DEPENDENCY_BLOCKED',
  'LEARNING_MILESTONE_OVERDUE',
  'MANAGER_ACKNOWLEDGMENT_OVERDUE',
  'MANAGER_ACTION_OVERDUE',
  'COHORT_DEPENDENCY_BOTTLENECK',
]

/**
 * Settings that can differ by country. The stored keys are unchanged; the
 * headings and field labels are the words an HR manager would use.
 */
const thresholdGroups = [
  {
    id: 'compliance',
    title: 'Documents and work permits',
    description: 'How early a deadline should start showing up as a warning.',
    fields: [
      [
        'compliance_at_risk_days',
        'Warn this many days before a document is due',
      ],
      [
        'work_auth_expiry_at_risk_days',
        'Warn this many days before a work permit runs out',
      ],
    ],
  },
  {
    id: 'payroll',
    title: 'First pay',
    description: 'How long after a start date first pay must be confirmed.',
    fields: [
      [
        'first_payroll_cutoff_days',
        'Confirm first pay within this many days of the start date',
      ],
    ],
  },
  {
    id: 'manager',
    title: 'Manager follow-up',
    description: 'How fast a manager has to respond, and how often we remind.',
    fields: [
      ['nudge_cadence_days', 'Days between reminders'],
      [
        'manager_acknowledgment_deadline_days',
        'Days a manager has to confirm they have seen it',
      ],
      ['manager_action_deadline_days', 'Days a manager has to act on it'],
      ['manager_max_reminders', 'Most reminders to send'],
    ],
  },
] as const

/** These are the same everywhere and are never set per country. */
const globalThresholds = [
  ['bottleneck_min_workers', 'People affected before we call it a hold-up'],
  ['bottleneck_min_percent', 'Share of the group affected (%)'],
  ['minimum_cohort_size', 'Smallest group we report on'],
] as const

function parseSnapshot(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The advanced settings box does not hold a whole policy.')
  }
  return parsed as Record<string, unknown>
}

function thresholdValue(
  snapshot: string,
  key: string,
  jurisdiction?: string
): string {
  try {
    const parsed = parseSnapshot(snapshot)
    const thresholds = parsed.thresholds
    if (
      !thresholds ||
      typeof thresholds !== 'object' ||
      Array.isArray(thresholds)
    )
      return ''
    const value = (thresholds as Record<string, unknown>)[key]
    if (jurisdiction) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
      return String((value as Record<string, unknown>)[jurisdiction] ?? '')
    }
    return typeof value === 'number' ? String(value) : ''
  } catch {
    return ''
  }
}

/**
 * Which countries carry a value of their own. A country value keeps working
 * whether or not the screen is showing it, so the screen has to say so.
 */
function countriesWithOwnValue(
  snapshot: string,
  keys: readonly string[]
): string[] {
  return countryJurisdictions.filter((country) =>
    keys.some((key) => thresholdValue(snapshot, key, country) !== '')
  )
}

function listSentence(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/* -------------------------------------------------------------------------- */
/* Reading and writing any setting in the draft                                */
/*                                                                            */
/* Every control in this policy is reachable through one of these, so nobody   */
/* has to open the text box to change how the checks behave.                   */
/* -------------------------------------------------------------------------- */

function readPath(snapshot: string, path: readonly string[]): unknown {
  try {
    let node: unknown = parseSnapshot(snapshot)
    for (const key of path) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
      node = (node as Record<string, unknown>)[key]
    }
    return node
  } catch {
    return undefined
  }
}

/** Returns the draft as text with one value replaced. Throws on invalid text. */
function writePath(
  snapshot: string,
  path: readonly string[],
  value: unknown
): string {
  const root = parseSnapshot(snapshot)
  let node = root
  for (const key of path.slice(0, -1)) {
    const next = node[key]
    node[key] =
      next && typeof next === 'object' && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : {}
    node = node[key] as Record<string, unknown>
  }
  const last = path[path.length - 1]
  if (value === undefined) delete node[last]
  else node[last] = value
  return JSON.stringify(root, null, 2)
}

function stringAt(snapshot: string, path: readonly string[]): string {
  const value = readPath(snapshot, path)
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : ''
}

function listAt(snapshot: string, path: readonly string[]): string[] {
  const value = readPath(snapshot, path)
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

type SettingProps = {
  snapshot: string
  path: readonly string[]
  label: string
  hint?: string
  disabled?: boolean
  onChange: (path: readonly string[], value: unknown) => void
}

function NumberSetting({
  snapshot,
  path,
  label,
  hint,
  disabled,
  onChange,
  step,
  max,
  suffix,
}: SettingProps & { step?: number; max?: number; suffix?: string }) {
  const id = `setting-${path.join('-')}`
  return (
    <div className='space-y-1'>
      <Label htmlFor={id} className='block text-xs font-normal text-muted-foreground'>
        {label}
      </Label>
      <div className='flex items-center gap-2'>
        <Input
          id={id}
          type='number'
          min={0}
          max={max}
          step={step ?? 1}
          className='w-32'
          disabled={disabled}
          value={stringAt(snapshot, path)}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) =>
            onChange(
              path,
              event.target.value === '' ? undefined : Number(event.target.value)
            )
          }
        />
        {suffix && (
          <span className='text-xs text-muted-foreground'>{suffix}</span>
        )}
      </div>
      {hint && (
        <p id={`${id}-hint`} className='text-xs text-muted-foreground'>
          {hint}
        </p>
      )}
    </div>
  )
}

function TextSetting({
  snapshot,
  path,
  label,
  hint,
  disabled,
  onChange,
  placeholder,
}: SettingProps & { placeholder?: string }) {
  const id = `setting-${path.join('-')}`
  return (
    <div className='space-y-1'>
      <Label htmlFor={id} className='block text-xs font-normal text-muted-foreground'>
        {label}
      </Label>
      <Input
        id={id}
        disabled={disabled}
        placeholder={placeholder}
        value={stringAt(snapshot, path)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) =>
          onChange(path, event.target.value === '' ? undefined : event.target.value)
        }
      />
      {hint && (
        <p id={`${id}-hint`} className='text-xs text-muted-foreground'>
          {hint}
        </p>
      )}
    </div>
  )
}

function TextAreaSetting({
  snapshot,
  path,
  label,
  hint,
  disabled,
  onChange,
}: SettingProps) {
  const id = `setting-${path.join('-')}`
  return (
    <div className='space-y-1'>
      <Label htmlFor={id} className='block text-xs font-normal text-muted-foreground'>
        {label}
      </Label>
      <textarea
        id={id}
        disabled={disabled}
        rows={3}
        className='w-full rounded-lg border border-input bg-white p-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-cornflower/50 disabled:opacity-50'
        value={stringAt(snapshot, path)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) =>
          onChange(path, event.target.value === '' ? undefined : event.target.value)
        }
      />
      {hint && (
        <p id={`${id}-hint`} className='text-xs text-muted-foreground'>
          {hint}
        </p>
      )}
    </div>
  )
}

/** A list of short values, edited a row at a time so nobody types brackets. */
function ListSetting({
  snapshot,
  path,
  label,
  hint,
  disabled,
  onChange,
  numeric,
  addLabel,
}: SettingProps & { numeric?: boolean; addLabel: string }) {
  const items = listAt(snapshot, path)
  const write = (next: string[]) =>
    onChange(
      path,
      numeric ? next.map((item) => Number(item) || 0) : next.filter(Boolean)
    )

  return (
    <div className='space-y-2'>
      <p className='text-xs text-muted-foreground'>{label}</p>
      <div className='space-y-2'>
        {items.map((item, index) => (
          <div key={index} className='flex items-center gap-2'>
            <Input
              value={item}
              type={numeric ? 'number' : 'text'}
              min={numeric ? 0 : undefined}
              disabled={disabled}
              aria-label={`${label}, item ${index + 1}`}
              onChange={(event) => {
                const next = [...items]
                next[index] = event.target.value
                write(next)
              }}
            />
            <Button
              type='button'
              size='icon-sm'
              variant='ghost'
              disabled={disabled}
              aria-label={`Remove item ${index + 1}`}
              onClick={() => write(items.filter((_, at) => at !== index))}
            >
              <Icons.close className='h-4 w-4' />
            </Button>
          </div>
        ))}
        {items.length === 0 && (
          <p className='text-xs text-muted-foreground'>Nothing listed yet.</p>
        )}
      </div>
      <Button
        type='button'
        size='sm'
        variant='outline'
        disabled={disabled}
        onClick={() => write([...items, numeric ? '0' : ''])}
      >
        <Icons.plus className='h-4 w-4' />
        {addLabel}
      </Button>
      {hint && <p className='text-xs text-muted-foreground'>{hint}</p>}
    </div>
  )
}

const statusStyles: Record<string, string> = {
  draft: 'border-amber-200 bg-amber-50 text-amber-800',
  simulated: 'border-blue-200 bg-blue-50 text-blue-800',
  approved: 'border-teal-200 bg-teal-50 text-teal-800',
  active: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  retired: 'border-slate-200 bg-slate-100 text-slate-700',
}

/** The stored value is unchanged; only the word on screen differs. */
const statusLabels: Record<string, string> = {
  draft: 'Draft',
  simulated: 'Tested',
  approved: 'Approved',
  active: 'In force',
  retired: 'Replaced',
}

function PolicyStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${
        statusStyles[status] ?? 'border-gray-200 bg-gray-50 text-gray-700'
      }`}
    >
      {statusLabels[status] ?? status}
    </span>
  )
}

function formatTimestamp(value?: string): string {
  if (!value) return 'Not available'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

const goLiveSteps = [
  {
    title: 'Write a draft',
    detail:
      'Copy the rules in force and change what you need. Nothing happens yet.',
  },
  {
    title: 'Test it',
    detail:
      'See what the change would pick up on today’s people. Nobody is contacted.',
  },
  {
    title: 'Get it approved',
    detail: 'A colleague with approval rights signs the change off.',
  },
  {
    title: 'Make it active',
    detail: 'An admin puts it in force. Every check from then on uses it.',
  },
]

export default function PolicyStudioPage() {
  const { data: session } = useSession()
  const roles = useMemo(() => new Set(session?.roles ?? []), [session?.roles])
  const canDraft = roles.has('admin') || roles.has('people_ops')
  const canApprove = roles.has('admin') || roles.has('people_ops_confidential')
  const isAdmin = roles.has('admin')
  const [policies, setPolicies] = useState<Policy[]>([])
  const [summary, setSummary] = useState('')
  const [snapshot, setSnapshot] = useState('')
  const [baseVersion, setBaseVersion] = useState<string | null>(null)
  /**
   * One place reports what happened, and it says which kind of thing happened:
   * a completed step and a refusal must never look alike or be announced alike.
   */
  const [notice, setNotice] = useState<{
    tone: 'info' | 'problem'
    text: string
  } | null>(null)
  const setMessage = (text: string | null) =>
    setNotice(text ? { tone: 'info', text } : null)
  const setProblem = (text: string) => setNotice({ tone: 'problem', text })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [simulation, setSimulation] = useState<SimulationResult | null>(null)
  /** What the result on screen was measured against. */
  const [simulationScope, setSimulationScope] = useState<{
    asOf: string
    cohort: string
  } | null>(null)
  const [testTarget, setTestTarget] = useState<Policy | null>(null)
  const [testDate, setTestDate] = useState('')
  const [testCohort, setTestCohort] = useState('')
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null)
  const [detailSnapshot, setDetailSnapshot] = useState('')
  const [detailSummary, setDetailSummary] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Policy | null>(null)
  const [draftEditorOpen, setDraftEditorOpen] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  /**
   * Presentation only. A missing entry means "decide from the draft itself", so
   * a draft that already has country values opens with its countries showing.
   * A loaded snapshot clears the map and hands the decision back to the data.
   */
  const [perCountryOpen, setPerCountryOpen] = useState<Record<string, boolean>>(
    {}
  )
  // A simulation answers a question the reader asked, so the answer is where
  // they are sent — it sits in the second column, below everything on a narrow
  // screen.
  const simulationRef = useRef<HTMLHeadingElement>(null)

  const fetchPolicy = useCallback(async (policy: Policy) => {
    const response = await apiClient<PolicyDetail>(
      `/api/hr/policies/${policy.version_id}`
    )
    return response
  }, [])

  const loadSnapshot = useCallback(
    async (policy: Policy) => {
      try {
        const detail = await fetchPolicy(policy)
        setSnapshot(JSON.stringify(detail.config_snapshot, null, 2))
        setBaseVersion(detail.version_id)
        setPerCountryOpen({})
        setMessage(
          `Your draft starts from version ${detail.version_id}. Change what you need, then save it.`
        )
      } catch (error) {
        setBaseVersion(null)
        setProblem(
          error instanceof Error
            ? `The rules in force could not be loaded: ${error.message}`
            : 'The rules in force could not be loaded.'
        )
      }
    },
    [fetchPolicy]
  )

  const openPolicyDetails = async (policy: Policy) => {
    setSelectedPolicy(policy)
    setDetailSummary(policy.change_summary)
    setDetailSnapshot('')
    setDetailLoading(true)
    try {
      const detail = await fetchPolicy(policy)
      setSelectedPolicy(detail)
      setDetailSummary(detail.change_summary)
      setDetailSnapshot(JSON.stringify(detail.config_snapshot, null, 2))
    } catch (error) {
      setProblem(
        error instanceof Error
          ? `This version could not be opened: ${error.message}`
          : 'This version could not be opened.'
      )
      setSelectedPolicy(null)
    } finally {
      setDetailLoading(false)
    }
  }

  const load = useCallback(
    async (withActiveSnapshot = false) => {
      try {
        const result = await apiClient<{ policies: Policy[] }>(
          `/api/hr/policies${showHidden ? '?include_hidden=true' : ''}`
        )
        setPolicies(result.policies)
        if (withActiveSnapshot) {
          const active = result.policies.find(
            (policy) => policy.status === 'active'
          )
          if (active) await loadSnapshot(active)
          else
            setMessage(
              'No version is in force yet, so there is nothing to copy a draft from.'
            )
        }
      } catch (error) {
        setProblem(
          error instanceof Error
            ? error.message
            : 'The list of versions could not be loaded.'
        )
      } finally {
        setLoading(false)
      }
    },
    [loadSnapshot, showHidden]
  )

  useEffect(() => {
    void load(true)
  }, [load])

  const setThreshold = (
    key: string,
    rawValue: string,
    jurisdiction?: string
  ) => {
    try {
      const parsed = parseSnapshot(snapshot)
      const thresholds =
        parsed.thresholds &&
        typeof parsed.thresholds === 'object' &&
        !Array.isArray(parsed.thresholds)
          ? { ...(parsed.thresholds as Record<string, unknown>) }
          : {}
      const value = rawValue === '' ? undefined : Number(rawValue)
      if (jurisdiction) {
        const current =
          thresholds[key] &&
          typeof thresholds[key] === 'object' &&
          !Array.isArray(thresholds[key])
            ? { ...(thresholds[key] as Record<string, unknown>) }
            : {}
        if (value === undefined) delete current[jurisdiction]
        else current[jurisdiction] = value
        thresholds[key] = current
      } else if (value === undefined) {
        delete thresholds[key]
      } else {
        thresholds[key] = value
      }
      parsed.thresholds = thresholds
      setSnapshot(JSON.stringify(parsed, null, 2))
      setMessage(null)
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'That change could not be saved into the draft.'
      )
    }
  }

  /**
   * Turning the toggle off only stops showing the country values — it never
   * removes them. Removing them is this button, and it is explicit.
   */
  const clearCountryValues = (keys: readonly string[]) => {
    try {
      const parsed = parseSnapshot(snapshot)
      const thresholds =
        parsed.thresholds &&
        typeof parsed.thresholds === 'object' &&
        !Array.isArray(parsed.thresholds)
          ? { ...(parsed.thresholds as Record<string, unknown>) }
          : {}
      const affected = keys.filter((key) => {
        const current = thresholds[key]
        return (
          Boolean(current) &&
          typeof current === 'object' &&
          !Array.isArray(current) &&
          countryJurisdictions.some(
            (country) => (current as Record<string, unknown>)[country] != null
          )
        )
      })
      // A country falls back to the "everywhere else" value. Without one there
      // would be no value left, and this screen never invents one.
      const missingDefault = affected.some((key) => {
        const current = thresholds[key] as Record<string, unknown>
        return current.default == null
      })
      if (missingDefault) {
        setProblem(
          'Fill in “Everywhere else” first. Without it, those countries would be left with no value at all.'
        )
        return
      }
      for (const key of affected) {
        const current = thresholds[key] as Record<string, unknown>
        thresholds[key] = { default: current.default }
      }
      parsed.thresholds = thresholds
      setSnapshot(JSON.stringify(parsed, null, 2))
      setMessage(
        'The country values are gone from this draft. Every country now uses the “Everywhere else” value.'
      )
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'The country values could not be removed.'
      )
    }
  }

  // The orgs come from the draft itself, so a team added elsewhere shows up
  // here without this screen having to know about it.
  const managerChannelOrgs = useMemo(() => {
    const value = readPath(snapshot, ['routing', 'manager_channel_by_org'])
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>)
      : []
  }, [snapshot])

  /**
   * Every setting on this screen writes through here, so a change made in a
   * field and a change made in the text box end up in exactly the same place.
   */
  const setPath = (path: readonly string[], value: unknown) => {
    try {
      setSnapshot(writePath(snapshot, path, value))
      setNotice(null)
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'That setting could not be changed.'
      )
    }
  }

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setBusy('create')
    try {
      if (!baseVersion)
        throw new Error(
          'Load the version in force before you save a draft, so the draft has something to start from.'
        )
      const configSnapshot = parseSnapshot(snapshot)
      // Every registered reason must be present or the server refuses the
      // draft, so the list is kept complete here rather than being one more
      // thing to remember.
      const currentCodes = Array.isArray(configSnapshot.reason_codes)
        ? configSnapshot.reason_codes.filter(
            (code): code is string => typeof code === 'string'
          )
        : []
      configSnapshot.reason_codes = Array.from(
        new Set([...currentCodes, ...registeredReasonCodes])
      ).sort()
      await apiClient('/api/hr/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          change_summary: summary,
          config_snapshot: configSnapshot,
        }),
      })
      setMessage(
        'Draft saved. Test it next, then get it approved, then make it active.'
      )
      setSummary('')
      setDraftEditorOpen(false)
      await load()
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'The draft could not be saved.'
      )
    } finally {
      setBusy(null)
    }
  }

  /**
   * A test can be run against a date other than today, which is how you see
   * what a change would do at the next intake rather than at this moment.
   */
  const runTest = async (policy: Policy, on: string, group: string) => {
    setBusy(policy.version_id)
    try {
      const result = await apiClient<{
        as_of: string
        result: SimulationResult
      }>('/api/hr/policies/simulations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version_id: policy.version_id,
          as_of: on ? new Date(`${on}T00:00:00Z`).toISOString() : undefined,
          cohort: group.trim() || undefined,
        }),
      })
      setSimulation(result.result)
      setSimulationScope({ asOf: result.as_of ?? on, cohort: group.trim() })
      setTestTarget(null)
      setMessage(
        `Test finished. ${result.result.workers_evaluated} people were checked. No cases were opened and nobody was contacted.`
      )
      window.setTimeout(() => simulationRef.current?.focus(), 0)
      await load()
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'The test did not run.'
      )
    } finally {
      setBusy(null)
    }
  }

  const advance = async (policy: Policy) => {
    if (policy.status === 'draft') {
      setTestTarget(policy)
      return
    }
    setBusy(policy.version_id)
    try {
      if (policy.status === 'simulated') {
        const result = await apiClient<{ status: string }>(
          `/api/hr/policies/${policy.version_id}/approvals`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'approve' }),
          }
        )
        setMessage(
          result.status === 'approved'
            ? 'Approved. An admin can now make this the active policy.'
            : 'Your approval is recorded. Someone else still has to approve it.'
        )
      } else if (policy.status === 'approved') {
        await apiClient(`/api/hr/policies/${policy.version_id}/activate`, {
          method: 'POST',
        })
        setMessage(
          'This version is now the active policy. Every check from here on uses it.'
        )
      }
      await load()
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'That step did not go through.'
      )
    } finally {
      setBusy(null)
    }
  }

  const rollback = async (policy: Policy) => {
    setBusy(policy.version_id)
    try {
      await apiClient(`/api/hr/policies/${policy.version_id}/rollback`, {
        method: 'POST',
      })
      setMessage(
        'That version was copied into a new draft. It still has to be tested, approved and made active.'
      )
      await load()
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'The copy could not be made into a draft.'
      )
    } finally {
      setBusy(null)
    }
  }

  const saveDraftChanges = async () => {
    if (!selectedPolicy || selectedPolicy.status !== 'draft') return
    setBusy(`edit:${selectedPolicy.version_id}`)
    try {
      const configSnapshot = parseSnapshot(detailSnapshot)
      const editedCodes = Array.isArray(configSnapshot.reason_codes)
        ? configSnapshot.reason_codes.filter(
            (code): code is string => typeof code === 'string'
          )
        : []
      configSnapshot.reason_codes = Array.from(
        new Set([...editedCodes, ...registeredReasonCodes])
      ).sort()
      await apiClient(`/api/hr/policies/${selectedPolicy.version_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          change_summary: detailSummary,
          config_snapshot: configSnapshot,
        }),
      })
      setSelectedPolicy({
        ...selectedPolicy,
        change_summary: detailSummary,
      })
      await load()
      setMessage(`Draft ${selectedPolicy.version_id} was saved.`)
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : 'The draft could not be saved.'
      )
    } finally {
      setBusy(null)
    }
  }

  const setVisibility = async (policy: Policy, hidden: boolean) => {
    setBusy(`visibility:${policy.version_id}`)
    try {
      await apiClient(`/api/hr/policies/${policy.version_id}/visibility`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden }),
      })
      setMessage(
        hidden
          ? `${policy.version_id} is out of this list. It is still stored and still in the history.`
          : `${policy.version_id} is back in this list.`
      )
      await load()
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'That version could not be hidden or brought back.'
      )
    } finally {
      setBusy(null)
    }
  }

  const startDraftFromPolicy = async (policy: Policy) => {
    setBusy(`baseline:${policy.version_id}`)
    try {
      await loadSnapshot(policy)
      setSummary(`Draft based on ${policy.version_id}`)
      setDraftEditorOpen(true)
    } finally {
      setBusy(null)
    }
  }

  const deleteDraft = async () => {
    if (!deleteTarget || deleteTarget.status !== 'draft') return
    const deletedVersion = deleteTarget.version_id
    const deletedWasBaseline = baseVersion === deletedVersion
    setBusy(`delete:${deletedVersion}`)
    try {
      await apiClient(`/api/hr/policies/${deletedVersion}`, {
        method: 'DELETE',
      })
      setDeleteTarget(null)
      setSelectedPolicy(null)
      if (deletedWasBaseline) {
        setBaseVersion(null)
        setSnapshot('')
      }
      await load(deletedWasBaseline)
      setMessage(`Draft ${deletedVersion} was deleted.`)
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'The draft could not be deleted.'
      )
    } finally {
      setBusy(null)
    }
  }

  const useAsDraftBaseline = () => {
    if (!selectedPolicy || !detailSnapshot) return
    setSnapshot(detailSnapshot)
    setBaseVersion(selectedPolicy.version_id)
    setPerCountryOpen({})
    setSummary(`Draft based on ${selectedPolicy.version_id}`)
    setSelectedPolicy(null)
    setDraftEditorOpen(true)
    setMessage(
      `Your draft starts from version ${selectedPolicy.version_id}. Change what you need, then save it.`
    )
  }

  const actionLabel = (policy: Policy) => {
    if (policy.status === 'draft' && canDraft) return 'Test this version'
    if (policy.status === 'simulated' && canApprove)
      return 'Approve this version'
    if (policy.status === 'approved' && isAdmin)
      return 'Make this the active policy'
    return null
  }

  const draftFieldsDisabled = !canDraft || !baseVersion

  const noticeCard = notice ? (
    <Card
      className={
        notice.tone === 'problem'
          ? 'border-destructive/40'
          : 'border-brand-cornflower/30'
      }
    >
      <CardContent
        role={notice.tone === 'problem' ? 'alert' : 'status'}
        className={`flex items-start gap-3 p-4 text-sm ${
          notice.tone === 'problem'
            ? 'text-destructive'
            : 'text-muted-foreground'
        }`}
      >
        {notice.tone === 'problem' ? (
          <Icons.alertTriangle className='mt-0.5 h-4 w-4 shrink-0' />
        ) : (
          <Icons.info className='mt-0.5 h-4 w-4 shrink-0 text-brand-cornflower' />
        )}
        <span>{notice.text}</span>
      </CardContent>
    </Card>
  ) : null

  return (
    <div className='space-y-6'>
      <div className='flex flex-col justify-between gap-4 sm:flex-row sm:items-end'>
        <div>
          <p className='text-sm font-medium text-brand-purple'>
            Rules and their versions
          </p>
          <h1 className='text-display-3 font-bold tracking-tight text-brand-navy'>
            Policy Studio
          </h1>
          <p className='mt-2 max-w-2xl text-muted-foreground'>
            This is where the rules the daily checks follow are kept: how long a
            compliance document may sit unsigned, when first pay has to be
            confirmed, how fast a manager has to act. Every change is saved as
            its own version, and a version can be tested before it goes live.
          </p>
        </div>
        {canDraft && (
          <Button variant='gradient' onClick={() => setDraftEditorOpen(true)}>
            Create a draft
          </Button>
        )}
      </div>

      {/* While the draft dialog is open the same message is shown inside it,
          so only one live region is ever announcing at a time. */}
      {!draftEditorOpen && noticeCard}

      <div className='grid gap-6 xl:grid-cols-[1.05fr_.95fr]'>
        <div className='space-y-3'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h2 className='text-lg font-semibold text-brand-navy'>
              Version history
            </h2>
            <Button
              size='sm'
              variant='ghost'
              disabled={busy !== null}
              onClick={() => setShowHidden((current) => !current)}
            >
              {showHidden ? (
                <Icons.eyeOff className='mr-2 h-4 w-4' />
              ) : (
                <Icons.eye className='mr-2 h-4 w-4' />
              )}
              {showHidden ? 'Hide hidden versions' : 'Show hidden versions'}
            </Button>
          </div>
          {/* Always present, so the change of state is announced reliably. */}
          <span role='status' className='sr-only'>
            {loading ? 'Loading the policy versions' : ''}
          </span>
          {loading && (
            <div className='space-y-3' aria-busy='true'>
              {Array.from({ length: 3 }).map((_, index) => (
                <Card key={index}>
                  <CardContent className='space-y-3 p-4'>
                    <Skeleton className='h-5 w-24' />
                    <Skeleton className='h-4 w-64' />
                    <Skeleton className='h-4 w-40' />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          {policies.map((policy) => {
            const label = actionLabel(policy)
            const isHidden = Boolean(policy.hidden_at)
            return (
              <Card
                key={policy.version_id}
                className={`group relative ${isHidden ? 'opacity-70' : ''}`}
              >
                <CardContent className='space-y-4 p-4'>
                  <div className='flex items-start justify-between gap-2'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <PolicyStatusBadge status={policy.status} />
                      {isHidden && (
                        <span className='inline-flex w-fit items-center gap-1 rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700'>
                          <Icons.eyeOff className='h-3 w-3' />
                          Hidden
                        </span>
                      )}
                    </div>
                    {canDraft && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type='button'
                            aria-label={`More for version ${policy.version_id}`}
                            disabled={busy !== null}
                            /* Always visible: hiding it until hover puts
                               "hide" and "delete draft" out of reach on a
                               touch screen, where there is no hover. */
                            className='rounded-md p-1.5 text-muted-foreground transition hover:bg-slate-100 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cornflower/50 disabled:pointer-events-none'
                          >
                            <Icons.moreVertical className='h-4 w-4' />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end' className='w-64'>
                          <DropdownMenuItem
                            onSelect={() => void openPolicyDetails(policy)}
                          >
                            <Icons.eye className='mr-2 h-4 w-4' />
                            View details
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => void startDraftFromPolicy(policy)}
                          >
                            <Icons.copy className='mr-2 h-4 w-4' />
                            Start a new draft from this
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {isHidden ? (
                            <DropdownMenuItem
                              onSelect={() => void setVisibility(policy, false)}
                            >
                              <Icons.eye className='mr-2 h-4 w-4' />
                              Show in this list again
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              disabled={policy.status === 'active'}
                              onSelect={() => void setVisibility(policy, true)}
                            >
                              <Icons.eyeOff className='mr-2 h-4 w-4' />
                              Hide from this list
                            </DropdownMenuItem>
                          )}
                          {policy.status === 'draft' && (
                            <DropdownMenuItem
                              className='text-destructive focus:text-destructive'
                              onSelect={() => setDeleteTarget(policy)}
                            >
                              <Icons.trash className='mr-2 h-4 w-4' />
                              Delete draft
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>

                  <div>
                    <p className='font-medium text-brand-navy'>
                      {policy.change_summary}
                    </p>
                    <dl className='mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2'>
                      <div>
                        <dt className='font-semibold text-foreground'>
                          Version reference
                        </dt>
                        <dd className='break-all font-mono'>
                          {policy.version_id}
                        </dd>
                      </div>
                      <div>
                        <dt className='font-semibold text-foreground'>
                          Copied from
                        </dt>
                        <dd className='break-all font-mono'>
                          {policy.parent_version_id ?? 'The first version'}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className='flex flex-wrap items-center gap-2 border-t pt-4'>
                    <Button
                      size='sm'
                      variant='ghost'
                      disabled={busy !== null}
                      onClick={() => void openPolicyDetails(policy)}
                    >
                      View details
                    </Button>
                    {/* One action carries the card forward; the rest stay
                        quiet, so the next step is never a guess. */}
                    {label && (
                      <Button
                        size='sm'
                        variant={
                          policy.status === 'approved' ? 'gradient' : 'default'
                        }
                        loading={busy === policy.version_id}
                        disabled={busy !== null && busy !== policy.version_id}
                        onClick={() => advance(policy)}
                      >
                        {label}
                      </Button>
                    )}
                    {isAdmin &&
                      ['active', 'retired'].includes(policy.status) && (
                        <Button
                          size='sm'
                          variant='ghost'
                          loading={busy === policy.version_id}
                          disabled={busy !== null && busy !== policy.version_id}
                          onClick={() => rollback(policy)}
                        >
                          Copy into a new draft
                        </Button>
                      )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
          {!loading && policies.length === 0 && (
            <Card>
              <CardContent className='space-y-1 p-5 text-sm'>
                <p className='font-medium text-brand-navy'>
                  No versions to show
                </p>
                <p className='text-muted-foreground'>
                  {showHidden
                    ? 'Nothing is stored yet, hidden or otherwise.'
                    : 'Versions hidden from this list are still stored. Use “Show hidden versions” to see them.'}
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className='space-y-6'>
          <div className='space-y-3'>
            <h2 className='text-lg font-semibold text-brand-navy'>
              How a change goes live
            </h2>
            <Card>
              <CardContent className='p-5'>
                <ol className='space-y-3'>
                  {goLiveSteps.map((step, index) => (
                    <li key={step.title} className='flex gap-3'>
                      <span
                        aria-hidden='true'
                        className='mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-navy/10 text-xs font-semibold tabular-nums text-brand-navy'
                      >
                        {index + 1}
                      </span>
                      <span className='text-sm'>
                        <span className='font-medium text-brand-navy'>
                          {step.title}.
                        </span>{' '}
                        <span className='text-muted-foreground'>
                          {step.detail}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </div>

          <div className='space-y-3'>
            <h2
              ref={simulationRef}
              tabIndex={-1}
              className='text-lg font-semibold text-brand-navy outline-none'
            >
              Test result
            </h2>
            {simulation ? (
              <Card>
                <CardHeader>
                  <CardTitle>What this version would change</CardTitle>
                </CardHeader>
                <CardContent className='space-y-3'>
                  <p className='text-sm text-muted-foreground'>
                    {simulation.workers_evaluated} people were checked, compared
                    with{' '}
                    {simulation.active_policy_version
                      ? `the policy in force (${simulation.active_policy_version})`
                      : 'no policy in force yet'}
                    .
                  </p>
                  {simulationScope && (
                    <p className='text-xs text-muted-foreground'>
                      Measured as if the date were{' '}
                      <span className='font-medium text-foreground'>
                        {new Date(simulationScope.asOf).toLocaleDateString()}
                      </span>
                      {simulationScope.cohort
                        ? `, for the ${simulationScope.cohort} group only.`
                        : ', across everyone.'}
                    </p>
                  )}
                  {Object.keys(simulation.delta_by_code).length === 0 ? (
                    <p className='text-sm'>
                      Nothing would change for the people checked.
                    </p>
                  ) : (
                    <>
                      <p className='text-xs text-muted-foreground'>
                        A plus means this version would raise more of these; a
                        minus means fewer.
                      </p>
                      <div className='space-y-2'>
                        {Object.entries(simulation.delta_by_code).map(
                          ([code, delta]) => (
                            <div
                              key={code}
                              className='flex items-start justify-between gap-4 text-sm'
                            >
                              <span>{reasonCodeLabel(code)}</span>
                              <span
                                className={`tabular-nums ${
                                  delta > 0
                                    ? 'text-amber-700'
                                    : 'text-emerald-700'
                                }`}
                              >
                                {delta > 0 ? '+' : ''}
                                {delta}
                              </span>
                            </div>
                          )
                        )}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className='p-5 text-sm text-muted-foreground'>
                  Test a draft to see how it would change what the checks pick
                  up, next to the policy in force. The result appears here. No
                  cases are opened and nobody is contacted.
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        <Dialog
          open={testTarget !== null}
          onOpenChange={(open) => {
            if (!open && busy === null) setTestTarget(null)
            if (open) {
              setTestDate('')
              setTestCohort('')
            }
          }}
        >
          <DialogContent className='max-w-lg'>
            <DialogHeader>
              <DialogTitle>Test this draft</DialogTitle>
              <DialogDescription>
                The draft is run against real people and compared with the
                policy in force. No cases are opened and nobody is contacted.
              </DialogDescription>
            </DialogHeader>
            <div className='space-y-4'>
              <div className='space-y-1'>
                <Label htmlFor='test-as-of'>Run it as if the date were</Label>
                <Input
                  id='test-as-of'
                  type='date'
                  className='w-52'
                  value={testDate}
                  disabled={busy !== null}
                  onChange={(event) => setTestDate(event.target.value)}
                  aria-describedby='test-as-of-hint'
                />
                <p id='test-as-of-hint' className='text-xs text-muted-foreground'>
                  Leave it empty for today. Pick a future date to see what the
                  change would do at the next intake — deadlines are measured
                  from the date you choose.
                </p>
              </div>
              <div className='space-y-1'>
                <Label htmlFor='test-cohort'>
                  Limit it to one group{' '}
                  <span className='font-normal text-muted-foreground'>
                    (optional)
                  </span>
                </Label>
                <Input
                  id='test-cohort'
                  value={testCohort}
                  autoComplete='off'
                  placeholder='All groups'
                  disabled={busy !== null}
                  onChange={(event) => setTestCohort(event.target.value)}
                />
              </div>
            </div>
            <DialogFooter className='gap-2 sm:space-x-0'>
              <Button
                type='button'
                variant='outline'
                disabled={busy !== null}
                onClick={() => setTestTarget(null)}
              >
                Cancel
              </Button>
              <Button
                type='button'
                variant='gradient'
                loading={busy === testTarget?.version_id}
                onClick={() =>
                  testTarget && void runTest(testTarget, testDate, testCohort)
                }
              >
                Run the test
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={draftEditorOpen} onOpenChange={setDraftEditorOpen}>
          <DialogContent className='max-h-[calc(100dvh-10rem)] max-w-3xl overflow-y-auto'>
            <DialogHeader>
              <DialogTitle>Create a draft</DialogTitle>
              <DialogDescription>
                A draft is a full copy of the version you started from, so
                anything you do not touch stays exactly as it is. Nothing you
                write here takes effect until the draft has been tested,
                approved and made active.
              </DialogDescription>
            </DialogHeader>

            {noticeCard}

            <form className='space-y-6' onSubmit={create}>
              <section className='space-y-2'>
                <h3 className='text-sm font-semibold uppercase tracking-wide text-muted-foreground'>
                  What is changing
                </h3>
                <div className='space-y-2 rounded-lg border p-4'>
                  <Label htmlFor='draft-change-summary'>
                    Describe the change
                  </Label>
                  <Input
                    id='draft-change-summary'
                    value={summary}
                    onChange={(event) => setSummary(event.target.value)}
                    minLength={3}
                    placeholder='For example: give Malaysia three more days to confirm first pay'
                    required
                    disabled={draftFieldsDisabled}
                    aria-describedby='draft-change-summary-hint'
                  />
                  <p
                    id='draft-change-summary-hint'
                    className='text-xs text-muted-foreground'
                  >
                    This sentence is what approvers and the history will see, so
                    say what changed and why.
                  </p>
                  <p className='pt-1 text-xs text-muted-foreground'>
                    <span className='font-semibold text-foreground'>
                      Copied from:
                    </span>{' '}
                    <span className='font-mono'>
                      {baseVersion ?? 'Nothing loaded yet'}
                    </span>
                  </p>
                </div>
              </section>

              <section className='space-y-3'>
                <h3 className='text-sm font-semibold uppercase tracking-wide text-muted-foreground'>
                  The settings that matter
                </h3>

                {thresholdGroups.map((group) => {
                  const keys = group.fields.map(([key]) => key)
                  const overridden = countriesWithOwnValue(snapshot, keys)
                  const showCountries =
                    perCountryOpen[group.id] ?? overridden.length > 0
                  const toggleId = `per-country-${group.id}`
                  return (
                    <section
                      key={group.id}
                      className='space-y-4 rounded-lg border p-4'
                    >
                      <div>
                        <h4 className='font-semibold text-brand-navy'>
                          {group.title}
                        </h4>
                        <p className='text-xs text-muted-foreground'>
                          {group.description}
                        </p>
                      </div>

                      <div className='flex items-start justify-between gap-4 rounded-md bg-slate-50 p-3'>
                        <div className='space-y-1'>
                          <Label htmlFor={toggleId}>
                            Use different values per country
                          </Label>
                          <p
                            id={`${toggleId}-hint`}
                            className='text-xs text-muted-foreground'
                          >
                            {showCountries
                              ? 'Each country can have its own value. A country left empty follows “Everywhere else”.'
                              : 'One value is used everywhere.'}
                          </p>
                        </div>
                        <Switch
                          id={toggleId}
                          checked={showCountries}
                          disabled={draftFieldsDisabled}
                          aria-describedby={`${toggleId}-hint`}
                          onCheckedChange={(checked) =>
                            setPerCountryOpen((current) => ({
                              ...current,
                              [group.id]: checked,
                            }))
                          }
                        />
                      </div>

                      {group.fields.map(([key, label]) =>
                        showCountries ? (
                          <div key={key} className='space-y-2'>
                            <p className='text-sm font-medium leading-none'>
                              {label}
                            </p>
                            <div className='grid grid-cols-3 gap-2 sm:grid-cols-6'>
                              {jurisdictions.map((jurisdiction) => (
                                <div key={jurisdiction} className='space-y-1'>
                                  <Label
                                    htmlFor={`threshold-${key}-${jurisdiction}`}
                                    className='block text-xs font-normal text-muted-foreground'
                                  >
                                    {jurisdictionLabels[jurisdiction]}
                                  </Label>
                                  <Input
                                    id={`threshold-${key}-${jurisdiction}`}
                                    type='number'
                                    min={0}
                                    value={thresholdValue(
                                      snapshot,
                                      key,
                                      jurisdiction
                                    )}
                                    disabled={draftFieldsDisabled}
                                    onChange={(event) =>
                                      setThreshold(
                                        key,
                                        event.target.value,
                                        jurisdiction
                                      )
                                    }
                                    aria-label={`${label} — ${jurisdictionLabels[jurisdiction]}`}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div key={key} className='space-y-2'>
                            <Label htmlFor={`threshold-${key}-default`}>
                              {label}
                            </Label>
                            <Input
                              id={`threshold-${key}-default`}
                              type='number'
                              min={0}
                              className='w-40'
                              value={thresholdValue(snapshot, key, 'default')}
                              disabled={draftFieldsDisabled}
                              onChange={(event) =>
                                setThreshold(key, event.target.value, 'default')
                              }
                            />
                          </div>
                        )
                      )}

                      {/* Hiding the country inputs must never read as
                          "the country values are gone" — they still apply. */}
                      {!showCountries && overridden.length > 0 && (
                        <div className='space-y-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900'>
                          <p>
                            {listSentence(
                              overridden.map(
                                (country) => jurisdictionLabels[country]
                              )
                            )}{' '}
                            still {overridden.length === 1 ? 'has' : 'have'} a
                            value of its own, saved in this draft. The value
                            above does not apply there until you remove{' '}
                            {overridden.length === 1 ? 'it' : 'them'}.
                          </p>
                          <Button
                            type='button'
                            size='sm'
                            variant='outline'
                            disabled={draftFieldsDisabled}
                            onClick={() => clearCountryValues(keys)}
                          >
                            Remove the country values
                          </Button>
                        </div>
                      )}
                    </section>
                  )
                })}

                <section className='space-y-4 rounded-lg border p-4'>
                  <div>
                    <h4 className='font-semibold text-brand-navy'>
                      When a whole group is held up
                    </h4>
                    <p className='text-xs text-muted-foreground'>
                      How big a hold-up has to be before it is worth flagging.
                      These are the same everywhere.
                    </p>
                  </div>
                  <div className='grid gap-4 sm:grid-cols-2'>
                    {globalThresholds.map(([key, label]) => (
                      <div key={key} className='space-y-1'>
                        <Label
                          htmlFor={`threshold-${key}`}
                          className='block text-xs font-normal text-muted-foreground'
                        >
                          {label}
                        </Label>
                        <Input
                          id={`threshold-${key}`}
                          type='number'
                          min={0}
                          value={thresholdValue(snapshot, key)}
                          disabled={draftFieldsDisabled}
                          onChange={(event) =>
                            setThreshold(key, event.target.value)
                          }
                        />
                      </div>
                    ))}
                  </div>
                </section>

                <section className='space-y-4 rounded-lg border p-4'>
                  <div>
                    <h4 className='font-semibold text-brand-navy'>
                      Day one and task follow-up
                    </h4>
                    <p className='text-xs text-muted-foreground'>
                      How long something can sit before it becomes a case.
                    </p>
                  </div>
                  <div className='grid gap-4 sm:grid-cols-2'>
                    <NumberSetting
                      snapshot={snapshot}
                      path={['thresholds', 'provisioning_blocked_grace_days']}
                      label='Grace after day one for missing access'
                      hint='Access should exist by the end of day one. The grace absorbs time-zone differences.'
                      suffix='days'
                      disabled={draftFieldsDisabled}
                      onChange={setPath}
                    />
                    <NumberSetting
                      snapshot={snapshot}
                      path={['thresholds', 'task_stalled_overdue_days']}
                      label='Days past due before a task counts as stalled'
                      hint='Long enough to be a real signal, short enough to still be worth acting on.'
                      suffix='days'
                      disabled={draftFieldsDisabled}
                      onChange={setPath}
                    />
                    <NumberSetting
                      snapshot={snapshot}
                      path={['thresholds', 'catch_rate_sla_days']}
                      label='Days we give ourselves to act on a signal'
                      hint='Used to measure whether we responded in time. Usually matches the line above.'
                      suffix='days'
                      disabled={draftFieldsDisabled}
                      onChange={setPath}
                    />
                  </div>
                  <ListSetting
                    snapshot={snapshot}
                    path={['thresholds', 'compliance_step_terms']}
                    label='Onboarding steps that count as compliance'
                    hint='Written out in full, so renaming a step elsewhere cannot quietly change what is checked.'
                    addLabel='Add a step'
                    disabled={draftFieldsDisabled}
                    onChange={setPath}
                  />
                </section>

                <section className='space-y-4 rounded-lg border p-4'>
                  <div>
                    <h4 className='font-semibold text-brand-navy'>
                      Engagement and sensitive disclosures
                    </h4>
                    <p className='text-xs text-muted-foreground'>
                      When a pulse response is low enough to look at, and how
                      sure the system must be before it acts on its own.
                    </p>
                  </div>
                  <div className='grid gap-4 sm:grid-cols-2'>
                    <NumberSetting
                      snapshot={snapshot}
                      path={['thresholds', 'engagement_low_score']}
                      label='Pulse score at or below this counts as low'
                      hint='The scale runs 0 to 10.'
                      max={10}
                      suffix='out of 10'
                      disabled={draftFieldsDisabled}
                      onChange={setPath}
                    />
                    <NumberSetting
                      snapshot={snapshot}
                      path={[
                        'thresholds',
                        'disclosure_classifier_min_confidence',
                      ]}
                      label='How sure before acting without a person'
                      hint='Below this, a sensitive disclosure always goes to a person instead.'
                      step={0.05}
                      max={1}
                      suffix='0 to 1'
                      disabled={draftFieldsDisabled}
                      onChange={setPath}
                    />
                  </div>
                </section>

                <section className='space-y-4 rounded-lg border p-4'>
                  <div>
                    <h4 className='font-semibold text-brand-navy'>
                      Possible duplicate people
                    </h4>
                    <p className='text-xs text-muted-foreground'>
                      Treating two real people as one is worse than one extra
                      check, so the bar to merge is deliberately high. Between
                      the two figures, a person is asked to confirm.
                    </p>
                  </div>
                  <div className='grid gap-4 sm:grid-cols-2'>
                    <NumberSetting
                      snapshot={snapshot}
                      path={['thresholds', 'dedup_confidence_threshold']}
                      label='Same person at or above'
                      step={0.05}
                      max={1}
                      suffix='0 to 1'
                      disabled={draftFieldsDisabled}
                      onChange={setPath}
                    />
                    <NumberSetting
                      snapshot={snapshot}
                      path={['thresholds', 'dedup_flag_band_low']}
                      label='Definitely a new person below'
                      step={0.05}
                      max={1}
                      suffix='0 to 1'
                      disabled={draftFieldsDisabled}
                      onChange={setPath}
                    />
                    <NumberSetting
                      snapshot={snapshot}
                      path={['thresholds', 'dedup_hire_date_proximity_days']}
                      label='Only compare start dates this close together'
                      hint='A tight window catches the same intake sent twice, not two people who started in the same month.'
                      suffix='days'
                      disabled={draftFieldsDisabled}
                      onChange={setPath}
                    />
                  </div>
                </section>
              </section>

              <details className='group rounded-lg border bg-slate-50/60'>
                <summary className='flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cornflower/50 [&::-webkit-details-marker]:hidden'>
                  <span>
                    <span className='text-sm font-semibold text-brand-navy'>
                      Messages, channels and timing
                    </span>
                    <span className='block text-xs text-muted-foreground'>
                      What we send, where it goes, and what happens when a
                      message does not get through.
                    </span>
                  </span>
                  <Icons.chevronDown className='h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180' />
                </summary>
                <div className='space-y-6 border-t p-4'>
                  <div className='space-y-3'>
                    <p className='text-sm font-medium text-brand-navy'>
                      What we send
                    </p>
                    <p className='text-xs text-muted-foreground'>
                      Anything inside {'{{ }}'} is filled in when the message is
                      sent. The confidential alert deliberately carries no
                      details of the disclosure — only a link to the case.
                    </p>
                    <TextAreaSetting
                      snapshot={snapshot}
                      path={['templates', 'manager_nudge']}
                      label='Reminder to a manager'
                      disabled={draftFieldsDisabled}
                      onChange={setPath}
                    />
                    <TextAreaSetting
                      snapshot={snapshot}
                      path={['templates', 'it_escalation']}
                      label='Escalation to IT'
                      disabled={draftFieldsDisabled}
                      onChange={setPath}
                    />
                    <TextAreaSetting
                      snapshot={snapshot}
                      path={['templates', 'confidential_alert']}
                      label='Confidential alert to HR'
                      disabled={draftFieldsDisabled}
                      onChange={setPath}
                    />
                  </div>

                  <div className='space-y-3'>
                    <p className='text-sm font-medium text-brand-navy'>
                      Where it goes
                    </p>
                    <p className='text-xs text-muted-foreground'>
                      Slack channel IDs. The confidential channel is a single
                      restricted channel on purpose and must never be a
                      manager&rsquo;s channel.
                    </p>
                    <div className='grid gap-4 sm:grid-cols-2'>
                      {managerChannelOrgs.map((org) => (
                        <TextSetting
                          key={org}
                          snapshot={snapshot}
                          path={['routing', 'manager_channel_by_org', org]}
                          label={`Managers in ${org}`}
                          disabled={draftFieldsDisabled}
                          onChange={setPath}
                        />
                      ))}
                      <TextSetting
                        snapshot={snapshot}
                        path={['routing', 'confidential_channel']}
                        label='Confidential HR channel'
                        disabled={draftFieldsDisabled}
                        onChange={setPath}
                      />
                      <TextSetting
                        snapshot={snapshot}
                        path={['routing', 'it_escalation_channel']}
                        label='IT escalation channel'
                        disabled={draftFieldsDisabled}
                        onChange={setPath}
                      />
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <p className='text-sm font-medium text-brand-navy'>
                      When a message does not get through
                    </p>
                    <div className='grid gap-4 sm:grid-cols-2'>
                      <NumberSetting
                        snapshot={snapshot}
                        path={['retry', 'max_attempts']}
                        label='Times to try'
                        disabled={draftFieldsDisabled}
                        onChange={setPath}
                      />
                      <ListSetting
                        snapshot={snapshot}
                        path={['retry', 'backoff_seconds']}
                        label='Wait between tries (seconds)'
                        hint='A failed message is never dropped quietly — once the tries run out it is escalated.'
                        addLabel='Add a wait'
                        numeric
                        disabled={draftFieldsDisabled}
                        onChange={setPath}
                      />
                    </div>
                  </div>

                  <div className='space-y-3'>
                    <p className='text-sm font-medium text-brand-navy'>
                      Dates in incoming files
                    </p>
                    <div className='space-y-2'>
                      <Label
                        htmlFor='ambiguous-date-order'
                        className='block text-xs font-normal text-muted-foreground'
                      >
                        Read 03/04 as
                      </Label>
                      <Select
                        value={
                          stringAt(snapshot, [
                            'normalization',
                            'ambiguous_numeric_date_order',
                          ]) || 'DMY'
                        }
                        disabled={draftFieldsDisabled}
                        onValueChange={(value) =>
                          setPath(
                            ['normalization', 'ambiguous_numeric_date_order'],
                            value
                          )
                        }
                      >
                        <SelectTrigger
                          id='ambiguous-date-order'
                          className='w-64'
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value='DMY'>
                            Day first — 3 April
                          </SelectItem>
                          <SelectItem value='MDY'>
                            Month first — 4 March
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p className='text-xs text-muted-foreground'>
                        A date that does not fit this order is never quietly
                        reinterpreted — it is raised for a person to settle.
                      </p>
                    </div>
                    <ListSetting
                      snapshot={snapshot}
                      path={['normalization', 'date_formats_accepted']}
                      label='Date layouts we accept'
                      hint='Anything not on this list is treated as unreadable rather than guessed.'
                      addLabel='Add a layout'
                      disabled={draftFieldsDisabled}
                      onChange={setPath}
                    />
                  </div>
                </div>
              </details>

              <details className='group rounded-lg border bg-slate-50/60'>
                <summary className='flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cornflower/50 [&::-webkit-details-marker]:hidden'>
                  <span>
                    <span className='text-sm font-semibold text-brand-navy'>
                      Rehearsals, and the raw file
                    </span>
                    <span className='block text-xs text-muted-foreground'>
                      Only needed to record a demo, or to check the file behind
                      everything above.
                    </span>
                  </span>
                  <Icons.chevronDown className='h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180' />
                </summary>
                <div className='space-y-6 border-t p-4'>
                  <div className='space-y-3'>
                    <p className='text-sm font-medium text-brand-navy'>
                      Pretend today is a different date
                    </p>
                    <div className='flex flex-wrap items-end gap-3'>
                      <div className='space-y-1'>
                        <Label
                          htmlFor='as-of-date'
                          className='block text-xs font-normal text-muted-foreground'
                        >
                          Run every check as if today were
                        </Label>
                        <Input
                          id='as-of-date'
                          type='date'
                          className='w-52'
                          disabled={draftFieldsDisabled}
                          value={stringAt(snapshot, ['as_of_date']).slice(0, 10)}
                          onChange={(event) =>
                            setPath(
                              ['as_of_date'],
                              event.target.value === ''
                                ? null
                                : event.target.value
                            )
                          }
                        />
                      </div>
                      {stringAt(snapshot, ['as_of_date']) !== '' && (
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          disabled={draftFieldsDisabled}
                          onClick={() => setPath(['as_of_date'], null)}
                        >
                          Go back to today
                        </Button>
                      )}
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      Leave this empty for normal use, so every deadline is
                      measured against the real date. Pinning a date is for a
                      rehearsal or a recorded demo — while it is set, the checks
                      behave as if that day never changes.
                    </p>
                  </div>

                  <div className='space-y-3'>
                    <div className='flex items-start justify-between gap-4'>
                      <div className='space-y-1'>
                        <Label htmlFor='demo-mode'>Demo mode</Label>
                        <p
                          id='demo-mode-hint'
                          className='max-w-md text-xs text-muted-foreground'
                        >
                          Uses the shorter waiting times below instead of the
                          normal ones, so a live demo is not spent watching
                          nothing happen.
                        </p>
                      </div>
                      <Switch
                        id='demo-mode'
                        aria-describedby='demo-mode-hint'
                        disabled={draftFieldsDisabled}
                        checked={readPath(snapshot, ['demo_mode']) === true}
                        onCheckedChange={(checked) =>
                          setPath(['demo_mode'], checked)
                        }
                      />
                    </div>
                    <div className='grid gap-4 sm:grid-cols-2'>
                      <NumberSetting
                        snapshot={snapshot}
                        path={['retry_demo_profile', 'max_attempts']}
                        label='Times to try, in demo mode'
                        disabled={draftFieldsDisabled}
                        onChange={setPath}
                      />
                      <ListSetting
                        snapshot={snapshot}
                        path={['retry_demo_profile', 'backoff_seconds']}
                        label='Wait between tries, in demo mode (seconds)'
                        addLabel='Add a wait'
                        numeric
                        disabled={draftFieldsDisabled}
                        onChange={setPath}
                      />
                    </div>
                  </div>

                  <div className='space-y-1'>
                    <p className='text-sm font-medium text-brand-navy'>
                      Reasons a case can be raised for
                    </p>
                    <p className='text-xs text-muted-foreground'>
                      All {registeredReasonCodes.length} reasons are kept in
                      this draft for you. A policy that recognises fewer would
                      be refused, so there is nothing to choose here.
                    </p>
                  </div>

                  <div className='space-y-2'>
                    <Label htmlFor='policy-json'>
                      Every setting in this draft, as text
                    </Label>
                    <p className='text-xs text-muted-foreground'>
                      Every setting in this policy now has a field above, so you
                      should never have to type in here. It is kept as a way to
                      read the whole draft at once, and as a last resort.
                    </p>
                    <textarea
                      id='policy-json'
                      value={snapshot}
                      onChange={(event) => setSnapshot(event.target.value)}
                      className='min-h-72 w-full rounded-lg border border-input bg-white p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-cornflower/50'
                      spellCheck={false}
                      disabled={draftFieldsDisabled}
                    />
                  </div>
                </div>
              </details>

              <DialogFooter className='gap-2 border-t pt-4 sm:space-x-0'>
                {!canDraft && (
                  <p className='text-xs text-muted-foreground'>
                    Your access lets you review and approve versions, but not
                    write them.
                  </p>
                )}
                {canDraft && !baseVersion && (
                  <Button
                    type='button'
                    variant='outline'
                    onClick={() => {
                      const active = policies.find(
                        (policy) => policy.status === 'active'
                      )
                      if (active) void loadSnapshot(active)
                    }}
                    disabled={
                      !policies.some((policy) => policy.status === 'active')
                    }
                  >
                    Load the version in force
                  </Button>
                )}
                <Button
                  type='submit'
                  variant='gradient'
                  loading={busy === 'create'}
                  disabled={draftFieldsDisabled}
                >
                  Save as a draft
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Dialog
        open={selectedPolicy !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setSelectedPolicy(null)
        }}
      >
        <DialogContent className='max-h-[calc(100dvh-10rem)] max-w-3xl overflow-y-auto'>
          {selectedPolicy && (
            <>
              <DialogHeader>
                <PolicyStatusBadge status={selectedPolicy.status} />
                <DialogTitle>About this version</DialogTitle>
                <DialogDescription>
                  What this version is, who wrote it, and when. A draft can
                  still be changed; anything past that is kept as it is, for the
                  record.
                </DialogDescription>
              </DialogHeader>

              <dl className='grid gap-3 rounded-lg border bg-slate-50 p-4 text-sm sm:grid-cols-2'>
                <div>
                  <dt className='font-semibold text-brand-navy'>
                    Version reference
                  </dt>
                  <dd className='break-all font-mono text-xs text-muted-foreground'>
                    {selectedPolicy.version_id}
                  </dd>
                </div>
                <div>
                  <dt className='font-semibold text-brand-navy'>Copied from</dt>
                  <dd className='break-all font-mono text-xs text-muted-foreground'>
                    {selectedPolicy.parent_version_id ?? 'The first version'}
                  </dd>
                </div>
                <div>
                  <dt className='font-semibold text-brand-navy'>Created at</dt>
                  <dd className='text-muted-foreground'>
                    {formatTimestamp(selectedPolicy.created_at)}
                  </dd>
                </div>
                <div>
                  <dt className='font-semibold text-brand-navy'>Created by</dt>
                  <dd className='break-all text-muted-foreground'>
                    {selectedPolicy.created_by ?? 'Not available'}
                  </dd>
                </div>
                {selectedPolicy.activated_at && (
                  <div>
                    <dt className='font-semibold text-brand-navy'>
                      Went live at
                    </dt>
                    <dd className='text-muted-foreground'>
                      {formatTimestamp(selectedPolicy.activated_at)}
                    </dd>
                  </div>
                )}
              </dl>

              <div className='space-y-2'>
                <Label htmlFor='detail-change-summary'>
                  What this version changed
                </Label>
                <Input
                  id='detail-change-summary'
                  value={detailSummary}
                  minLength={3}
                  onChange={(event) => setDetailSummary(event.target.value)}
                  disabled={
                    detailLoading ||
                    selectedPolicy.status !== 'draft' ||
                    !canDraft
                  }
                />
              </div>

              <details className='group rounded-lg border bg-slate-50/60'>
                <summary className='flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cornflower/50 [&::-webkit-details-marker]:hidden'>
                  <span>
                    <span className='text-sm font-semibold text-brand-navy'>
                      Advanced, and optional
                    </span>
                    <span className='block text-xs text-muted-foreground'>
                      Every setting in this version, and its fingerprint.
                    </span>
                  </span>
                  <Icons.chevronDown className='h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180' />
                </summary>
                <div className='space-y-4 border-t p-4'>
                  {selectedPolicy.snapshot_hash && (
                    <div>
                      <p className='text-sm font-semibold text-brand-navy'>
                        Fingerprint
                      </p>
                      <p className='break-all font-mono text-xs text-muted-foreground'>
                        {selectedPolicy.snapshot_hash}
                      </p>
                    </div>
                  )}
                  <div className='space-y-2'>
                    <Label htmlFor='detail-policy-json'>
                      Every setting in this version, as text
                    </Label>
                    <textarea
                      id='detail-policy-json'
                      value={
                        detailLoading ? 'Loading the settings…' : detailSnapshot
                      }
                      onChange={(event) =>
                        setDetailSnapshot(event.target.value)
                      }
                      className='min-h-80 w-full rounded-lg border border-input bg-white p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-cornflower/50 disabled:bg-slate-50'
                      spellCheck={false}
                      disabled={
                        detailLoading ||
                        selectedPolicy.status !== 'draft' ||
                        !canDraft
                      }
                    />
                    <p className='text-xs text-muted-foreground'>
                      {selectedPolicy.status === 'draft' && canDraft
                        ? 'This draft can be changed or deleted until it is tested.'
                        : 'This version is part of the record and can no longer be changed.'}
                    </p>
                  </div>
                </div>
              </details>

              <DialogFooter className='gap-2 border-t pt-4 sm:space-x-0'>
                {selectedPolicy.status === 'draft' && canDraft && (
                  <Button
                    type='button'
                    variant='destructive'
                    disabled={busy !== null || detailLoading}
                    onClick={() => setDeleteTarget(selectedPolicy)}
                  >
                    Delete draft
                  </Button>
                )}
                {canDraft && (
                  <Button
                    type='button'
                    variant='outline'
                    disabled={busy !== null || detailLoading || !detailSnapshot}
                    onClick={useAsDraftBaseline}
                  >
                    Start a new draft from this
                  </Button>
                )}
                {selectedPolicy.status === 'draft' && canDraft && (
                  <Button
                    type='button'
                    variant='gradient'
                    loading={busy === `edit:${selectedPolicy.version_id}`}
                    disabled={
                      busy !== null ||
                      detailLoading ||
                      detailSummary.trim().length < 3
                    }
                    onClick={() => void saveDraftChanges()}
                  >
                    Save the draft
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              Draft {deleteTarget?.version_id} will be removed for good. Only
              drafts can be deleted — a version that has been tested or used is
              kept for the record, so hide it from the list instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className='bg-destructive text-destructive-foreground hover:bg-destructive/90'
              disabled={busy !== null}
              onClick={() => void deleteDraft()}
            >
              Delete draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
