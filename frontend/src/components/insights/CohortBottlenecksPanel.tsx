'use client'

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Icons } from '@/components/ui/icons'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { InsightNote } from '@/components/insights/InsightNote'
import { ShareBar } from '@/components/insights/ShareBar'
import {
  clearSentence,
  cohortOutcome,
  cohortPopulation,
  cohortProvenanceHint,
  emptyScopeSentence,
  findingsSentence,
  formatMoment,
  rankedBottlenecks,
  thresholdSentence,
  withheldSentence,
  type Loadable,
  type OperationalTwin,
} from '@/lib/insights'

export function CohortBottlenecksPanel({
  state,
  roles,
  cohort,
  onApplyCohort,
  onRetry,
}: {
  state: Loadable<OperationalTwin>
  roles: ReadonlySet<string>
  /** The group the shown result belongs to. An empty string means all groups. */
  cohort: string
  onApplyCohort: (value: string) => void
  onRetry: () => void
}) {
  const [draft, setDraft] = useState(cohort)
  const inputRef = useRef<HTMLInputElement>(null)

  // Keep the box in step when the applied group is changed from elsewhere.
  useEffect(() => setDraft(cohort), [cohort])

  const data = state.status === 'ready' ? state.data : null
  const outcome = data ? cohortOutcome(data) : null
  const ranked = useMemo(() => (data ? rankedBottlenecks(data) : []), [data])
  const appliedCohort = cohort.trim() ? cohort.trim() : null
  const population = cohortPopulation(roles, appliedCohort)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    onApplyCohort(draft.trim())
  }

  const clear = () => {
    setDraft('')
    onApplyCohort('')
    inputRef.current?.focus()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-lg'>
          <Icons.network className='h-5 w-5 text-brand-cornflower' />
          Shared blockers by group
        </CardTitle>
        <CardDescription>
          Which team is holding up a whole group of new joiners on their Day-1
          dependencies. Individual people are never named here, and results are
          only reported for groups large enough to stay anonymous.
        </CardDescription>
      </CardHeader>

      <CardContent className='space-y-4'>
        {state.status === 'ready' && state.staleNotice && (
          <InsightNote
            tone='problem'
            title='This analysis is not up to date'
            footer={
              <Button size='sm' variant='outline' onClick={onRetry}>
                <Icons.refresh className='mr-2 h-4 w-4' />
                Try again
              </Button>
            }
          >
            <p>{state.staleNotice}</p>
            <p>
              You are still seeing the analysis made at{' '}
              {formatMoment(state.data.as_of)}.
            </p>
          </InsightNote>
        )}

        {state.status !== 'restricted' && (
          <form
            className='flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/30 p-4 sm:flex-row sm:items-end'
            onSubmit={submit}
          >
            <div className='flex-1 space-y-2'>
              <Label htmlFor='cohort-filter'>Group name</Label>
              <Input
                id='cohort-filter'
                ref={inputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder='All groups'
                autoComplete='off'
                spellCheck={false}
                aria-describedby='cohort-filter-hint'
              />
              <p
                id='cohort-filter-hint'
                className='text-xs text-muted-foreground'
              >
                Type the onboarding group exactly as HR records it, or leave it
                empty to look at {cohortPopulation(roles, null)} together. This
                choice changes this section only.
              </p>
            </div>
            <div className='flex gap-2'>
              <Button type='submit' variant='outline'>
                Apply
              </Button>
              {appliedCohort && (
                <Button type='button' variant='ghost' onClick={clear}>
                  Clear
                </Button>
              )}
            </div>
          </form>
        )}

        {appliedCohort && state.status !== 'restricted' && (
          <p className='text-sm text-muted-foreground'>
            Showing{' '}
            <span className='font-medium text-brand-navy'>
              {cohortPopulation(roles, appliedCohort)}
            </span>
            .
          </p>
        )}

        <div
          className='min-h-[13rem]'
          aria-live='polite'
          aria-busy={state.status === 'loading'}
        >
          {state.status === 'loading' && (
            <div className='space-y-3'>
              <Skeleton className='h-4 w-3/4' />
              {Array.from({ length: 3 }).map((_, index) => (
                <div key={index} className='space-y-2 rounded-xl border p-4'>
                  <div className='flex items-baseline justify-between gap-3'>
                    <Skeleton className='h-4 w-32' />
                    <Skeleton className='h-4 w-20' />
                  </div>
                  <Skeleton className='h-1.5 w-full' />
                </div>
              ))}
            </div>
          )}

          {state.status === 'restricted' && (
            <InsightNote
              tone='restricted'
              title='You do not have access to group analysis'
              badge='No access'
            >
              <p>
                Group analysis is available to HR administrators, People Ops and
                managers. A payroll reviewer can see the case figures above but
                not this section, because it draws on the whole workforce rather
                than on payroll alone.
              </p>
              <p>
                Ask an HR administrator to grant you access if you need it for
                your work.
              </p>
            </InsightNote>
          )}

          {state.status === 'failed' && (
            <InsightNote
              tone='problem'
              title='This group could not be analyzed'
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

          {data && outcome === 'empty' && (
            <InsightNote tone='neutral' title='There was nobody to analyze'>
              <p>{emptyScopeSentence(roles, appliedCohort)}</p>
            </InsightNote>
          )}

          {data && outcome === 'withheld' && (
            <InsightNote
              tone='protected'
              title='Results are withheld to protect a small group'
              badge='Privacy protection'
              footer={
                data.policy_version ? (
                  <p>
                    The minimum group size of {data.minimum_cohort_size} is set
                    in policy version{' '}
                    <span className='break-all font-mono'>
                      {data.policy_version}
                    </span>
                    .
                  </p>
                ) : (
                  <p>
                    The minimum group size of {data.minimum_cohort_size} is the
                    built-in safety default, because no policy version is active
                    right now.
                  </p>
                )
              }
            >
              <p>{withheldSentence(data)}</p>
              <p>
                This is a deliberate privacy rule working as intended. It does
                not mean the group is free of blockers, and nothing has gone
                wrong.
              </p>
              <p>
                Look at a wider group, or clear the group name to see everyone
                you are allowed to see. If this specific group needs attention,
                ask People Ops to review it directly rather than through this
                view.
              </p>
            </InsightNote>
          )}

          {data && outcome === 'clear' && (
            <InsightNote tone='positive' title='No shared blocker to report'>
              <p>{clearSentence(data)}</p>
              {thresholdSentence(data) && <p>{thresholdSentence(data)}</p>}
              <p>
                Individual blockers can still exist below the reporting
                threshold. The Workbench queue is where single cases are
                handled.
              </p>
            </InsightNote>
          )}

          {data && outcome === 'findings' && (
            <div className='space-y-4'>
              <p className='text-sm text-muted-foreground'>
                {findingsSentence(data)}
              </p>
              <div className='overflow-x-auto rounded-xl border border-border/70'>
                <table className='w-full text-left text-sm'>
                  <caption className='sr-only'>
                    Teams holding up {population}, largest first
                  </caption>
                  <thead className='border-b border-border/70 bg-muted/40'>
                    <tr>
                      <th scope='col' className='px-4 py-3 font-medium'>
                        Team
                      </th>
                      <th scope='col' className='px-4 py-3 font-medium'>
                        People held up
                      </th>
                      <th scope='col' className='px-4 py-3 font-medium'>
                        Share of the group
                      </th>
                      <th scope='col' className='px-4 py-3 font-medium'>
                        Recommended next step
                      </th>
                    </tr>
                  </thead>
                  <tbody className='divide-y divide-border/60'>
                    {ranked.map((item) => (
                      <tr key={item.dependency_team} className='align-top'>
                        <th
                          scope='row'
                          className='px-4 py-3 text-left font-medium text-brand-navy'
                        >
                          {item.dependency_team}
                        </th>
                        <td className='whitespace-nowrap px-4 py-3 tabular-nums text-muted-foreground'>
                          {item.affected_workers.toLocaleString()} of{' '}
                          {data.denominator.toLocaleString()}
                        </td>
                        <td className='px-4 py-3'>
                          <p className='tabular-nums text-brand-navy'>
                            {item.affected_percent}%
                          </p>
                          <ShareBar
                            percent={item.affected_percent}
                            tone='warning'
                            className='mt-1.5 min-w-[6rem]'
                          />
                        </td>
                        <td className='px-4 py-3 text-muted-foreground'>
                          {item.recommended_action}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {thresholdSentence(data) && (
                <p className='text-xs text-muted-foreground'>
                  {thresholdSentence(data)}
                </p>
              )}
            </div>
          )}
        </div>

        {data && (
          <div className='space-y-1 border-t border-border/60 pt-4 text-xs text-muted-foreground'>
            <p>
              {data.policy_version ? (
                <>
                  Policy version{' '}
                  <span className='break-all font-mono text-foreground'>
                    {data.policy_version}
                  </span>
                </>
              ) : (
                <>No active policy version</>
              )}{' '}
              · Analyzed at {formatMoment(data.as_of)} · Smallest reportable
              group {data.minimum_cohort_size}
            </p>
            <p>{cohortProvenanceHint(data.policy_version)}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
