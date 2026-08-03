'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import apiClient from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Icons } from '@/components/ui/icons'
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

const resolutionOptions: { value: ResolutionCode; label: string }[] = [
  { value: 'DATA_CORRECTED', label: 'Source data corrected' },
  { value: 'EMPLOYEE_SUPPORTED', label: 'Employee support completed' },
  { value: 'DEPENDENCY_CLEARED', label: 'Dependency cleared' },
  {
    value: 'POLICY_EXCEPTION_APPROVED',
    label: 'Policy exception approved',
  },
  { value: 'NO_ACTION_REQUIRED', label: 'No action required' },
  { value: 'ESCALATED_EXTERNALLY', label: 'Escalated externally' },
]

const safeContextLabels: Record<string, string> = {
  reason_code: 'Reason code',
  domain: 'Domain',
  severity: 'Severity',
  policy_version_id: 'Policy version',
  evaluated_at: 'Evaluated at',
  owner: 'Owner',
  recommended_action: 'Recommendation',
}

function ManagerState({ state }: { state: ManagerActionState }) {
  const steps = [
    { key: 'nudge_created', label: 'Nudge created' },
    { key: 'delivered', label: 'Delivered' },
    { key: 'acknowledged', label: 'Acknowledged' },
    { key: 'action_verified', label: 'Action verified' },
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
              <span className='text-xs text-muted-foreground'>→</span>
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
        Successful reminders: {state.successful_reminder_count}
        {state.acknowledgment_deadline
          ? ` · Acknowledgment deadline ${new Date(state.acknowledgment_deadline).toLocaleString('en-GB')}`
          : ''}
        {state.action_deadline
          ? ` · Action deadline ${new Date(state.action_deadline).toLocaleString('en-GB')}`
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
  const [busy, setBusy] = useState<string | null>(null)
  const [resolutionCodes, setResolutionCodes] = useState<
    Record<string, ResolutionCode>
  >({})

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
      setError('Select a resolution code before resolving the case.')
      return
    }
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
      setError(
        actionError instanceof Error
          ? actionError.message
          : 'The action failed.'
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
      setError(null)
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : 'The manager action state could not be updated.'
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className='space-y-6'>
      <div>
        <p className='text-sm font-medium text-brand-cornflower'>
          Human-in-the-loop
        </p>
        <h1 className='text-display-3 font-bold tracking-tight text-brand-navy'>
          HR Workbench
        </h1>
        <p className='mt-2 text-muted-foreground'>
          Cases are closed only by a human after review. A recurring signal can
          reopen the related domain case.
        </p>
      </div>

      {isManagerOnly && (
        <Card className='border-brand-cornflower/30'>
          <CardContent className='p-4 text-sm text-muted-foreground'>
            The backend limits the manager view to direct reports. Payroll and
            confidential cases are not shown in this queue.
          </CardContent>
        </Card>
      )}
      {hiddenPayrollCount > 0 && (
        <Card className='border-amber-300/50'>
          <CardContent className='p-4 text-sm text-amber-800'>
            {hiddenPayrollCount} payroll case(s) are restricted to payroll
            reviewers or Admins.
          </CardContent>
        </Card>
      )}
      {error && (
        <Card className='border-destructive/40'>
          <CardContent className='p-4 text-sm text-destructive'>
            {error}
          </CardContent>
        </Card>
      )}

      <div className='space-y-3'>
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

          return (
            <Card key={item.case_id}>
              <CardContent className='space-y-4 p-5'>
                <div className='flex flex-col justify-between gap-4 lg:flex-row lg:items-start'>
                  <div>
                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='rounded-full bg-brand-cornflower/15 px-2 py-1 text-xs font-semibold uppercase text-brand-navy'>
                        {item.priority}
                      </span>
                      <span className='text-sm text-muted-foreground'>
                        {statusLabels[item.status]}
                      </span>
                      {isPayroll && (
                        <span className='rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800'>
                          Restricted access
                        </span>
                      )}
                    </div>
                    <h2 className='mt-2 font-semibold capitalize text-brand-navy'>
                      {item.case_type.replaceAll('_', ' ')}
                    </h2>
                    <p className='mt-1 text-sm text-muted-foreground'>
                      Employee: {item.employee_id || 'Not available'}
                    </p>
                    {item.recommended_action && (
                      <p className='mt-1 text-sm text-muted-foreground'>
                        {item.recommended_action}
                      </p>
                    )}
                    {managerState ? (
                      <ManagerState state={managerState} />
                    ) : item.case_type === 'manager_accountability' ? (
                      <p className='mt-3 text-xs text-amber-700'>
                        No authoritative manager action state is available for
                        this case.
                      </p>
                    ) : null}
                  </div>

                  <div className='flex max-w-xl flex-wrap items-center justify-end gap-2'>
                    {canClaim && (
                      <Button
                        variant='outline'
                        disabled={busy === item.case_id}
                        onClick={() => action(item, 'claim')}
                      >
                        Claim case
                      </Button>
                    )}
                    {canReview && !managerState && (
                      <>
                        <Button
                          variant='outline'
                          disabled={busy === item.case_id}
                          onClick={() => action(item, 'acknowledge')}
                        >
                          Record review
                        </Button>
                        <Button
                          variant='outline'
                          disabled={busy === item.case_id}
                          onClick={() => action(item, 'await_external_update')}
                        >
                          Await update
                        </Button>
                      </>
                    )}
                    {managerState && canAcknowledgeManager && (
                      <Button
                        variant='outline'
                        disabled={busy === item.case_id}
                        onClick={() =>
                          managerAction(managerState, 'acknowledged')
                        }
                      >
                        Acknowledge nudge
                      </Button>
                    )}
                    {managerState && canCloseManagerAction && (
                      <Button
                        variant='outline'
                        disabled={busy === item.case_id}
                        onClick={() =>
                          managerAction(managerState, 'action_verified')
                        }
                      >
                        Verify action
                      </Button>
                    )}
                    {managerState && canEscalateManager && (
                      <Button
                        variant='outline'
                        disabled={busy === item.case_id}
                        onClick={() => managerAction(managerState, 'escalated')}
                      >
                        Escalate
                      </Button>
                    )}
                    {canResolve && (
                      <>
                        <Select
                          value={resolutionCodes[item.case_id]}
                          onValueChange={(value: ResolutionCode) =>
                            setResolutionCodes((current) => ({
                              ...current,
                              [item.case_id]: value,
                            }))
                          }
                        >
                          <SelectTrigger className='w-56'>
                            <SelectValue placeholder='Resolution code' />
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
                        <Button
                          loading={busy === item.case_id}
                          disabled={!resolutionCodes[item.case_id]}
                          onClick={() => action(item, 'resolve')}
                        >
                          Resolve
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {contextEntries.length > 0 && !isPayroll && (
                  <dl className='grid gap-2 border-t border-border/60 pt-3 text-xs sm:grid-cols-2 lg:grid-cols-3'>
                    {contextEntries.map(([key, value]) => (
                      <div key={key}>
                        <dt className='text-muted-foreground'>
                          {safeContextLabels[key]}
                        </dt>
                        <dd className='mt-0.5 break-words font-medium text-foreground'>
                          {String(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {isPayroll && (
                  <p className='border-t border-border/60 pt-3 text-xs text-muted-foreground'>
                    Payroll reasons and amounts are never shown in the standard
                    Workbench. Use the case reference in the restricted payroll
                    process.
                  </p>
                )}
              </CardContent>
            </Card>
          )
        })}
        {!error && visibleCases.length === 0 && (
          <Card>
            <CardContent className='flex items-center gap-3 p-8 text-muted-foreground'>
              <Icons.checkCircle className='h-5 w-5 text-emerald-600' />
              There are no standard cases available for you to handle.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
