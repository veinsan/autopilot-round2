'use client'

import { cn } from '@/lib/utils'

/**
 * A proportion of a stated whole, drawn beside the figure it illustrates.
 * The bar itself is decorative: the number is always present as text, so
 * nothing here is carried by color or width alone.
 */
export function ShareBar({
  percent,
  tone = 'accent',
  className,
}: {
  percent: number
  tone?: 'accent' | 'warning'
  className?: string
}) {
  const clamped = Math.max(0, Math.min(100, percent))
  const width = clamped > 0 ? Math.max(clamped, 2) : 0

  return (
    <div
      aria-hidden='true'
      className={cn(
        'h-1.5 w-full overflow-hidden rounded-full bg-muted',
        className
      )}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-500 ease-out',
          tone === 'warning' ? 'bg-amber-500' : 'bg-brand-cornflower'
        )}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}
