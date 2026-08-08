'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Icons } from '@/components/ui/icons'
import { MagnitudeBars } from '@/components/charts/MagnitudeBars'
import { cn } from '@/lib/utils'
import type { StreamState } from '@/hooks/useRunStream'
import {
  PHASE_BADGE,
  PHASE_LABEL,
  formatElapsed,
  formatTimestamp,
  isTerminalPhase,
  phaseSentence,
  reasonRequestLabel,
  runPhase,
  runSubject,
  summariseRun,
} from '@/lib/runs'
import type { RunEvent, RunRecord, StageState } from '@/lib/runs'

function StageMarker({ state }: { state: StageState }) {
  return (
    <span
      aria-hidden='true'
      className='mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center'
    >
      {state === 'done' && (
        <Icons.checkCircle className='h-5 w-5 text-emerald-600' />
      )}
      {state === 'active' && (
        <Icons.loader className='h-5 w-5 animate-spin text-brand-cornflower' />
      )}
      {state === 'pending' && (
        <Icons.circle className='h-4 w-4 text-muted-foreground/50' />
      )}
      {state === 'stopped' && (
        <Icons.minus className='h-4 w-4 text-muted-foreground/70' />
      )}
    </span>
  )
}

const STAGE_STATE_WORDING: Record<StageState, string> = {
  done: 'done',
  active: 'in progress',
  pending: 'not started yet',
  stopped: 'not reached',
}

function liveSentence(state: StreamState, terminal: boolean): string | null {
  if (terminal) return null
  switch (state) {
    case 'connecting':
      return 'Connecting to live updates…'
    case 'live':
      return 'Live updates are on.'
    case 'reconnecting':
      return 'Reconnecting to live updates. Progress so far is kept.'
    case 'unavailable':
      return 'Live updates are paused. The status below is refreshed every few seconds.'
    default:
      return null
  }
}

export type RunPanelProps = {
  run: RunRecord
  events: RunEvent[]
  streamState: StreamState
  streamProblem: string | null
  resynchronised: boolean
  cancelRequested: boolean
  canCancel: boolean
  cancelling: boolean
  actionMessage: string | null
  onRequestCancel: () => void
  onRefresh: () => void
}

export function RunPanel({
  run,
  events,
  streamState,
  streamProblem,
  resynchronised,
  cancelRequested,
  canCancel,
  cancelling,
  actionMessage,
  onRequestCancel,
  onRefresh,
}: RunPanelProps) {
  const phase = runPhase(run.status, cancelRequested)
  const terminal = isTerminalPhase(phase)
  const summary = useMemo(
    () => summariseRun(run, events, cancelRequested),
    [run, events, cancelRequested]
  )

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (terminal) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [terminal])

  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2500)
    return () => clearTimeout(timer)
  }, [copied])

  const elapsed = formatElapsed(run.created_at, now)
  // The bars are drawn against the most common finding, so the tallest is full
  // width and the rest are read against it.
  const mostCommonFinding = Math.max(
    1,
    ...summary.findings.map((finding) => finding.count)
  )
  const live = liveSentence(streamState, terminal)
  const stopsSoon = phase === 'stopping'

  const copyReference = async () => {
    try {
      await navigator.clipboard.writeText(run.command_id)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Card>
      <CardContent className='space-y-5 p-5'>
        <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
          <div className='min-w-0'>
            <div className='flex flex-wrap items-center gap-2'>
              <span
                className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${PHASE_BADGE[phase]}`}
              >
                {PHASE_LABEL[phase]}
              </span>
              {run.trigger_source && run.trigger_source !== 'command_center' && (
                <span className='inline-flex w-fit rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700'>
                  Started outside the Command Center
                </span>
              )}
            </div>
            {/* Sits under the page's "Live progress" heading, so it is the
                level below it. */}
            <h3 className='mt-2 truncate text-lg font-semibold text-brand-navy'>
              Reassessment of {runSubject(run).toLowerCase()}
            </h3>
            <p className='mt-1 text-sm text-muted-foreground'>
              Requested {formatTimestamp(run.created_at)}
              {run.requested_reason
                ? ` · ${reasonRequestLabel(run.requested_reason)}`
                : ''}
            </p>
          </div>

          <div className='flex shrink-0 items-center gap-2'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={onRefresh}
              aria-label='Check for the latest status'
            >
              <Icons.refresh className='h-4 w-4' />
              <span className='hidden sm:inline'>Check again</span>
            </Button>
            {canCancel && !terminal && (
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={cancelling || cancelRequested}
                onClick={onRequestCancel}
              >
                <span className='inline-flex h-4 w-4 items-center justify-center'>
                  {cancelling ? (
                    <Icons.loader className='h-4 w-4 animate-spin' />
                  ) : (
                    <Icons.close className='h-4 w-4' />
                  )}
                </span>
                {cancelRequested ? 'Stopping' : 'Stop reassessment'}
              </Button>
            )}
          </div>
        </div>

        {/* One honest sentence, announced to screen readers on every change. */}
        <div
          role='status'
          aria-live='polite'
          className='rounded-lg border border-brand-cornflower/30 bg-brand-cornflower/5 p-3 text-sm text-foreground'
        >
          {phaseSentence(phase, run)}
          {/* The ticking timer is hidden from assistive technology so the live
              region announces status changes, not every passing second. */}
          {!terminal && elapsed ? (
            /* Equal-width digits: this value changes every second and would
               otherwise nudge the sentence around it. */
            <span
              aria-hidden='true'
              className='tabular-nums text-muted-foreground'
            >
              {' '}
              Running for {elapsed}.
            </span>
          ) : null}
          {live ? (
            <span className='text-muted-foreground'> {live}</span>
          ) : null}
        </div>

        {stopsSoon && (
          <p className='text-sm text-amber-800'>
            Checks already finished keep their results. Nothing that was
            recorded is undone.
          </p>
        )}

        {resynchronised && (
          <p className='text-xs text-muted-foreground'>
            Progress was rebuilt from the full record, so nothing is missing.
          </p>
        )}

        {/* The four steps as one line of travel, so how far it has got is
            readable at a glance rather than counted down a list. */}
        <ol className='flex items-start'>
          {summary.stages.map((stage, index) => (
            <li
              key={stage.key}
              className='relative flex min-w-0 flex-1 flex-col items-center text-center'
            >
              {index > 0 && (
                <span
                  aria-hidden='true'
                  className={cn(
                    'absolute left-0 top-2.5 h-0.5 w-1/2 -translate-x-1/2',
                    stage.state === 'pending' || stage.state === 'stopped'
                      ? 'bg-border'
                      : 'bg-brand-cornflower'
                  )}
                />
              )}
              <StageMarker state={stage.state} />
              <p
                className={cn(
                  'mt-1.5 px-1 text-xs',
                  stage.state === 'pending' || stage.state === 'stopped'
                    ? 'text-muted-foreground'
                    : 'font-medium text-foreground'
                )}
              >
                {stage.label}
                <span className='sr-only'>
                  {' '}
                  — {STAGE_STATE_WORDING[stage.state]}
                </span>
              </p>
              {stage.detail && (
                <p className='px-1 text-[11px] text-muted-foreground'>
                  {stage.detail}
                </p>
              )}
            </li>
          ))}
        </ol>

        {summary.trouble && (
          <div className='rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900'>
            {summary.trouble}
          </div>
        )}

        {streamProblem && (
          <div className='rounded-lg border border-destructive/30 bg-red-50 p-3 text-sm text-destructive'>
            {streamProblem}
          </div>
        )}

        {actionMessage && (
          <div
            role='status'
            className='rounded-lg border border-brand-cornflower/30 p-3 text-sm text-muted-foreground'
          >
            {actionMessage}
          </div>
        )}

        {(summary.findings.length > 0 || summary.casesTouched > 0) && (
          <div className='space-y-3 border-t border-border/60 pt-4'>
            <h4 className='text-sm font-semibold text-brand-navy'>
              What this reassessment found
            </h4>
            {summary.findings.length > 0 ? (
              <MagnitudeBars
                items={summary.findings.map((finding) => ({
                  key: finding.code,
                  label: finding.label,
                  value:
                    finding.count === 1 ? 'once' : `${finding.count} times`,
                  share: (finding.count / mostCommonFinding) * 100,
                }))}
              />
            ) : null}
            {summary.casesTouched > 0 && (
              <div className='flex flex-wrap items-center gap-3'>
                <p className='text-sm text-muted-foreground'>
                  {summary.casesTouched === 1
                    ? '1 case was opened or updated for a person to review.'
                    : `${summary.casesTouched} cases were opened or updated for a person to review.`}
                </p>
                <Button asChild size='sm' variant='outline'>
                  <Link href='/workbench'>
                    Open the Workbench
                    <Icons.arrowRight className='h-4 w-4' />
                  </Link>
                </Button>
              </div>
            )}
          </div>
        )}

        {terminal && summary.findings.length === 0 && summary.casesTouched === 0 && (
          <p className='border-t border-border/60 pt-4 text-sm text-muted-foreground'>
            {phase === 'completed'
              ? 'No new risks were found, so nothing was added to the Workbench.'
              : 'Nothing was added to the Workbench for this reassessment.'}
          </p>
        )}

        <details className='group border-t border-border/60 pt-4'>
          <summary className='cursor-pointer list-none text-xs font-medium text-muted-foreground outline-none transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand-cornflower/50'>
            <span className='inline-flex items-center gap-1'>
              <Icons.chevronRight className='h-3 w-3 transition-transform group-open:rotate-90' />
              Details for support
            </span>
          </summary>
          <div className='mt-3 space-y-2'>
            <p className='text-xs text-muted-foreground'>
              Share this reference if you need to ask your platform support team
              about this reassessment.
            </p>
            <div className='flex items-center gap-2'>
              <code className='min-w-0 flex-1 truncate rounded-md bg-slate-50 px-2 py-1.5 font-mono text-xs text-muted-foreground'>
                {run.command_id}
              </code>
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() => void copyReference()}
              >
                <span className='inline-flex h-4 w-4 items-center justify-center'>
                  {copied ? (
                    <Icons.check className='h-4 w-4' />
                  ) : (
                    <Icons.copy className='h-4 w-4' />
                  )}
                </span>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}
