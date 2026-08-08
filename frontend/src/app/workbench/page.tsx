'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import apiClient from '@/lib/api-client'
import { reasonCodeLabel } from '@/lib/runs'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Icons } from '@/components/ui/icons'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type CaseStatus = 'open' | 'in_review' | 'awaiting_external_update' | 'resolved'
type Decision = 'claim' | 'acknowledge' | 'await_external_update' | 'resolve'
type ResolutionCode =
  | 'DATA_CORRECTED'
  | 'EMPLOYEE_SUPPORTED'
  | 'DEPENDENCY_CLEARED'
  | 'POLICY_EXCEPTION_APPROVED'
  | 'NO_ACTION_REQUIRED'
  | 'ESCALATED_EXTERNALLY'
type ManagerActionStateName =
  | 'nudge_created'
  | 'delivered'
  | 'acknowledged'
  | 'action_verified'
  | 'escalated'

type Case = {
  case_id: string
  employee_id?: string
  case_type: string
  priority: string
  status: CaseStatus
  recommended_action?: string
  sanitized_context?: Record<string, string | number | boolean | null>
  created_at: string
}

type ManagerActionState = {
  case_id: string
  employee_id: string
  current_state: ManagerActionStateName
  nudge_created_at: string
  delivered_at?: string
  acknowledged_at?: string
  action_verified_at?: string
  escalated_at?: string
  successful_reminder_count: number
  next_reminder_at?: string
  acknowledgment_deadline?: string
  action_deadline?: string
  updated_at: string
}

const statusLabels: Record<CaseStatus, string> = {
  open: 'Open',
  in_review: 'In review',
  awaiting_external_update: 'Awaiting external update',
  resolved: 'Resolved',
}

/**
 * Priority decides what to pick up first, so the ladder is drawn by weight
 * rather than by hue: solid, then tinted, then quiet. Measured as four tinted
 * hues, critical and high sat 2.9 apart for a red-green colourblind reader —
 * far too close for the one distinction that matters. The word is printed
 * either way, so nothing is carried by colour alone.
 */
const priorityStyles: Record<string, string> = {
  critical: 'border-transparent bg-destructive text-white',
  high: 'border-amber-300 bg-amber-100 text-amber-900',
  medium: 'border-blue-200 bg-blue-50 text-blue-900',
  // Muted-on-muted measured 4.2:1, under the 4.5:1 that this size of text
  // needs, so the quiet step still carries a readable ink.
  low: 'border-border bg-muted text-slate-700',
}

// Worded as the outcome the reviewer is recording, not as the code stored
// behind it. The stored values are unchanged.
const resolutionOptions: { value: ResolutionCode; label: string }[] = [
  { value: 'DATA_CORRECTED', label: 'The records were corrected' },
  { value: 'EMPLOYEE_SUPPORTED', label: 'The employee was helped' },
  { value: 'DEPENDENCY_CLEARED', label: 'The blocker was cleared' },
  {
    value: 'POLICY_EXCEPTION_APPROVED',
    label: 'An exception was approved',
  },
  { value: 'NO_ACTION_REQUIRED', label: 'No action was needed' },
  { value: 'ESCALATED_EXTERNALLY', label: 'Another team took it on' },
]

const safeContextLabels: Record<string, string> = {
  reason_code: 'Why it was raised',
  domain: 'Area',
  severity: 'How serious',
  policy_version_id: 'Policy in force',
  evaluated_at: 'Checked on',
  owner: 'Owner',
  recommended_action: 'Suggested next step',
}

/** Values that are stored as codes and must be read as sentences. */
function contextValue(
  key: string,
  value: string | number | boolean | null
): string {
  if (value === null) return 'Not recorded'
  if (key === 'reason_code') return reasonCodeLabel(String(value))
  if (key === 'evaluated_at') {
    const parsed = new Date(String(value))
    return Number.isNaN(parsed.getTime())
      ? String(value)
      : parsed.toLocaleString()
  }
  if (key === 'domain' || key === 'severity') {
    return String(value).replaceAll('_', ' ')
  }
  return String(value)
}

function ManagerState({ state }: { state: ManagerActionState }) {
  const steps = [
    { key: 'nudge_created', label: 'Reminder raised' },
    { key: 'delivered', label: 'Sent to manager' },
    { key: 'acknowledged', label: 'Manager replied' },
    { key: 'action_verified', label: 'Action confirmed' },
  ] as const
  const current = steps.findIndex((step) => step.key === state.current_state)

  return (
    <div
      className='mt-3 space-y-2'
      aria-label={`Manager action state: ${state.current_state}`}
    >
      <div className='flex flex-wrap items-center gap-1'>
        {steps.map((step, index) => (
          <div key={step.key} className='flex items-center gap-1'>
            <span
              className={
                state.current_state !== 'escalated' && index <= current
                  ? 'rounded-full bg-brand-cornflower/20 px-2 py-1 text-xs font-medium text-brand-navy'
                  : 'rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground'
              }
            >
              {step.label}
            </span>
            {index < steps.length - 1 && (
              <span aria-hidden='true' className='text-xs text-muted-foreground'>
                →
              </span>
            )}
          </div>
        ))}
        {state.current_state === 'escalated' && (
          <span className='rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800'>
            Escalated
          </span>
        )}
      </div>
      <p className='text-xs text-muted-foreground'>
        Reminders sent: {state.successful_reminder_count}
        {state.acknowledgment_deadline
          ? ` · Reply due ${new Date(state.acknowledgment_deadline).toLocaleString()}`
          : ''}
        {state.action_deadline
          ? ` · Action due ${new Date(state.action_deadline).toLocaleString()}`
          : ''}
      </p>
    </div>
  )
}

export default function WorkbenchPage() {
  const { data: session } = useSession()
  const roles = useMemo(() => new Set(session?.roles ?? []), [session?.roles])
  const isAdmin = roles.has('admin')
  const isManagerOnly =
    roles.has('manager') && !isAdmin && !roles.has('people_ops')
  const mayViewPayroll =
    isAdmin ||
    (roles.has('people_ops_payroll') &&
      !roles.has('manager') &&
      !roles.has('people_ops'))
  const mayViewManagerActions =
    isAdmin || roles.has('people_ops') || roles.has('manager')
  const [cases, setCases] = useState<Case[]>([])
  const [managerStates, setManagerStates] = useState<
    Record<string, ManagerActionState>
  >({})
  const [error, setError] = useState<string | null>(null)
  // A failure that belongs to one case is reported on that case, not at the
  // top of a queue the reader may have scrolled far past.
  const [caseErrors, setCaseErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [resolutionCodes, setResolutionCodes] = useState<
    Record<string, ResolutionCode>
  >({})

  const setCaseError = (caseId: string, message: string | null) => {
    setCaseErrors((current) => {
      const next = { ...current }
      if (message) next[caseId] = message
      else delete next[caseId]
      return next
    })
  }

  const load = useCallback(async () => {
    try {
      const [caseResult, managerResult] = await Promise.all([
        apiClient<{ cases: Case[] }>('/api/hr/cases'),
        mayViewManagerActions
          ? apiClient<{ states: ManagerActionState[] }>(
              '/api/hr/manager-actions'
            )
          : Promise.resolve({ states: [] }),
      ])
      setCases(caseResult.cases)
      setManagerStates(
        Object.fromEntries(
          managerResult.states.map((state) => [state.case_id, state])
        )
      )
      setError(null)
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'The Workbench could not be loaded.'
      )
    } finally {
      setLoading(false)
    }
  }, [mayViewManagerActions])

  useEffect(() => {
    void load()
  }, [load])

  const visibleCases = useMemo(
    () =>
      cases.filter((item) => item.case_type !== 'payroll' || mayViewPayroll),
    [cases, mayViewPayroll]
  )
  const hiddenPayrollCount = cases.length - visibleCases.length

  const action = async (item: Case, decision: Decision) => {
    const resolutionCode = resolutionCodes[item.case_id]
    if (decision === 'resolve' && !resolutionCode) {
      // Reported on the case itself, beside the control that needs filling in.
      setCaseError(
        item.case_id,
        'Choose how this case was resolved before resolving it.'
      )
      document.getElementById(`resolution-${item.case_id}`)?.focus()
      return
    }
    setCaseError(item.case_id, null)
    setBusy(item.case_id)
    try {
      await apiClient(`/api/hr/cases/${item.case_id}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          resolution_code: decision === 'resolve' ? resolutionCode : undefined,
        }),
      })
      await load()
    } catch (actionError) {
      setCaseError(
        item.case_id,
        actionError instanceof Error
          ? actionError.message
          : 'This action could not be completed. Try again.'
      )
    } finally {
      setBusy(null)
    }
  }

  const managerAction = async (
    state: ManagerActionState,
    eventType: 'acknowledged' | 'action_verified' | 'escalated'
  ) => {
    setBusy(state.case_id)
    try {
      const updated = await apiClient<ManagerActionState>(
        `/api/hr/manager-actions/${state.case_id}/events`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_event_id: `ui_${crypto.randomUUID()}`,
            event_type: eventType,
            occurred_at: new Date().toISOString(),
          }),
        }
      )
      setManagerStates((current) => ({ ...current, [state.case_id]: updated }))
      setCaseError(state.case_id, null)
    } catch (actionError) {
      setCaseError(
        state.case_id,
        actionError instanceof Error
          ? actionError.message
          : 'The manager action state could not be updated. Try again.'
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className='space-y-6'>
      <div>
        {/* Cornflower measures 2.4:1 on this background, so the eyebrow uses
            the deeper brand purple (5.65:1). */}
        <p className='text-sm font-medium text-brand-purple'>
          Onboarding &amp; retention
        </p>
        <h1 className='text-display-3 font-bold tracking-tight text-brand-navy'>
          HR Workbench
        </h1>
        <p className='mt-2 max-w-2xl text-muted-foreground'>
          Nothing here closes on its own. You decide what happens to each case,
          and if the same problem comes back the case opens again.
        </p>
      </div>

      {/* Scope notes are context, not alarms: one quiet line above the queue
          rather than two full cards pushing the work off the screen. */}
      {(isManagerOnly || hiddenPayrollCount > 0) && (
        <div className='flex items-start gap-2 text-sm text-muted-foreground'>
          <Icons.info className='mt-0.5 h-4 w-4 shrink-0 text-brand-purple' />
          <p className='max-w-3xl'>
            {isManagerOnly &&
              'You see cases for the people who report to you. Pay and confidential cases stay with the teams that handle them. '}
            {hiddenPayrollCount > 0 &&
              `${
                hiddenPayrollCount === 1
                  ? '1 pay case is'
                  : `${hiddenPayrollCount} pay cases are`
              } hidden here — only the payroll team and administrators can open them.`}
          </p>
        </div>
      )}
      {error && (
        <Card className='border-destructive/40'>
          <CardContent
            role='alert'
            className='p-4 text-sm text-destructive'
          >
            {error}
          </CardContent>
        </Card>
      )}

      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h2 className='text-lg font-semibold text-brand-navy'>
          Cases waiting for you
        </h2>
        {!loading && !error && (
          <p className='text-sm tabular-nums text-muted-foreground'>
            {visibleCases.length}{' '}
            {visibleCases.length === 1 ? 'case' : 'cases'}
          </p>
        )}
      </div>

      {/* A region that is always present, so a screen reader reliably hears
          each change of state rather than a region appearing mid-update. */}
      <span role='status' className='sr-only'>
        {loading ? 'Loading the case queue' : ''}
      </span>

      <div className='space-y-3'>
        {loading && (
          <div className='space-y-3' aria-busy='true'>
            {Array.from({ length: 3 }).map((_, index) => (
              <Card key={index}>
                <CardContent className='space-y-3 p-5'>
                  <Skeleton className='h-5 w-24' />
                  <Skeleton className='h-4 w-56' />
                  <Skeleton className='h-4 w-72' />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        {visibleCases.map((item) => {
          const contextEntries = Object.entries(
            item.sanitized_context ?? {}
          ).filter(
            ([key, value]) =>
              safeContextLabels[key] && value !== null && value !== ''
          )
          const canClaim = item.status === 'open'
          const canReview = item.status === 'in_review'
          const canResolve = ['in_review', 'awaiting_external_update'].includes(
            item.status
          )
          const isPayroll = item.case_type === 'payroll'
          const managerState = managerStates[item.case_id]
          const canAcknowledgeManager =
            managerState?.current_state === 'delivered'
          const canCloseManagerAction =
            !isManagerOnly && managerState?.current_state === 'acknowledged'
          const canEscalateManager =
            !isManagerOnly &&
            managerState &&
            ['delivered', 'acknowledged'].includes(managerState.current_state)
          const hasActions = Boolean(
            canClaim ||
              (canReview && !managerState) ||
              canResolve ||
              (managerState &&
                (canAcknowledgeManager ||
                  canCloseManagerAction ||
                  canEscalateManager))
          )

          return (
            <Card key={item.case_id}>
              {/* One shape for every case: what happened on the left, what you
                  can do about it in a column that starts at the same place on
                  every card. */}
              <CardContent className='grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_17rem]'>
                <div className='min-w-0 space-y-3'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <span
                      className={`rounded-full border px-2 py-1 text-xs font-semibold uppercase ${
                        priorityStyles[item.priority] ?? priorityStyles.low
                      }`}
                    >
                      {item.priority} priority
                    </span>
                    <span className='text-sm text-muted-foreground'>
                      {statusLabels[item.status]}
                    </span>
                    {isPayroll && (
                      <span className='rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800'>
                        Pay case
                      </span>
                    )}
                  </div>

                  <div>
                    <h3 className='font-semibold capitalize text-brand-navy'>
                      {item.case_type.replaceAll('_', ' ')}
                    </h3>
                    <p className='mt-1 text-sm text-muted-foreground'>
                      Employee {item.employee_id || 'not recorded'}
                    </p>
                  </div>

                  {item.recommended_action && (
                    <p className='text-sm text-foreground'>
                      {item.recommended_action}
                    </p>
                  )}

                  {managerState ? (
                    <ManagerState state={managerState} />
                  ) : item.case_type === 'manager_accountability' ? (
                    <p className='text-xs text-amber-700'>
                      There is no confirmed record of what the manager has done
                      on this case yet.
                    </p>
                  ) : null}

                  {contextEntries.length > 0 && !isPayroll && (
                    <dl className='grid gap-x-6 gap-y-3 border-t border-border/60 pt-3 text-xs sm:grid-cols-2'>
                      {contextEntries.map(([key, value]) => (
                        <div key={key}>
                          <dt className='text-muted-foreground'>
                            {safeContextLabels[key]}
                          </dt>
                          <dd className='mt-0.5 break-words font-medium text-foreground'>
                            {contextValue(key, value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {isPayroll && (
                    <p className='border-t border-border/60 pt-3 text-xs text-muted-foreground'>
                      Pay amounts and reasons are never shown here. The payroll
                      team works this case in their own process.
                    </p>
                  )}
                </div>

                <div className='space-y-2 lg:border-l lg:border-border/60 lg:pl-5'>
                  <p className='text-[11px] font-semibold uppercase tracking-widest text-muted-foreground'>
                    What you can do
                  </p>
                  {!hasActions && (
                    <p className='text-sm text-muted-foreground'>
                      Nothing is waiting on you for this case right now.
                    </p>
                  )}
                  <div className='flex flex-col gap-2 [&>button]:w-full'>
                    {canClaim && (
                      <Button
                        loading={busy === item.case_id}
                        onClick={() => action(item, 'claim')}
                      >
                        Claim case
                      </Button>
                    )}
                    {canReview && !managerState && (
                      <>
                        <Button
                          variant='ghost'
                          disabled={busy === item.case_id}
                          onClick={() => action(item, 'acknowledge')}
                        >
                          Log a review
                        </Button>
                        <Button
                          variant='outline'
                          disabled={busy === item.case_id}
                          onClick={() => action(item, 'await_external_update')}
                        >
                          Wait for an external update
                        </Button>
                      </>
                    )}
                    {managerState && canAcknowledgeManager && (
                      <Button
                        loading={busy === item.case_id}
                        onClick={() =>
                          managerAction(managerState, 'acknowledged')
                        }
                      >
                        Acknowledge the nudge
                      </Button>
                    )}
                    {managerState && canCloseManagerAction && (
                      <Button
                        loading={busy === item.case_id}
                        onClick={() =>
                          managerAction(managerState, 'action_verified')
                        }
                      >
                        Confirm the action was taken
                      </Button>
                    )}
                    {managerState && canEscalateManager && (
                      <Button
                        variant='ghost'
                        disabled={busy === item.case_id}
                        onClick={() => managerAction(managerState, 'escalated')}
                      >
                        Escalate this case
                      </Button>
                    )}
                    {canResolve && (
                      <>
                        <Select
                          value={resolutionCodes[item.case_id]}
                          onValueChange={(value: ResolutionCode) => {
                            setCaseError(item.case_id, null)
                            setResolutionCodes((current) => ({
                              ...current,
                              [item.case_id]: value,
                            }))
                          }}
                        >
                          <SelectTrigger
                            id={`resolution-${item.case_id}`}
                            className='w-full'
                            aria-label={`How the ${item.case_type.replaceAll('_', ' ')} case was resolved`}
                            aria-invalid={
                              caseErrors[item.case_id] ? true : undefined
                            }
                          >
                            <SelectValue placeholder='How was it resolved?' />
                          </SelectTrigger>
                          <SelectContent>
                            {resolutionOptions.map((option) => (
                              <SelectItem
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {/* Kept enabled: a disabled action cannot explain what
                            is still missing. */}
                        <Button
                          loading={busy === item.case_id}
                          onClick={() => action(item, 'resolve')}
                        >
                          Resolve case
                        </Button>
                      </>
                    )}
                  </div>

                  {canReview && !managerState && (
                    <p className='text-xs text-muted-foreground'>
                      Logging a review records that you looked at the case and
                      keeps it open. Only resolving it closes the case.
                    </p>
                  )}

                  {caseErrors[item.case_id] && (
                    <p role='alert' className='text-sm text-destructive'>
                      {caseErrors[item.case_id]}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })}
        {!loading && !error && visibleCases.length === 0 && (
          <Card>
            <CardContent className='flex items-start gap-3 p-8'>
              <Icons.checkCircle className='mt-0.5 h-5 w-5 shrink-0 text-emerald-600' />
              <div className='space-y-1 text-sm'>
                <p className='font-medium text-brand-navy'>
                  No cases are waiting for you
                </p>
                <p className='text-muted-foreground'>
                  Cases land here when a reassessment finds a risk that needs a
                  person to decide on it.
                </p>
                <Button asChild size='sm' variant='outline' className='mt-3'>
                  <Link href='/runs'>
                    Start a reassessment
                    <Icons.arrowRight className='h-4 w-4' />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
