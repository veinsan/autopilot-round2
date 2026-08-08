'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { ApiError, apiClient } from '@/lib/api-client'
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
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Icons } from '@/components/ui/icons'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RunPanel } from '@/components/runs/RunPanel'
import { StartReassessmentDialog } from '@/components/runs/StartReassessmentDialog'
import { useRunStream } from '@/hooks/useRunStream'
import {
  PHASE_BADGE,
  PHASE_LABEL,
  cancelRunMessage,
  forgetRun,
  historyEntryFromRun,
  isTerminalPhase,
  loadRunHistory,
  loadRunMessage,
  newIdempotencyKey,
  rememberRun,
  reasonRequestLabel,
  runPhase,
  runSubject,
  startRunMessage,
  startRunPayload,
  startRunSignature,
} from '@/lib/runs'
import type {
  RunHistoryEntry,
  RunRecord,
  StartRunValues,
} from '@/lib/runs'

function shortTime(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? 'an earlier time'
    : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function historySubtitle(entry: RunHistoryEntry): string {
  const when = shortTime(entry.created_at)
  return entry.requested_reason
    ? `${when} · ${reasonRequestLabel(entry.requested_reason)}`
    : when
}

export default function ReassessmentRunsPage() {
  const { data: session } = useSession()
  const roles = useMemo(() => new Set(session?.roles ?? []), [session?.roles])
  const isAdmin = roles.has('admin')
  const isPeopleOps = roles.has('people_ops')
  const isManagerScoped = roles.has('manager') && !isAdmin && !isPeopleOps

  // Capability contract, copied from the backend guards so the screen never
  // offers something the server will refuse.
  const mayStartRun = isAdmin || isPeopleOps || isManagerScoped
  const mayChooseCohort = isAdmin || isPeopleOps
  const mayFollowRun = mayStartRun
  const mayStopRun = isAdmin || isPeopleOps

  const owner = session?.sub ?? 'local'

  const [history, setHistory] = useState<RunHistoryEntry[]>([])
  const [historyRuns, setHistoryRuns] = useState<Record<string, RunRecord>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [startOpen, setStartOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startMessage, setStartMessage] = useState<string | null>(null)
  const [startedIntents, setStartedIntents] = useState<Record<string, string>>(
    {}
  )
  const idempotencyKeys = useRef<Record<string, string>>({})

  const [confirmStopOpen, setConfirmStopOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopRequested, setStopRequested] = useState<Record<string, boolean>>({})
  const [actionMessage, setActionMessage] = useState<string | null>(null)

  const [lookupOpen, setLookupOpen] = useState(false)
  const [lookupValue, setLookupValue] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupMessage, setLookupMessage] = useState<string | null>(null)

  const panelRef = useRef<HTMLDivElement | null>(null)
  const hydrated = useRef<Set<string>>(new Set())

  const { run, events, streamState, problem, resynchronised, refresh } =
    useRunStream(selectedId, mayFollowRun)

  /* ---------------------------------------------------------------- */
  /* Local history                                                     */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    setHistory(loadRunHistory(owner))
  }, [owner])

  // The API has no endpoint that lists runs, so each remembered reassessment is
  // fetched on its own. `Promise.allSettled` keeps one entry that is gone or
  // out of reach from hiding the others, and the ref stops an entry from being
  // fetched twice.
  useEffect(() => {
    if (!mayFollowRun) return
    const pending = history
      .map((entry) => entry.command_id)
      .filter((id) => !hydrated.current.has(id))
    if (pending.length === 0) return
    for (const id of pending) hydrated.current.add(id)

    let cancelled = false
    void Promise.allSettled(
      pending.map((id) =>
        apiClient.get<RunRecord>(`/api/hr/runs/${encodeURIComponent(id)}`)
      )
    ).then((results) => {
      if (cancelled) return
      const found: Record<string, RunRecord> = {}
      const unreachable: string[] = []
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          found[pending[index]] = result.value
        } else if (
          result.reason instanceof ApiError &&
          (result.reason.status === 403 || result.reason.status === 404)
        ) {
          unreachable.push(pending[index])
        }
      })
      setHistoryRuns((current) => ({ ...current, ...found }))
      if (unreachable.length > 0) {
        let next = history
        for (const id of unreachable) next = forgetRun(owner, id)
        setHistory(next)
      }
    })

    return () => {
      cancelled = true
    }
  }, [history, mayFollowRun, owner])

  // Keep the list badge in step with the run currently being followed.
  useEffect(() => {
    if (!run) return
    setHistoryRuns((current) => ({ ...current, [run.command_id]: run }))
  }, [run])

  /* ---------------------------------------------------------------- */
  /* Starting                                                          */
  /* ---------------------------------------------------------------- */

  const alreadySentAt = useCallback(
    (values: StartRunValues) => {
      const at = startedIntents[startRunSignature(values)]
      return at ? shortTime(at) : null
    },
    [startedIntents]
  )

  const startRun = async (values: StartRunValues, startSeparate: boolean) => {
    if (starting) return
    const signature = startRunSignature(values)

    if (startSeparate) {
      delete idempotencyKeys.current[signature]
      setStartedIntents((current) => {
        const next = { ...current }
        delete next[signature]
        return next
      })
    }

    // One key per operator intent. A second submit of the same details reuses
    // it, so the server returns the run that already exists rather than
    // starting another one.
    let key = idempotencyKeys.current[signature]
    if (!key) {
      key = newIdempotencyKey()
      idempotencyKeys.current[signature] = key
    }

    setStarting(true)
    setStartMessage(null)
    try {
      const created = await apiClient.post<RunRecord>(
        '/api/hr/runs',
        startRunPayload(values),
        { headers: { 'Idempotency-Key': key } }
      )
      setStartedIntents((current) => ({
        ...current,
        [signature]: created.created_at ?? new Date().toISOString(),
      }))
      setHistory(rememberRun(owner, historyEntryFromRun(created)))
      setHistoryRuns((current) => ({ ...current, [created.command_id]: created }))
      setActionMessage(null)
      setSelectedId(created.command_id)
      setStartOpen(false)
      window.setTimeout(() => panelRef.current?.focus(), 0)
    } catch (error) {
      setStartMessage(startRunMessage(error))
    } finally {
      setStarting(false)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Stopping                                                          */
  /* ---------------------------------------------------------------- */

  const stopRun = async () => {
    if (!run || stopping) return
    const id = run.command_id
    setStopping(true)
    try {
      const result = await apiClient.post<{ status?: string }>(
        `/api/hr/runs/${encodeURIComponent(id)}/cancel`
      )
      setConfirmStopOpen(false)
      if (result?.status === 'cancelled') {
        setActionMessage(
          'The reassessment was stopped before it began, so nothing was assessed and no cases were created.'
        )
      } else {
        setStopRequested((current) => ({ ...current, [id]: true }))
        setActionMessage(
          'Stopping the reassessment. The step that is already running finishes first, and everything recorded before now is kept.'
        )
      }
      await refresh()
    } catch (error) {
      setConfirmStopOpen(false)
      setActionMessage(cancelRunMessage(error))
      await refresh()
    } finally {
      setStopping(false)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Opening a run by its support reference                            */
  /* ---------------------------------------------------------------- */

  const openByReference = async () => {
    const reference = lookupValue.trim()
    if (!reference || lookupBusy) return
    setLookupBusy(true)
    setLookupMessage(null)
    try {
      const found = await apiClient.get<RunRecord>(
        `/api/hr/runs/${encodeURIComponent(reference)}`
      )
      setHistory(rememberRun(owner, historyEntryFromRun(found)))
      setHistoryRuns((current) => ({ ...current, [found.command_id]: found }))
      setActionMessage(null)
      setSelectedId(found.command_id)
      setLookupValue('')
      setLookupOpen(false)
      window.setTimeout(() => panelRef.current?.focus(), 0)
    } catch (error) {
      setLookupMessage(loadRunMessage(error))
    } finally {
      setLookupBusy(false)
    }
  }

  const selectRun = (id: string) => {
    setActionMessage(null)
    setSelectedId(id)
    window.setTimeout(() => panelRef.current?.focus(), 0)
  }

  const selectedStopRequested = selectedId
    ? Boolean(stopRequested[selectedId])
    : false

  return (
    <div className='space-y-6'>
      <div className='flex flex-col justify-between gap-4 sm:flex-row sm:items-end'>
        <div>
          <p className='text-sm font-medium text-brand-purple'>
            Checks on demand
          </p>
          <h1 className='text-display-3 font-bold tracking-tight text-brand-navy'>
            Reassessments
          </h1>
          <p className='mt-2 max-w-2xl text-muted-foreground'>
            Run the onboarding and retention checks again for one employee or a
            whole starting group, watch them progress, and see what they found.
          </p>
        </div>
        {mayStartRun && (
          <Button variant='gradient' onClick={() => setStartOpen(true)}>
            <Icons.zap className='h-4 w-4' />
            Start a reassessment
          </Button>
        )}
      </div>

      {!mayStartRun && (
        <Card className='border-brand-cornflower/30'>
          <CardContent className='p-4 text-sm text-muted-foreground'>
            Your account can review HR work but cannot start or follow a
            reassessment. Ask an HR administrator or People Ops if you need it
            run for someone.
          </CardContent>
        </Card>
      )}

      {isManagerScoped && mayStartRun && (
        <div className='flex items-start gap-2 text-sm text-muted-foreground'>
          <Icons.info className='mt-0.5 h-4 w-4 shrink-0 text-brand-purple' />
          <p className='max-w-3xl'>
            You can reassess one of your direct reports at a time. People Ops or
            an administrator stops one that is already running.
          </p>
        </div>
      )}

      {mayStartRun && (
        <div className='grid gap-6 xl:grid-cols-[1.15fr_.85fr]'>
          <div
            ref={panelRef}
            tabIndex={-1}
            className='space-y-3 outline-none'
            aria-label='Selected reassessment'
          >
            <h2 className='text-lg font-semibold text-brand-navy'>
              Live progress
            </h2>
            {selectedId && run ? (
              <RunPanel
                run={run}
                events={events}
                streamState={streamState}
                streamProblem={problem}
                resynchronised={resynchronised}
                cancelRequested={selectedStopRequested}
                canCancel={mayStopRun}
                cancelling={stopping}
                actionMessage={actionMessage}
                onRequestCancel={() => setConfirmStopOpen(true)}
                onRefresh={() => void refresh()}
              />
            ) : selectedId && problem ? (
              <Card className='border-destructive/40'>
                <CardContent className='p-5 text-sm text-destructive'>
                  {problem}
                </CardContent>
              </Card>
            ) : selectedId ? (
              <Card>
                <CardContent className='flex items-center gap-3 p-8 text-sm text-muted-foreground'>
                  <Icons.loader className='h-4 w-4 animate-spin text-brand-cornflower' />
                  Opening this reassessment…
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className='flex items-start gap-3 p-8 text-sm'>
                  <Icons.zap className='mt-0.5 h-5 w-5 shrink-0 text-brand-cornflower' />
                  <div className='space-y-1'>
                    <p className='font-medium text-brand-navy'>
                      Nothing is being followed right now
                    </p>
                    <p className='text-muted-foreground'>
                      Start one, or pick one from the list to see how far it
                      got. Nothing changes on its own — what a reassessment
                      finds becomes a case for a person to decide on.
                    </p>
                    {mayStartRun && (
                      <Button
                        size='sm'
                        variant='outline'
                        className='mt-3'
                        onClick={() => setStartOpen(true)}
                      >
                        <Icons.zap className='h-4 w-4' />
                        Start a reassessment
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* The list stays in view on a desktop while the panel beside it
              grows with events. */}
          <div className='space-y-3 xl:sticky xl:top-24 xl:self-start'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <h2 className='text-lg font-semibold text-brand-navy'>
                Recent reassessments
              </h2>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => setLookupOpen((current) => !current)}
                aria-expanded={lookupOpen}
                aria-controls='run-reference-lookup'
              >
                <Icons.search className='h-4 w-4' />
                Open by reference
              </Button>
            </div>

            <p className='text-xs text-muted-foreground'>
              Remembered on this device only, so a colleague&apos;s list looks
              different from yours.
            </p>

            {lookupOpen && (
              <Card id='run-reference-lookup'>
                <CardContent className='space-y-2 p-4'>
                  <Label htmlFor='run-reference'>
                    Reference from another device
                  </Label>
                  <div className='flex gap-2'>
                    <Input
                      id='run-reference'
                      value={lookupValue}
                      autoComplete='off'
                      placeholder='Paste the reference'
                      disabled={lookupBusy}
                      onChange={(event) => setLookupValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void openByReference()
                        }
                      }}
                    />
                    <Button
                      type='button'
                      variant='outline'
                      disabled={lookupValue.trim().length === 0 || lookupBusy}
                      onClick={() => void openByReference()}
                    >
                      <span className='inline-flex h-4 w-4 items-center justify-center'>
                        {lookupBusy ? (
                          <Icons.loader className='h-4 w-4 animate-spin' />
                        ) : (
                          <Icons.arrowRight className='h-4 w-4' />
                        )}
                      </span>
                      Open
                    </Button>
                  </div>
                  <p className='text-xs text-muted-foreground'>
                    Every reassessment carries a reference under &ldquo;Details
                    for support&rdquo;. Paste one here to follow a reassessment
                    that was started somewhere else.
                  </p>
                  {lookupMessage && (
                    <p role='alert' className='text-sm text-destructive'>
                      {lookupMessage}
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {history.length === 0 ? (
              <Card>
                <CardContent className='p-5 text-sm text-muted-foreground'>
                  No reassessment has been started from this browser yet. The
                  ones you start will be listed here so you can come back to
                  them.
                </CardContent>
              </Card>
            ) : (
              <ul className='space-y-2'>
                {history.map((entry) => {
                  const record = historyRuns[entry.command_id]
                  const phase = runPhase(
                    record?.status,
                    Boolean(stopRequested[entry.command_id])
                  )
                  const isSelected = entry.command_id === selectedId
                  return (
                    <li key={entry.command_id}>
                      <button
                        type='button'
                        onClick={() => selectRun(entry.command_id)}
                        aria-current={isSelected ? 'true' : undefined}
                        className={`w-full rounded-2xl border bg-white p-4 text-left transition hover:border-brand-cornflower/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cornflower/50 ${
                          isSelected
                            ? 'border-brand-cornflower ring-1 ring-brand-cornflower/30'
                            : 'border-border'
                        }`}
                      >
                        <span className='flex items-start justify-between gap-3'>
                          <span className='min-w-0'>
                            <span className='block truncate text-sm font-medium text-brand-navy'>
                              {runSubject(record ?? entry)}
                            </span>
                            <span className='mt-0.5 block truncate text-xs text-muted-foreground'>
                              {historySubtitle(entry)}
                            </span>
                          </span>
                          <span
                            className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                              record
                                ? PHASE_BADGE[phase]
                                : 'border-slate-200 bg-slate-100 text-slate-700'
                            }`}
                          >
                            {record ? PHASE_LABEL[phase] : 'Checking'}
                          </span>
                        </span>
                        {record && !isTerminalPhase(phase) && !isSelected && (
                          <span className='mt-2 block text-xs text-brand-purple'>
                            Still going — open it to follow along.
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      <StartReassessmentDialog
        open={startOpen}
        onOpenChange={(next) => {
          setStartOpen(next)
          if (!next) setStartMessage(null)
        }}
        canChooseCohort={mayChooseCohort}
        submitting={starting}
        message={startMessage}
        alreadySentAt={alreadySentAt}
        onSubmit={(values, startSeparate) => void startRun(values, startSeparate)}
      />

      <AlertDialog
        open={confirmStopOpen}
        onOpenChange={(next) => {
          if (!stopping) setConfirmStopOpen(next)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this reassessment?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className='space-y-2'>
                <p>
                  {run
                    ? `No further checks will run for ${runSubject(run).toLowerCase()}.`
                    : 'No further checks will run.'}{' '}
                  The step that is already running finishes first, so this is
                  not instant.
                </p>
                <p>
                  Findings and cases recorded before it stops are kept and are
                  not undone. Nothing that has already been sent to a manager is
                  withdrawn. You can start the reassessment again at any time.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopping}>
              Keep it running
            </AlertDialogCancel>
            <AlertDialogAction
              className='bg-destructive text-destructive-foreground hover:bg-destructive/90'
              disabled={stopping}
              onClick={(event) => {
                event.preventDefault()
                void stopRun()
              }}
            >
              Stop reassessment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
