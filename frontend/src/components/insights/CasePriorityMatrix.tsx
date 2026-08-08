'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Icons } from '@/components/ui/icons'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { InsightNote } from '@/components/insights/InsightNote'
import {
  actFirstSentence,
  buildPriorityMatrix,
  caseAgeDays,
  caseTypeLabel,
  formatAge,
  isActingPriority,
  MATRIX_DERIVATION,
  priorityLabel,
  reconcileCaseViews,
  type CaseMetrics,
  type Loadable,
  type MatrixRowKey,
  type WorkbenchCase,
} from '@/lib/insights'

/** How many cases the opened cell lists before it says how many remain. */
const DETAIL_LIMIT = 12

/**
 * The shading scale: one hue, light to dark, taken from the brand accent at
 * four opacities over the white grid surface. Validated as a sequential ramp
 * (monotone lightness, adjacent gaps clear of the floor, 5° hue spread) and
 * carrying at least 6.6:1 against the navy figure printed in every cell — the
 * count is always readable as text, so nothing is encoded by color alone.
 */
const FILL_STEPS = [
  'bg-brand-cornflower/20',
  'bg-brand-cornflower/45',
  'bg-brand-cornflower/70',
  'bg-brand-cornflower',
]

function fillFor(count: number, busiest: number): string {
  if (count <= 0) return 'bg-white'
  if (busiest <= 0) return FILL_STEPS[0]
  const share = count / busiest
  if (share > 0.75) return FILL_STEPS[3]
  if (share > 0.5) return FILL_STEPS[2]
  if (share > 0.25) return FILL_STEPS[1]
  return FILL_STEPS[0]
}

function RowLabel({ row }: { row: MatrixRowKey }) {
  const acting = isActingPriority(row)
  return (
    <span className='flex items-center gap-1.5'>
      {acting && (
        <Icons.alertTriangle
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            row === 'critical' ? 'text-red-800' : 'text-amber-800'
          )}
        />
      )}
      <span
        className={cn(
          'font-medium',
          row === 'critical'
            ? 'text-red-800'
            : row === 'high'
              ? 'text-amber-800'
              : 'text-muted-foreground'
        )}
      >
        {priorityLabel(row)}
      </span>
    </span>
  )
}

export function CasePriorityMatrix({
  queue,
  metrics,
  referenceIso,
  population,
  onRetry,
}: {
  queue: Loadable<WorkbenchCase[]>
  metrics: CaseMetrics | null
  /** The instant ages are measured to — the same one the figures were counted at. */
  referenceIso: string | null
  population: string
  onRetry: () => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const detailRef = useRef<HTMLHeadingElement>(null)
  const cellRefs = useRef(new Map<string, HTMLButtonElement | null>())

  const cases = queue.status === 'ready' ? queue.data : null
  const reference = referenceIso ?? null

  const matrix = useMemo(
    () => (cases && reference ? buildPriorityMatrix(cases, reference) : null),
    [cases, reference]
  )
  const mismatch = useMemo(
    () => (cases ? reconcileCaseViews(cases, metrics) : null),
    [cases, metrics]
  )

  // A cell that disappears under a refresh must not leave a detail panel open
  // describing cases that are no longer there.
  useEffect(() => {
    if (!matrix || !selected) return
    const [row, band] = selected.split('|')
    if (matrix.cellAt(row as MatrixRowKey, band).cases.length === 0) {
      setSelected(null)
    }
  }, [matrix, selected])

  useEffect(() => {
    if (selected) detailRef.current?.focus()
  }, [selected])

  const openCell = (key: string) => {
    setSelected((current) => (current === key ? null : key))
  }

  const closeDetail = () => {
    const key = selected
    setSelected(null)
    if (key) cellRefs.current.get(key)?.focus()
  }

  if (queue.status === 'restricted') {
    return (
      <InsightNote
        tone='restricted'
        title='You do not have access to the case list'
        badge='No access'
      >
        <p>
          The matrix is drawn from the case queue, which your account may not
          open. The counted figures above are unaffected; switch back to the
          breakdown to read them.
        </p>
      </InsightNote>
    )
  }

  if (queue.status === 'failed') {
    return (
      <InsightNote
        tone='problem'
        title='The matrix could not be drawn'
        footer={
          <Button size='sm' variant='outline' onClick={onRetry}>
            <Icons.refresh className='mr-2 h-4 w-4' />
            Try again
          </Button>
        }
      >
        <p>{queue.message}</p>
      </InsightNote>
    )
  }

  if (queue.status === 'loading' || !matrix) {
    return (
      <div className='space-y-3' aria-busy='true'>
        <Skeleton className='h-4 w-2/3' />
        <Skeleton className='h-64 w-full' />
      </div>
    )
  }

  if (matrix.placed === 0 && matrix.unplaced === 0) {
    // Which kind of nothing this is matters, so it is never a blank grid.
    const nothingRecorded = metrics !== null && metrics.denominator === 0
    return nothingRecorded ? (
      <InsightNote tone='neutral' title='Nothing has been recorded yet'>
        <p>
          No cases at all exist for {population}, so there is nothing to place
          on the grid. This view fills in as soon as the first case is raised.
        </p>
      </InsightNote>
    ) : (
      <InsightNote tone='positive' title='No open cases to place'>
        <p>
          Every case recorded for {population} has been resolved, so the grid is
          empty because there is nothing left to act on — not because anything
          is hidden or missing.
        </p>
      </InsightNote>
    )
  }

  const referenceInstant = reference as string
  const selectedCell = selected
    ? matrix.cellAt(
        selected.split('|')[0] as MatrixRowKey,
        selected.split('|')[1]
      )
    : null
  // Oldest first: within a cell, the longest-waiting case is the one to take.
  const selectedCases = selectedCell
    ? [...selectedCell.cases].sort(
        (left, right) =>
          (caseAgeDays(right, referenceInstant) ?? 0) -
          (caseAgeDays(left, referenceInstant) ?? 0)
      )
    : []

  return (
    <div className='space-y-4'>
      {mismatch && (
        <InsightNote tone='problem' title='The two views do not line up'>
          <p>{mismatch}</p>
        </InsightNote>
      )}

      <p className='text-sm font-medium text-brand-navy'>
        {actFirstSentence(matrix)}
      </p>

      <div className='overflow-x-auto rounded-xl border border-border/70 bg-white p-3'>
        <table className='w-full border-separate border-spacing-1 text-sm'>
          <caption className='sr-only'>
            Open cases for {population}, grouped by the priority recorded on
            each case and by how long it has been open. {MATRIX_DERIVATION}
          </caption>
          <thead>
            <tr>
              <td className='w-32 px-2 pb-1 text-xs font-medium text-muted-foreground'>
                Priority
              </td>
              {matrix.bands.map((band) => (
                <th
                  key={band.key}
                  scope='col'
                  className='px-2 pb-1 text-center text-xs font-medium text-muted-foreground'
                >
                  {band.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row}>
                <th
                  scope='row'
                  className='w-32 px-2 text-left text-xs font-normal'
                >
                  <RowLabel row={row} />
                </th>
                {matrix.bands.map((band) => {
                  const cell = matrix.cellAt(row, band.key)
                  const key = `${row}|${band.key}`
                  const count = cell.cases.length
                  const isOpen = selected === key
                  return (
                    <td key={band.key} className='p-0'>
                      {count === 0 ? (
                        <div className='flex h-14 items-center justify-center rounded-lg border border-border/60 bg-white text-sm text-muted-foreground'>
                          <span aria-hidden='true'>0</span>
                          <span className='sr-only'>
                            No cases: {priorityLabel(row)}, {band.label}
                          </span>
                        </div>
                      ) : (
                        <button
                          type='button'
                          ref={(node) => {
                            cellRefs.current.set(key, node)
                          }}
                          onClick={() => openCell(key)}
                          aria-expanded={isOpen}
                          aria-controls='matrix-cell-detail'
                          className={cn(
                            'relative flex h-14 w-full items-center justify-center rounded-lg border transition',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-cornflower focus-visible:ring-offset-1',
                            fillFor(count, matrix.busiest),
                            isOpen
                              ? 'border-brand-navy ring-2 ring-brand-navy'
                              : 'border-black/[0.06] hover:border-brand-navy/40'
                          )}
                        >
                          {cell.actFirst && (
                            <Icons.flag
                              aria-hidden='true'
                              className='absolute left-1.5 top-1.5 h-3 w-3 text-brand-navy'
                            />
                          )}
                          <span className='text-lg font-semibold tabular-nums text-brand-navy'>
                            {count}
                          </span>
                          <span className='sr-only'>
                            {count === 1 ? 'case' : 'cases'}:{' '}
                            {priorityLabel(row)} priority, open {band.label}.
                            {cell.actFirst ? ' Act first.' : ''} Select to list
                            them.
                          </span>
                        </button>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className='flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between'>
        <p className='flex items-center gap-2'>
          <Icons.flag aria-hidden='true' className='h-3 w-3 text-brand-navy' />
          Flagged cells are the critical and high priority cases that have been
          open longest — the corner to work through first.
        </p>
        <p className='flex items-center gap-2'>
          <span>Fewer</span>
          <span aria-hidden='true' className='flex gap-1'>
            {FILL_STEPS.map((step) => (
              <span
                key={step}
                className={cn(
                  'h-3 w-5 rounded-sm border border-black/[0.06]',
                  step
                )}
              />
            ))}
          </span>
          <span>More cases in the cell</span>
        </p>
      </div>

      <p className='text-xs text-muted-foreground'>{MATRIX_DERIVATION}</p>

      {matrix.unplaced > 0 && (
        <p className='text-xs text-muted-foreground'>
          {matrix.unplaced} open{' '}
          {matrix.unplaced === 1 ? 'case has' : 'cases have'} no start date
          recorded, so {matrix.unplaced === 1 ? 'it is' : 'they are'} not on the
          grid above.
        </p>
      )}

      <div id='matrix-cell-detail'>
        {selectedCell && (
          <div className='rounded-xl border border-border/70 bg-muted/30 p-4'>
            <div className='flex items-start justify-between gap-3'>
              <h4
                ref={detailRef}
                tabIndex={-1}
                className='font-semibold text-brand-navy focus-visible:outline-none'
              >
                {priorityLabel(selectedCell.row)} priority, open{' '}
                {selectedCell.band.label.toLowerCase()} —{' '}
                {selectedCell.cases.length}{' '}
                {selectedCell.cases.length === 1 ? 'case' : 'cases'}
              </h4>
              <Button size='sm' variant='ghost' onClick={closeDetail}>
                <Icons.close className='mr-2 h-4 w-4' />
                Close
              </Button>
            </div>
            <ul className='mt-3 space-y-2'>
              {selectedCases.slice(0, DETAIL_LIMIT).map((item) => {
                const days = caseAgeDays(item, referenceInstant)
                return (
                  <li
                    key={item.case_id}
                    className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border/50 pb-2 text-sm last:border-0 last:pb-0'
                  >
                    <span className='font-medium text-brand-navy'>
                      {caseTypeLabel(item.case_type)}
                    </span>
                    <span className='text-muted-foreground'>
                      {item.employee_id
                        ? `Employee ${item.employee_id}`
                        : 'No employee recorded'}{' '}
                      · open{' '}
                      {days === null
                        ? 'for an unknown time'
                        : formatAge(days).toLowerCase()}
                    </span>
                  </li>
                )
              })}
            </ul>
            {selectedCases.length > DETAIL_LIMIT && (
              <p className='mt-3 text-xs text-muted-foreground'>
                {selectedCases.length - DETAIL_LIMIT} more{' '}
                {selectedCases.length - DETAIL_LIMIT === 1 ? 'case' : 'cases'}{' '}
                are in this cell. The Workbench holds the full queue.
              </p>
            )}
            <Button asChild size='sm' variant='outline' className='mt-3'>
              <Link href='/workbench'>
                Open the Workbench
                <Icons.arrowRight className='h-4 w-4' />
              </Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
