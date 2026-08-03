'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import apiClient from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Policy = {
  version_id: string
  status: string
  created_at: string
  change_summary: string
  activated_at?: string
  parent_version_id?: string
}

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

  const loadSnapshot = useCallback(async (policy: Policy) => {
    try {
      const response = await apiClient<
        | { policy: Policy & { config_snapshot: Record<string, unknown> } }
        | (Policy & { config_snapshot: Record<string, unknown> })
      >(`/api/hr/policies/${policy.version_id}`)
      const detail = 'policy' in response ? response.policy : response
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
  }, [])

  const load = useCallback(
    async (withActiveSnapshot = false) => {
      try {
        const result = await apiClient<{ policies: Policy[] }>(
          '/api/hr/policies'
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
    [loadSnapshot]
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

  const actionLabel = (policy: Policy) => {
    if (policy.status === 'draft' && canDraft) return 'Simulate'
    if (policy.status === 'simulated' && canApprove) return 'Approve'
    if (policy.status === 'approved' && isAdmin) return 'Activate'
    return null
  }

  return (
    <div className='space-y-6'>
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

      {message && (
        <Card className='border-brand-cornflower/30'>
          <CardContent className='p-4 text-sm text-muted-foreground'>
            {message}
          </CardContent>
        </Card>
      )}

      <div className='grid gap-6 xl:grid-cols-[1.05fr_.95fr]'>
        <div className='space-y-3'>
          <h2 className='text-lg font-semibold text-brand-navy'>
            Version history
          </h2>
          {policies.map((policy) => {
            const label = actionLabel(policy)
            return (
              <Card key={policy.version_id}>
                <CardContent className='p-4'>
                  <div className='flex flex-col justify-between gap-4 sm:flex-row sm:items-center'>
                    <div>
                      <p className='font-medium text-brand-navy'>
                        {policy.change_summary}
                      </p>
                      <p className='mt-1 font-mono text-xs text-muted-foreground'>
                        {policy.version_id}
                      </p>
                      {policy.parent_version_id && (
                        <p className='mt-1 text-xs text-muted-foreground'>
                          Derived from {policy.parent_version_id}
                        </p>
                      )}
                    </div>
                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='rounded-full bg-brand-cornflower/15 px-2 py-1 text-xs font-semibold capitalize text-brand-navy'>
                        {policy.status}
                      </span>
                      {label && (
                        <Button
                          size='sm'
                          variant='outline'
                          loading={busy === policy.version_id}
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
                            disabled={busy === policy.version_id}
                            onClick={() => rollback(policy)}
                          >
                            Create rollback draft
                          </Button>
                        )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
          {policies.length === 0 && (
            <Card>
              <CardContent className='p-5 text-sm text-muted-foreground'>
                No policy versions are available.
              </CardContent>
            </Card>
          )}

          {simulation && (
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
          )}
        </div>

        <div className='space-y-4'>
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
                    Baseline: {baseVersion ?? 'not loaded'}. A draft is a
                    complete snapshot; routing, normalization, templates, retry
                    settings, and active guardrails are preserved.
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
      </div>
    </div>
  )
}
