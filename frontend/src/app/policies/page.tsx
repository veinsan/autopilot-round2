'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import apiClient from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

const jurisdictions = ['default', 'MY', 'SG', 'AU', 'IN', 'PH'] as const

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

const policyGroups = [
  {
    title: 'Compliance & work authorization',
    description:
      'Warning windows for document and work authorization deadlines.',
    fields: [
      ['compliance_at_risk_days', 'Compliance warning window (days)'],
      [
        'work_auth_expiry_at_risk_days',
        'Work authorization warning window (days)',
      ],
    ],
  },
  {
    title: 'First payroll',
    description: 'First-payroll confirmation deadline by jurisdiction.',
    fields: [['first_payroll_cutoff_days', 'Cutoff after start date (days)']],
  },
] as const

const globalThresholds = [
  ['bottleneck_min_workers', 'Minimum affected workers'],
  ['bottleneck_min_percent', 'Minimum affected cohort (%)'],
  ['minimum_cohort_size', 'Minimum cohort size'],
] as const

const managerJurisdictionThresholds = [
  ['nudge_cadence_days', 'Nudge cadence (days)'],
  ['manager_acknowledgment_deadline_days', 'Acknowledgment deadline (days)'],
  ['manager_action_deadline_days', 'Action deadline (days)'],
  ['manager_max_reminders', 'Maximum reminders'],
] as const

function parseSnapshot(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The snapshot must be a JSON object.')
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

const statusStyles: Record<string, string> = {
  draft: 'border-amber-200 bg-amber-50 text-amber-800',
  simulated: 'border-blue-200 bg-blue-50 text-blue-800',
  approved: 'border-teal-200 bg-teal-50 text-teal-800',
  active: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  retired: 'border-slate-200 bg-slate-100 text-slate-700',
}

function PolicyStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${
        statusStyles[status] ?? 'border-gray-200 bg-gray-50 text-gray-700'
      }`}
    >
      {status}
    </span>
  )
}

function formatTimestamp(value?: string): string {
  if (!value) return 'Not available'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

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
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [simulation, setSimulation] = useState<SimulationResult | null>(null)
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null)
  const [detailSnapshot, setDetailSnapshot] = useState('')
  const [detailSummary, setDetailSummary] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Policy | null>(null)
  const [draftEditorOpen, setDraftEditorOpen] = useState(false)
  const [showHidden, setShowHidden] = useState(false)

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
        setMessage(
          `The complete ${detail.version_id} snapshot is loaded as the editing baseline.`
        )
      } catch (error) {
        setBaseVersion(null)
        setMessage(
          error instanceof Error
            ? `The active snapshot could not be loaded: ${error.message}`
            : 'The active snapshot could not be loaded.'
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
      setMessage(
        error instanceof Error
          ? `Policy details could not be loaded: ${error.message}`
          : 'Policy details could not be loaded.'
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
          else setMessage('No active policy is available as a draft baseline.')
        }
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : 'The policy list could not be loaded.'
        )
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
      setMessage(
        error instanceof Error ? error.message : 'The snapshot JSON is invalid.'
      )
    }
  }

  const ensureRoundTwoCodes = () => {
    try {
      const parsed = parseSnapshot(snapshot)
      const currentCodes = Array.isArray(parsed.reason_codes)
        ? parsed.reason_codes.filter(
            (code): code is string => typeof code === 'string'
          )
        : []
      parsed.reason_codes = Array.from(
        new Set([...currentCodes, ...registeredReasonCodes])
      ).sort()
      setSnapshot(JSON.stringify(parsed, null, 2))
      setMessage(
        'The complete reason-code registry was merged without removing other configuration.'
      )
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The snapshot JSON is invalid.'
      )
    }
  }

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setBusy('create')
    try {
      if (!baseVersion)
        throw new Error(
          'Load the active policy snapshot before creating a draft.'
        )
      const configSnapshot = parseSnapshot(snapshot)
      await apiClient('/api/hr/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          change_summary: summary,
          config_snapshot: configSnapshot,
        }),
      })
      setMessage(
        'Draft created. Run a simulation before approval and activation.'
      )
      setSummary('')
      setDraftEditorOpen(false)
      await load()
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The snapshot JSON is invalid.'
      )
    } finally {
      setBusy(null)
    }
  }

  const advance = async (policy: Policy) => {
    setBusy(policy.version_id)
    try {
      if (policy.status === 'draft') {
        const result = await apiClient<{ result: SimulationResult }>(
          '/api/hr/policies/simulations',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version_id: policy.version_id }),
          }
        )
        setSimulation(result.result)
        setMessage(
          `Simulation completed for ${result.result.workers_evaluated} workers. No cases or notifications were created.`
        )
      } else if (policy.status === 'simulated') {
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
            ? 'Approval is complete. The version is ready for Admin activation.'
            : 'Approval recorded; another approval may still be required.'
        )
      } else if (policy.status === 'approved') {
        await apiClient(`/api/hr/policies/${policy.version_id}/activate`, {
          method: 'POST',
        })
        setMessage('The policy version was activated atomically.')
      }
      await load()
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The policy action failed.'
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
        'The earlier snapshot was copied into a rollback draft that still requires simulation.'
      )
      await load()
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The rollback draft could not be created.'
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
      setMessage(`Draft ${selectedPolicy.version_id} was updated.`)
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The draft could not be updated.'
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
          ? `${policy.version_id} was hidden from the dashboard. The version stays in the database and in the audit history.`
          : `${policy.version_id} is visible on the dashboard again.`
      )
      await load()
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'The dashboard visibility could not be changed.'
      )
    } finally {
      setBusy(null)
    }
  }

  const startDraftFromPolicy = async (policy: Policy) => {
    setBusy(`baseline:${policy.version_id}`)
    try {
      await loadSnapshot(policy)
      setSummary(`Draft derived from ${policy.version_id}`)
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
      setMessage(
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
    setSummary(`Draft derived from ${selectedPolicy.version_id}`)
    setSelectedPolicy(null)
    setDraftEditorOpen(true)
    setMessage(
      `Policy baseline: ${selectedPolicy.version_id}. Edit the fields, then save a new draft.`
    )
  }

  const actionLabel = (policy: Policy) => {
    if (policy.status === 'draft' && canDraft) return 'Simulate policy'
    if (policy.status === 'simulated' && canApprove) return 'Approve policy'
    if (policy.status === 'approved' && isAdmin) return 'Activate policy'
    return null
  }

  return (
    <div className='space-y-6'>
      <div className='flex flex-col justify-between gap-4 sm:flex-row sm:items-end'>
        <div>
          <p className='text-sm font-medium text-brand-cornflower'>
            Governed configuration
          </p>
          <h1 className='text-display-3 font-bold tracking-tight text-brand-navy'>
            Policy Studio
          </h1>
          <p className='mt-2 text-muted-foreground'>
            Compliance, payroll, and manager accountability are governed through
            immutable, simulatable, and auditable snapshots.
          </p>
        </div>
        {canDraft && (
          <Button variant='gradient' onClick={() => setDraftEditorOpen(true)}>
            Create policy draft
          </Button>
        )}
      </div>

      {message && (
        <Card className='border-brand-cornflower/30'>
          <CardContent className='p-4 text-sm text-muted-foreground'>
            {message}
          </CardContent>
        </Card>
      )}

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
                            aria-label={`Policy actions for ${policy.version_id}`}
                            disabled={busy !== null}
                            className='rounded-md p-1.5 text-muted-foreground opacity-0 transition hover:bg-slate-100 hover:text-brand-navy focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cornflower/50 disabled:pointer-events-none group-hover:opacity-100 data-[state=open]:opacity-100'
                          >
                            <Icons.moreVertical className='h-4 w-4' />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end' className='w-60'>
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
                            Use as draft baseline
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {isHidden ? (
                            <DropdownMenuItem
                              onSelect={() => void setVisibility(policy, false)}
                            >
                              <Icons.eye className='mr-2 h-4 w-4' />
                              Restore to dashboard
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              disabled={policy.status === 'active'}
                              onSelect={() => void setVisibility(policy, true)}
                            >
                              <Icons.eyeOff className='mr-2 h-4 w-4' />
                              Hide from dashboard
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
                          Policy ID
                        </dt>
                        <dd className='break-all font-mono'>
                          {policy.version_id}
                        </dd>
                      </div>
                      <div>
                        <dt className='font-semibold text-foreground'>
                          Derived from
                        </dt>
                        <dd className='break-all font-mono'>
                          {policy.parent_version_id ??
                            'Initial policy baseline'}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className='flex flex-wrap items-center gap-2 border-t pt-4'>
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={busy !== null}
                      onClick={() => void openPolicyDetails(policy)}
                    >
                      View details
                    </Button>
                    {label && (
                      <Button
                        size='sm'
                        variant={
                          policy.status === 'approved' ? 'gradient' : 'outline'
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
                          Create rollback draft
                        </Button>
                      )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
          {policies.length === 0 && (
            <Card>
              <CardContent className='p-5 text-sm text-muted-foreground'>
                No policy versions are available.{' '}
                {!showHidden &&
                  'Versions hidden from the dashboard are still stored; use "Show hidden versions" to review them.'}
              </CardContent>
            </Card>
          )}
        </div>

        <div className='space-y-3'>
          <h2 className='text-lg font-semibold text-brand-navy'>
            Simulation result
          </h2>
          {simulation ? (
            <Card>
              <CardHeader>
                <CardTitle>Simulation impact</CardTitle>
              </CardHeader>
              <CardContent className='space-y-3'>
                <p className='text-sm text-muted-foreground'>
                  Compared with{' '}
                  {simulation.active_policy_version ?? 'no active policy'}.
                </p>
                {Object.keys(simulation.delta_by_code).length === 0 ? (
                  <p className='text-sm'>
                    No finding changes were detected in the evaluated cohort.
                  </p>
                ) : (
                  <div className='space-y-2'>
                    {Object.entries(simulation.delta_by_code).map(
                      ([code, delta]) => (
                        <div
                          key={code}
                          className='flex justify-between gap-4 text-sm'
                        >
                          <span className='font-mono text-xs'>{code}</span>
                          <span
                            className={
                              delta > 0 ? 'text-amber-700' : 'text-emerald-700'
                            }
                          >
                            {delta > 0 ? '+' : ''}
                            {delta}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className='p-5 text-sm text-muted-foreground'>
                Run a draft simulation to compare its findings with the active
                policy. The result will appear here without creating cases or
                sending notifications.
              </CardContent>
            </Card>
          )}
        </div>

        <Dialog open={draftEditorOpen} onOpenChange={setDraftEditorOpen}>
          <DialogContent className='max-h-[calc(100dvh-10rem)] max-w-5xl overflow-y-auto'>
            <DialogHeader>
              <DialogTitle>Create policy draft</DialogTitle>
              <DialogDescription>
                Adjust governed Round 2 fields or the complete JSON snapshot,
                then save a new draft for simulation.
              </DialogDescription>
            </DialogHeader>
            <div className='grid gap-4 lg:grid-cols-2'>
              <Card>
                <CardHeader>
                  <CardTitle>Round 2 policy fields</CardTitle>
                </CardHeader>
                <CardContent className='space-y-6'>
                  <p className='text-sm text-muted-foreground'>
                    Changes below are merged into the JSON snapshot. Values must
                    come from an approved HR policy.
                  </p>
                  {policyGroups.map((group) => (
                    <section key={group.title} className='space-y-3'>
                      <div>
                        <h3 className='font-semibold text-brand-navy'>
                          {group.title}
                        </h3>
                        <p className='text-xs text-muted-foreground'>
                          {group.description}
                        </p>
                      </div>
                      {group.fields.map(([key, label]) => (
                        <div key={key} className='space-y-2'>
                          <Label>{label}</Label>
                          <div className='grid grid-cols-3 gap-2 sm:grid-cols-6'>
                            {jurisdictions.map((jurisdiction) => (
                              <label
                                key={jurisdiction}
                                className='space-y-1 text-xs text-muted-foreground'
                              >
                                <span>
                                  {jurisdiction === 'default'
                                    ? 'Default'
                                    : jurisdiction}
                                </span>
                                <Input
                                  type='number'
                                  min={0}
                                  value={thresholdValue(
                                    snapshot,
                                    key,
                                    jurisdiction
                                  )}
                                  onChange={(event) =>
                                    setThreshold(
                                      key,
                                      event.target.value,
                                      jurisdiction
                                    )
                                  }
                                  aria-label={`${label} ${jurisdiction}`}
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </section>
                  ))}
                  <section className='space-y-3'>
                    <div>
                      <h3 className='font-semibold text-brand-navy'>
                        Manager & cohort safeguards
                      </h3>
                      <p className='text-xs text-muted-foreground'>
                        Cadence, action deadlines, reminders, and bottleneck
                        thresholds.
                      </p>
                    </div>
                    <div className='space-y-3'>
                      {managerJurisdictionThresholds.map(([key, label]) => (
                        <div key={key} className='space-y-2'>
                          <Label>{label}</Label>
                          <div className='grid grid-cols-3 gap-2 sm:grid-cols-6'>
                            {jurisdictions.map((jurisdiction) => (
                              <label
                                key={jurisdiction}
                                className='space-y-1 text-xs text-muted-foreground'
                              >
                                <span>
                                  {jurisdiction === 'default'
                                    ? 'Default'
                                    : jurisdiction}
                                </span>
                                <Input
                                  type='number'
                                  min={0}
                                  value={thresholdValue(
                                    snapshot,
                                    key,
                                    jurisdiction
                                  )}
                                  onChange={(event) =>
                                    setThreshold(
                                      key,
                                      event.target.value,
                                      jurisdiction
                                    )
                                  }
                                  aria-label={`${label} ${jurisdiction}`}
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className='grid gap-3 sm:grid-cols-2'>
                      {globalThresholds.map(([key, label]) => (
                        <label
                          key={key}
                          className='space-y-1 text-xs text-muted-foreground'
                        >
                          <span>{label}</span>
                          <Input
                            type='number'
                            min={0}
                            value={thresholdValue(snapshot, key)}
                            onChange={(event) =>
                              setThreshold(key, event.target.value)
                            }
                            aria-label={label}
                          />
                        </label>
                      ))}
                    </div>
                  </section>
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    onClick={ensureRoundTwoCodes}
                  >
                    Complete the reason-code registry
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Create a draft</CardTitle>
                </CardHeader>
                <CardContent>
                  <form className='space-y-4' onSubmit={create}>
                    <Input
                      value={summary}
                      onChange={(event) => setSummary(event.target.value)}
                      minLength={3}
                      placeholder='Change summary'
                      required
                      disabled={!canDraft || !baseVersion}
                    />
                    <div className='space-y-2'>
                      <Label htmlFor='policy-json'>
                        Complete snapshot (advanced)
                      </Label>
                      <textarea
                        id='policy-json'
                        value={snapshot}
                        onChange={(event) => setSnapshot(event.target.value)}
                        className='min-h-72 w-full rounded-lg border border-input bg-white p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-cornflower/50'
                        aria-label='Policy configuration JSON'
                        spellCheck={false}
                        disabled={!canDraft || !baseVersion}
                      />
                      <p className='text-xs text-muted-foreground'>
                        <span className='font-semibold text-foreground'>
                          Policy baseline:
                        </span>{' '}
                        <span className='font-mono'>
                          {baseVersion ?? 'Not loaded'}
                        </span>
                        . A draft is a complete snapshot; routing,
                        normalization, templates, retry settings, and active
                        guardrails are preserved.
                      </p>
                    </div>
                    <Button
                      type='submit'
                      variant='gradient'
                      loading={busy === 'create'}
                      disabled={!canDraft || !baseVersion}
                    >
                      Save as draft
                    </Button>
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
                        Reload active snapshot
                      </Button>
                    )}
                    {!canDraft && (
                      <p className='text-xs text-muted-foreground'>
                        Your role can only review or approve policies.
                      </p>
                    )}
                  </form>
                </CardContent>
              </Card>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Dialog
        open={selectedPolicy !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setSelectedPolicy(null)
        }}
      >
        <DialogContent className='max-h-[calc(100dvh-10rem)] max-w-4xl overflow-y-auto'>
          {selectedPolicy && (
            <>
              <DialogHeader>
                <PolicyStatusBadge status={selectedPolicy.status} />
                <DialogTitle>Policy details</DialogTitle>
                <DialogDescription>
                  Review metadata and the complete governed configuration
                  snapshot. Drafts remain editable until they are simulated.
                </DialogDescription>
              </DialogHeader>

              <dl className='grid gap-3 rounded-lg border bg-slate-50 p-4 text-sm sm:grid-cols-2'>
                <div>
                  <dt className='font-semibold text-brand-navy'>Policy ID</dt>
                  <dd className='break-all font-mono text-xs text-muted-foreground'>
                    {selectedPolicy.version_id}
                  </dd>
                </div>
                <div>
                  <dt className='font-semibold text-brand-navy'>
                    Derived from
                  </dt>
                  <dd className='break-all font-mono text-xs text-muted-foreground'>
                    {selectedPolicy.parent_version_id ??
                      'Initial policy baseline'}
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
                      Activated at
                    </dt>
                    <dd className='text-muted-foreground'>
                      {formatTimestamp(selectedPolicy.activated_at)}
                    </dd>
                  </div>
                )}
                {selectedPolicy.snapshot_hash && (
                  <div>
                    <dt className='font-semibold text-brand-navy'>
                      Snapshot hash
                    </dt>
                    <dd className='break-all font-mono text-xs text-muted-foreground'>
                      {selectedPolicy.snapshot_hash}
                    </dd>
                  </div>
                )}
              </dl>

              <div className='space-y-2'>
                <Label htmlFor='detail-change-summary'>Change summary</Label>
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

              <div className='space-y-2'>
                <Label htmlFor='detail-policy-json'>Full policy snapshot</Label>
                <textarea
                  id='detail-policy-json'
                  value={
                    detailLoading
                      ? 'Loading the complete snapshot…'
                      : detailSnapshot
                  }
                  onChange={(event) => setDetailSnapshot(event.target.value)}
                  className='min-h-80 w-full rounded-lg border border-input bg-white p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-brand-cornflower/50 disabled:bg-slate-50'
                  aria-label='Full policy snapshot JSON'
                  spellCheck={false}
                  disabled={
                    detailLoading ||
                    selectedPolicy.status !== 'draft' ||
                    !canDraft
                  }
                />
                <p className='text-xs text-muted-foreground'>
                  {selectedPolicy.status === 'draft' && canDraft
                    ? 'This draft can be edited or deleted until simulation starts.'
                    : 'This lifecycle snapshot is read-only to preserve its audit history.'}
                </p>
              </div>

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
                    Use as draft baseline
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
                    Save draft changes
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
              Draft {deleteTarget?.version_id} will be permanently removed.
              Simulated and historical policies cannot be deleted; hide them
              from the dashboard instead.
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
