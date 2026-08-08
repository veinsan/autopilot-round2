'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Icons } from '@/components/ui/icons'
import { Skeleton } from '@/components/ui/skeleton'
import { InsightNote } from '@/components/insights/InsightNote'
import { CasePriorityMatrix } from '@/components/insights/CasePriorityMatrix'
import { MagnitudeBars } from '@/components/charts/MagnitudeBars'
import {
  caseMetricsPopulation,
  caseMetricsProvenanceHint,
  caseMetricsScopeSentence,
  caseTypeBreakdown,
  formatMoment,
  type CaseMetrics,
  type InsightsView,
  type Loadable,
  type WorkbenchCase,
} from '@/lib/insights'

const VISIBLE_TYPES = 5

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

export function CaseMetricsPanel({
  state,
  view,
  queue,
  queueFetchedAt,
  roles,
  onRetry,
  onRetryQueue,
}: {
  state: Loadable<CaseMetrics>
  view: InsightsView
  queue: Loadable<WorkbenchCase[]>
  /** When the case list arrived, used only if the figures are unavailable. */
  queueFetchedAt: string | null
  roles: ReadonlySet<string>
  onRetry: () => void
  onRetryQueue: () => void
}) {
  const [showAllTypes, setShowAllTypes] = useState(false)

  const data = state.status === 'ready' ? state.data : null
  const breakdown = useMemo(() => (data ? caseTypeBreakdown(data) : []), [data])
  const population = caseMetricsPopulation(roles)
  const visible = showAllTypes ? breakdown : breakdown.slice(0, VISIBLE_TYPES)
  const hiddenCount = breakdown.length - visible.length

  const loadingOrReady = state.status === 'loading' || state.status === 'ready'

  return (
    <div className='space-y-4'>
      {state.status === 'ready' && state.staleNotice && (
        <InsightNote
          tone='problem'
          title='These figures are not up to date'
          footer={
            <Button size='sm' variant='outline' onClick={onRetry}>
              <Icons.refresh className='mr-2 h-4 w-4' />
              Try again
            </Button>
          }
        >
          <p>{state.staleNotice}</p>
          <p>
            You are still seeing the figures counted at{' '}
            {formatMoment(state.data.as_of)}.
          </p>
        </InsightNote>
      )}

      {/* The notes below stand in for the tiles, so a reader is never left
          wondering why the numbers are missing — in either presentation. */}
      {state.status === 'restricted' && (
        <InsightNote
          tone='restricted'
          title='You do not have access to case figures'
          badge='No access'
        >
          <p>
            Case figures are available to HR administrators, People Ops, payroll
            reviewers and managers. Ask an HR administrator to grant you access
            if you need them for your work.
          </p>
        </InsightNote>
      )}

      {state.status === 'failed' && (
        <InsightNote
          tone='problem'
          title='The case figures could not be loaded'
          footer={
            <Button size='sm' variant='outline' onClick={onRetry}>
              <Icons.refresh className='mr-2 h-4 w-4' />
              Try again
            </Button>
          }
        >
          <p>{state.message}</p>
        </InsightNote>
      )}

      {loadingOrReady && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2 text-lg'>
                {view === 'matrix' ? (
                  <Icons.grid className='h-5 w-5 text-brand-cornflower' />
                ) : (
                  <Icons.barChart className='h-5 w-5 text-brand-cornflower' />
                )}
                {view === 'matrix'
                  ? 'What to act on first'
                  : 'Where the open cases sit'}
              </CardTitle>
              <CardDescription>
                {caseMetricsScopeSentence(roles)}
              </CardDescription>
            </CardHeader>
            <CardContent
              className='space-y-4'
              aria-live='polite'
              aria-busy={state.status === 'loading'}
            >
              {view === 'matrix' ? (
                <CasePriorityMatrix
                  queue={queue}
                  metrics={data}
                  referenceIso={data?.as_of ?? queueFetchedAt}
                  population={population}
                  onRetry={onRetryQueue}
                />
              ) : (
                <>
                  {state.status === 'loading' && (
                    <ul className='space-y-3'>
                      {Array.from({ length: 4 }).map((_, index) => (
                        <li key={index} className='space-y-1.5'>
                          <div className='flex items-baseline justify-between gap-3'>
                            <Skeleton className='h-4 w-40' />
                            <Skeleton className='h-4 w-24' />
                          </div>
                          <Skeleton className='h-1.5 w-full' />
                        </li>
                      ))}
                    </ul>
                  )}

                  {data && data.denominator === 0 && (
                    <InsightNote
                      tone='neutral'
                      title='Nothing has been recorded yet'
                    >
                      <p>
                        No cases at all exist for {population}, so there is
                        nothing to count. This view fills in as soon as the
                        first case is raised.
                      </p>
                    </InsightNote>
                  )}

                  {data &&
                    data.denominator > 0 &&
                    data.open_case_count === 0 && (
                      <InsightNote tone='positive' title='No open cases'>
                        <p>
                          Every one of the {data.denominator.toLocaleString()}{' '}
                          {plural(data.denominator, 'case', 'cases')} recorded
                          for {population} has been resolved. Nothing is waiting
                          on a person right now.
                        </p>
                      </InsightNote>
                    )}

                  {data && data.open_case_count > 0 && (
                    <>
                      <div id='case-type-breakdown'>
                        <MagnitudeBars
                          items={visible.map((item) => ({
                            key: item.key,
                            label: item.label,
                            value: `${item.count.toLocaleString()} · ${Math.round(item.percent)}%`,
                            share: item.percent,
                          }))}
                        />
                      </div>
                      {breakdown.length > VISIBLE_TYPES && (
                        <Button
                          size='sm'
                          variant='ghost'
                          aria-expanded={showAllTypes}
                          aria-controls='case-type-breakdown'
                          onClick={() => setShowAllTypes((current) => !current)}
                        >
                          {showAllTypes ? (
                            <Icons.chevronUp className='mr-2 h-4 w-4' />
                          ) : (
                            <Icons.chevronDown className='mr-2 h-4 w-4' />
                          )}
                          {showAllTypes
                            ? 'Show fewer kinds of case'
                            : `Show ${hiddenCount} more ${plural(hiddenCount, 'kind', 'kinds')} of case`}
                        </Button>
                      )}
                      <p className='text-xs text-muted-foreground'>
                        Percentages are the share of the{' '}
                        {data.open_case_count.toLocaleString()} open{' '}
                        {plural(data.open_case_count, 'case', 'cases')}, not of
                        everyone in the group.
                      </p>
                    </>
                  )}
                </>
              )}

              {data && (
                <div className='space-y-1 border-t border-border/60 pt-4 text-xs text-muted-foreground'>
                  <p>
                    {data.policy_version ? (
                      <>
                        Policy in force{' '}
                        <span className='break-all font-mono text-foreground'>
                          {data.policy_version}
                        </span>
                      </>
                    ) : (
                      <>No policy is in force right now</>
                    )}{' '}
                    · Counted at {formatMoment(data.as_of)}
                  </p>
                  <p>{caseMetricsProvenanceHint(data.policy_version)}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
