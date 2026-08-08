'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { useSession } from 'next-auth/react'
import apiClient from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Icons } from '@/components/ui/icons'
import { cn } from '@/lib/utils'
import { CaseMetricsPanel } from '@/components/insights/CaseMetricsPanel'
import { CohortBottlenecksPanel } from '@/components/insights/CohortBottlenecksPanel'
import { InsightNote } from '@/components/insights/InsightNote'
import {
  caseMetricsFailure,
  caseQueueFailure,
  cohortTwinFailure,
  isAccessRefusal,
  loadInsightsView,
  mayReadCaseMetrics,
  mayReadCohortTwin,
  saveInsightsView,
  type CaseMetrics,
  type InsightsView,
  type Loadable,
  type OperationalTwin,
  type WorkbenchCase,
} from '@/lib/insights'

const VIEW_OPTIONS: Array<{
  value: InsightsView
  label: string
  icon: ComponentType<{ className?: string }>
}> = [
  { value: 'breakdown', label: 'Breakdown', icon: Icons.barChart },
  { value: 'matrix', label: 'Priority matrix', icon: Icons.grid },
]

export default function InsightsPage() {
  const { data: session, status: sessionStatus } = useSession()
  const roles = useMemo(() => new Set(session?.roles ?? []), [session?.roles])

  // Until the sign-in has resolved, the role set is not yet knowable and no
  // conclusion about access may be drawn from it.
  const sessionReady = sessionStatus !== 'loading'
  const canReadCaseMetrics = sessionReady && mayReadCaseMetrics(roles)
  const canReadCohortTwin = sessionReady && mayReadCohortTwin(roles)
  const hasAnyAccess = canReadCaseMetrics || canReadCohortTwin

  const [caseMetrics, setCaseMetrics] = useState<Loadable<CaseMetrics>>({
    status: 'loading',
  })
  const [twin, setTwin] = useState<Loadable<OperationalTwin>>({
    status: 'loading',
  })
  const [queue, setQueue] = useState<Loadable<WorkbenchCase[]>>({
    status: 'loading',
  })
  const [queueFetchedAt, setQueueFetchedAt] = useState<string | null>(null)
  const [cohort, setCohort] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const twinRequest = useRef(0)

  // The stored choice is read after mount so the first client render always
  // matches the server-rendered markup.
  const [view, setView] = useState<InsightsView>('breakdown')
  useEffect(() => setView(loadInsightsView()), [])

  const chooseView = useCallback((next: InsightsView) => {
    setView(next)
    saveInsightsView(next)
  }, [])

  /**
   * The two requests are deliberately independent. The cohort analysis accepts
   * a narrower set of roles than the case figures, so a payroll reviewer gets
   * an expected refusal on one of them; folding both into a single awaited
   * batch would let that refusal hide figures the same person may read.
   */
  const loadCaseMetrics = useCallback(async () => {
    if (!sessionReady) return
    if (!canReadCaseMetrics) {
      setCaseMetrics({ status: 'restricted' })
      return
    }
    try {
      const data = await apiClient<CaseMetrics>('/api/hr/insights')
      setCaseMetrics({ status: 'ready', data })
    } catch (error) {
      if (isAccessRefusal(error)) {
        setCaseMetrics({ status: 'restricted' })
        return
      }
      const message = caseMetricsFailure(error)
      // Figures already on screen are kept and labelled, rather than blanked.
      setCaseMetrics((current) =>
        current.status === 'ready'
          ? { ...current, staleNotice: message }
          : { status: 'failed', message }
      )
    }
  }, [canReadCaseMetrics, sessionReady])

  /**
   * The itemised half of the same case population. The server applies an
   * identical payroll scope and manager narrowing to this list and to the
   * counted figures, so the matrix can never show a case the breakdown did not
   * count — and the panel reconciles the two totals to prove it.
   *
   * It is fetched only once the matrix is actually asked for, and it is gated by
   * the same capability as the figures rather than being awaited alongside the
   * cohort analysis, which answers to a narrower set of roles.
   */
  const loadQueue = useCallback(async () => {
    if (!sessionReady) return
    if (!canReadCaseMetrics) {
      setQueue({ status: 'restricted' })
      return
    }
    try {
      const result = await apiClient<{ cases: WorkbenchCase[] }>(
        '/api/hr/cases'
      )
      setQueueFetchedAt(new Date().toISOString())
      setQueue({ status: 'ready', data: result.cases })
    } catch (error) {
      if (isAccessRefusal(error)) {
        setQueue({ status: 'restricted' })
        return
      }
      const message = caseQueueFailure(error)
      setQueue((current) =>
        current.status === 'ready'
          ? { ...current, staleNotice: message }
          : { status: 'failed', message }
      )
    }
  }, [canReadCaseMetrics, sessionReady])

  const loadTwin = useCallback(
    async (group: string, showPending: boolean) => {
      if (!sessionReady) return
      if (!canReadCohortTwin) {
        setTwin({ status: 'restricted' })
        return
      }
      const requestId = twinRequest.current + 1
      twinRequest.current = requestId
      if (showPending) setTwin({ status: 'loading' })

      const trimmed = group.trim()
      const query = trimmed ? `?cohort=${encodeURIComponent(trimmed)}` : ''
      try {
        const data = await apiClient<OperationalTwin>(
          `/api/hr/insights/operational-twin${query}`
        )
        if (twinRequest.current !== requestId) return
        setTwin({ status: 'ready', data })
      } catch (error) {
        if (twinRequest.current !== requestId) return
        if (isAccessRefusal(error)) {
          setTwin({ status: 'restricted' })
          return
        }
        const message = cohortTwinFailure(error)
        setTwin((current) =>
          current.status === 'ready'
            ? { ...current, staleNotice: message }
            : { status: 'failed', message }
        )
      }
    },
    [canReadCohortTwin, sessionReady]
  )

  useEffect(() => {
    void loadCaseMetrics()
  }, [loadCaseMetrics])

  useEffect(() => {
    void loadTwin(cohort, true)
  }, [loadTwin, cohort])

  useEffect(() => {
    if (view === 'matrix') void loadQueue()
  }, [loadQueue, view])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    // No loader rejects: each one records its own outcome, so one section
    // failing never blanks another.
    await Promise.allSettled([
      loadCaseMetrics(),
      loadTwin(cohort, false),
      view === 'matrix' ? loadQueue() : Promise.resolve(),
    ])
    setRefreshing(false)
  }, [cohort, loadCaseMetrics, loadQueue, loadTwin, view])

  return (
    <div className='space-y-6'>
      <div className='flex flex-col justify-between gap-4 sm:flex-row sm:items-end'>
        <div>
          <p className='text-sm font-medium text-brand-cornflower'>
            Governed measurement
          </p>
          <h1 className='text-display-3 font-bold tracking-tight text-brand-navy'>
            Insights
          </h1>
          <p className='mt-2 max-w-2xl text-muted-foreground'>
            How much onboarding work is open right now, and which shared
            dependency is holding up a whole group. Both are measured against
            the policy version in force, so every figure can be traced back to
            the rules that produced it.
          </p>
        </div>
        {(!sessionReady || hasAnyAccess) && (
          <Button
            variant='outline'
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <Icons.refresh
              className={cn('h-4 w-4', refreshing && 'animate-spin')}
            />
            {refreshing ? 'Refreshing' : 'Refresh'}
          </Button>
        )}
      </div>

      {sessionReady && !hasAnyAccess ? (
        <Card>
          <CardContent className='p-5'>
            <InsightNote
              tone='restricted'
              title='You do not have access to this view'
              titleAs='h2'
              badge='No access'
            >
              <p>
                Insights are available to HR administrators, People Ops, payroll
                reviewers and managers. Your account does not currently hold any
                of those roles, so no figures can be shown here.
              </p>
              <p>
                Ask an HR administrator to grant you the access your work needs.
                Nothing is wrong with the data itself.
              </p>
            </InsightNote>
          </CardContent>
        </Card>
      ) : (
        <>
          <section aria-labelledby='case-load-heading' className='space-y-3'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <h2
                id='case-load-heading'
                className='text-lg font-semibold text-brand-navy'
              >
                Case load
              </h2>
              {/* One control, above everything it scopes. Both options read the
                  same open cases; only the presentation changes. */}
              <div
                role='group'
                aria-label='Case load presentation'
                className='flex items-center gap-1 rounded-full border border-border/70 bg-white p-1'
              >
                {VIEW_OPTIONS.map((option) => {
                  const Icon = option.icon
                  const active = view === option.value
                  return (
                    <Button
                      key={option.value}
                      size='sm'
                      variant={active ? 'default' : 'ghost'}
                      aria-pressed={active}
                      onClick={() => chooseView(option.value)}
                    >
                      <Icon className='h-4 w-4' />
                      {option.label}
                    </Button>
                  )
                })}
              </div>
            </div>
            <CaseMetricsPanel
              state={caseMetrics}
              view={view}
              queue={queue}
              queueFetchedAt={queueFetchedAt}
              roles={roles}
              onRetry={() => void loadCaseMetrics()}
              onRetryQueue={() => void loadQueue()}
            />
          </section>

          <section aria-labelledby='cohort-heading' className='space-y-3'>
            <h2
              id='cohort-heading'
              className='text-lg font-semibold text-brand-navy'
            >
              Cohort bottlenecks
            </h2>
            {view === 'matrix' && (
              <p className='text-sm text-muted-foreground'>
                Shared blockers are not on the grid. The analysis reports how
                many people a team is holding up, but records nothing about how
                long it has been holding them up, so there is no honest way to
                place a team on a time axis. It keeps its own presentation
                below, unchanged.
              </p>
            )}
            <CohortBottlenecksPanel
              state={twin}
              roles={roles}
              cohort={cohort}
              onApplyCohort={setCohort}
              onRetry={() => void loadTwin(cohort, true)}
            />
          </section>
        </>
      )}
    </div>
  )
}
