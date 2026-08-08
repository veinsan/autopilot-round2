'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Icons } from '@/components/ui/icons'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  buildPriorityMatrix,
  caseMetricsPopulation,
  caseTypeBreakdown,
  openShare,
  type CaseMetrics,
  type Loadable,
  type WorkbenchCase,
} from '@/lib/insights'

/**
 * The answer to "how are we doing, and what do I do next" before any detail.
 *
 * Three figures and one action. Everything under it explains these numbers; a
 * reader who stops here has still read the important part.
 */
export function HeadlinePanel({
  metrics,
  queue,
  queueFetchedAt,
  roles,
}: {
  metrics: Loadable<CaseMetrics>
  queue: Loadable<WorkbenchCase[]>
  queueFetchedAt: string | null
  roles: ReadonlySet<string>
}) {
  const data = metrics.status === 'ready' ? metrics.data : null
  const cases = queue.status === 'ready' ? queue.data : null
  const reference = data?.as_of ?? queueFetchedAt

  const matrix = useMemo(
    () => (cases && reference ? buildPriorityMatrix(cases, reference) : null),
    [cases, reference]
  )
  const breakdown = useMemo(() => (data ? caseTypeBreakdown(data) : []), [data])
  const share = data ? openShare(data) : null
  const population = caseMetricsPopulation(roles)

  const loading = metrics.status === 'loading'
  const unavailable = metrics.status === 'restricted' || metrics.status === 'failed'
  if (unavailable) return null

  const actFirst = matrix?.actFirstCount ?? null
  const busiest = breakdown[0]

  return (
    <Card>
      <CardContent className='grid gap-6 p-6 lg:grid-cols-[1fr_auto] lg:items-center'>
        <div className='grid gap-6 sm:grid-cols-3'>
          <Figure
            label='Open cases'
            value={loading ? null : (data?.open_case_count ?? 0).toLocaleString()}
            note={
              share === null
                ? `for ${population}`
                : `${Math.round(share)}% of everything ever recorded for ${population}`
            }
            emphasis
          />
          <Figure
            label='Need attention first'
            value={loading || actFirst === null ? null : actFirst.toLocaleString()}
            note={
              actFirst === null
                ? 'Critical and high priority, open more than three days'
                : actFirst === 0
                  ? 'Nothing critical has been waiting more than three days'
                  : 'Critical or high priority, open more than three days'
            }
            tone={actFirst && actFirst > 0 ? 'urgent' : 'calm'}
          />
          <Figure
            label='Busiest area'
            value={loading ? null : busiest ? busiest.label : 'None'}
            note={
              busiest
                ? `${busiest.count.toLocaleString()} open of ${data?.open_case_count.toLocaleString()}`
                : 'No kind of case has open work right now'
            }
            small
          />
        </div>

        <div className='flex flex-col gap-2 lg:border-l lg:border-border/60 lg:pl-6'>
          <Button asChild variant='gradient'>
            <Link href='/workbench'>
              Open the Workbench
              <Icons.arrowRight className='h-4 w-4' />
            </Link>
          </Button>
          <Button asChild variant='ghost' size='sm'>
            <Link href='/runs'>Run the checks again</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Figure({
  label,
  value,
  note,
  emphasis,
  small,
  tone = 'calm',
}: {
  label: string
  /** `null` while loading, so the row keeps its height. */
  value: string | null
  note: string
  emphasis?: boolean
  small?: boolean
  tone?: 'calm' | 'urgent'
}) {
  return (
    <div className='min-w-0'>
      <p className='text-[11px] font-semibold uppercase tracking-widest text-muted-foreground'>
        {label}
      </p>
      <div className='mt-1 flex h-11 items-center'>
        {value === null ? (
          <Skeleton className='h-9 w-20' />
        ) : (
          <p
            className={cn(
              'truncate font-display font-bold tabular-nums',
              small ? 'text-2xl' : emphasis ? 'text-5xl' : 'text-4xl',
              tone === 'urgent' ? 'text-destructive' : 'text-brand-navy'
            )}
          >
            {value}
          </p>
        )}
      </div>
      <p className='mt-1 text-xs text-muted-foreground'>{note}</p>
    </div>
  )
}
