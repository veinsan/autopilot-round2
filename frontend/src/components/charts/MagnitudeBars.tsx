'use client'

import { cn } from '@/lib/utils'

/**
 * One measure across a handful of named things, largest first.
 *
 * A magnitude chart, so it carries one hue rather than a colour per row: the
 * length is the data and the colour says nothing. Every row is labelled and
 * carries its own figure, so nothing on it depends on reading the bar.
 */
export type MagnitudeItem = {
  key: string
  label: string
  /** The figure printed at the end of the bar. */
  value: string
  /** 0-100. How long the bar is drawn. */
  share: number
  /** One short line under the label, when the row needs to say more. */
  note?: string
}

export function MagnitudeBars({
  items,
  tone = 'accent',
  caption,
  className,
}: {
  items: MagnitudeItem[]
  tone?: 'accent' | 'warning'
  /** Names what is plotted, so a single-series chart needs no legend box. */
  caption?: string
  className?: string
}) {
  if (items.length === 0) return null

  return (
    <div className={cn('space-y-3', className)}>
      {caption && <p className='text-xs text-muted-foreground'>{caption}</p>}
      <ul className='space-y-3'>
        {items.map((item) => {
          const width = Math.max(0, Math.min(100, item.share))
          return (
            <li key={item.key} className='space-y-1.5'>
              <div className='flex items-baseline justify-between gap-3 text-sm'>
                <span className='min-w-0 truncate font-medium text-foreground'>
                  {item.label}
                </span>
                {/* The figure rides the bar's end rather than a tooltip, so the
                    value is readable without pointing at anything. */}
                <span className='shrink-0 tabular-nums text-muted-foreground'>
                  {item.value}
                </span>
              </div>
              <div className='h-2.5 w-full overflow-hidden rounded-sm bg-muted'>
                <div
                  aria-hidden='true'
                  className={cn(
                    // Square where it starts, rounded where the data ends.
                    'h-full rounded-l-none rounded-r-[4px] transition-[width] duration-500 ease-out',
                    tone === 'warning' ? 'bg-amber-500' : 'bg-brand-cornflower'
                  )}
                  style={{ width: `${width > 0 ? Math.max(width, 1.5) : 0}%` }}
                />
              </div>
              {item.note && (
                <p className='text-xs text-muted-foreground'>{item.note}</p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
