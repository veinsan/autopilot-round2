'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, apiClient } from '@/lib/api-client'
import { isTerminalPhase, loadRunMessage, runPhase } from '@/lib/runs'
import type { RunEvent, RunRecord } from '@/lib/runs'

/**
 * How the live connection is behaving. This is presentation state, not
 * transport detail: the page turns it into one short sentence.
 */
export type StreamState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'unavailable'
  | 'closed'

type FrameResult = 'complete' | 'waiting' | 'continue'

const RUN_POLL_INTERVAL_MS = 8000
const MAX_BACKOFF_MS = 15000

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function mergeEvents(current: RunEvent[], incoming: RunEvent): RunEvent[] {
  if (current.some((event) => event.event_id === incoming.event_id)) {
    return current
  }
  return [...current, incoming].sort(
    (left, right) => (left.sequence_no ?? 0) - (right.sequence_no ?? 0)
  )
}

/**
 * Follow one reassessment run.
 *
 * The backend closes the progress stream roughly every twenty seconds and asks
 * the client to come back with its cursor, so this hook reconnects immediately
 * using the last delivered event id. The run record is polled alongside the
 * stream so the displayed status stays honest even while a reconnect is in
 * flight.
 */
export function useRunStream(commandId: string | null, enabled: boolean) {
  const [run, setRun] = useState<RunRecord | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [streamState, setStreamState] = useState<StreamState>('idle')
  const [problem, setProblem] = useState<string | null>(null)
  const [resynchronised, setResynchronised] = useState(false)

  const phaseRef = useRef<string>('queued')

  useEffect(() => {
    phaseRef.current = run?.status ?? 'queued'
  }, [run])

  const refresh = useCallback(async () => {
    if (!commandId || !enabled) return null
    try {
      const record = await apiClient.get<RunRecord>(
        `/api/hr/runs/${encodeURIComponent(commandId)}`
      )
      setRun(record)
      setProblem(null)
      return record
    } catch (error) {
      setProblem(loadRunMessage(error))
      return null
    }
  }, [commandId, enabled])

  useEffect(() => {
    setRun(null)
    setEvents([])
    setProblem(null)
    setResynchronised(false)
    setStreamState(commandId && enabled ? 'connecting' : 'idle')

    if (!commandId || !enabled) return

    const controller = new AbortController()
    const { signal } = controller
    let lastEventId: string | null = null
    let stopped = false

    const loadRun = async () => {
      try {
        const record = await apiClient.get<RunRecord>(
          `/api/hr/runs/${encodeURIComponent(commandId)}`
        )
        if (stopped) return null
        setRun(record)
        setProblem(null)
        return record
      } catch (error) {
        if (stopped) return null
        setProblem(loadRunMessage(error))
        return null
      }
    }

    const handleFrame = (frame: string): FrameResult => {
      let eventName = 'message'
      let eventId: string | null = null
      const dataLines: string[] = []

      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('id:')) eventId = line.slice(3).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }

      if (eventName === 'complete') return 'complete'
      if (eventName === 'waiting') return 'waiting'

      if (eventName === 'cursor_reset') {
        lastEventId = null
        setEvents([])
        setResynchronised(true)
        return 'continue'
      }

      if (eventName === 'hr_event' && dataLines.length > 0) {
        try {
          const payload = JSON.parse(dataLines.join('\n')) as RunEvent
          if (payload && typeof payload.event_id === 'string') {
            lastEventId = eventId ?? payload.event_id
            setEvents((current) => mergeEvents(current, payload))
          }
        } catch {
          /* An unreadable frame is skipped; the next one still arrives. */
        }
      }

      return 'continue'
    }

    const readStream = async (response: Response): Promise<FrameResult> => {
      const reader = response.body?.getReader()
      if (!reader) return 'waiting'
      const decoder = new TextDecoder()
      let buffer = ''

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (stopped) return 'complete'
          if (done) return 'waiting'
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const result = handleFrame(frame)
            if (result !== 'continue') return result
            boundary = buffer.indexOf('\n\n')
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    }

    const pump = async () => {
      let failures = 0
      while (!stopped) {
        try {
          const response = await apiClient.stream(
            `/api/hr/runs/${encodeURIComponent(commandId)}/events`,
            {
              signal,
              headers: lastEventId ? { 'Last-Event-ID': lastEventId } : undefined,
            }
          )
          if (stopped) return
          failures = 0
          setStreamState('live')
          setProblem(null)

          const result = await readStream(response)
          if (stopped) return

          if (result === 'complete') {
            setStreamState('closed')
            await loadRun()
            return
          }

          // The server closed its window on purpose. Refresh the record so the
          // status stays current, then reconnect from the cursor right away.
          const record = await loadRun()
          if (stopped) return
          if (record && isTerminalPhase(runPhase(record.status))) {
            setStreamState('closed')
            return
          }
        } catch (error) {
          if (stopped) return
          if (
            error instanceof ApiError &&
            (error.status === 403 || error.status === 404)
          ) {
            setProblem(loadRunMessage(error))
            setStreamState('unavailable')
            return
          }
          failures += 1
          setStreamState(failures >= 3 ? 'unavailable' : 'reconnecting')
          await delay(Math.min(2000 * 2 ** (failures - 1), MAX_BACKOFF_MS), signal)
        }
      }
    }

    void loadRun().then(() => {
      if (!stopped) void pump()
    })

    const poll = setInterval(() => {
      if (stopped) return
      if (isTerminalPhase(runPhase(phaseRef.current))) return
      void loadRun()
    }, RUN_POLL_INTERVAL_MS)

    return () => {
      stopped = true
      clearInterval(poll)
      controller.abort()
    }
  }, [commandId, enabled])

  return {
    run,
    events,
    streamState,
    problem,
    resynchronised,
    refresh,
    setRun,
  }
}
