'use client'

import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Icons } from '@/components/ui/icons'

/**
 * The five things this view can have to say instead of a figure. Each tone
 * gets its own icon, color and heading so that "nothing found", "withheld to
 * protect a small group" and "not available to you" can never be mistaken for
 * one another, or for a failure.
 */
export type InsightTone =
  | 'neutral' // nothing was in scope to look at
  | 'positive' // it was looked at and came back clear
  | 'protected' // a deliberate privacy control held the result back
  | 'restricted' // this account may not see it
  | 'problem' // it could not be loaded

const TONE_STYLES: Record<
  InsightTone,
  { frame: string; icon: string; title: string; body: string }
> = {
  neutral: {
    frame: 'border-border/70 bg-muted/40',
    icon: 'text-brand-cornflower',
    title: 'text-brand-navy',
    body: 'text-muted-foreground',
  },
  positive: {
    frame: 'border-emerald-200 bg-emerald-50',
    icon: 'text-emerald-600',
    title: 'text-emerald-900',
    body: 'text-emerald-800',
  },
  protected: {
    frame: 'border-brand-cornflower/40 bg-brand-cornflower/10',
    icon: 'text-brand-navy',
    title: 'text-brand-navy',
    body: 'text-brand-navy/80',
  },
  restricted: {
    frame: 'border-amber-200 bg-amber-50',
    icon: 'text-amber-700',
    title: 'text-amber-900',
    body: 'text-amber-800',
  },
  problem: {
    frame: 'border-destructive/40 bg-red-50',
    icon: 'text-destructive',
    title: 'text-destructive',
    body: 'text-destructive',
  },
}

const TONE_ICONS: Record<InsightTone, ComponentType<{ className?: string }>> = {
  neutral: Icons.users,
  positive: Icons.checkCircle,
  protected: Icons.shield,
  restricted: Icons.lock,
  problem: Icons.alertTriangle,
}

export function InsightNote({
  tone,
  title,
  titleAs: Title = 'h3',
  badge,
  children,
  footer,
  className,
}: {
  tone: InsightTone
  title: string
  /** Chosen by the caller so the heading order of the page stays unbroken. */
  titleAs?: 'h2' | 'h3' | 'h4'
  /** A short pill that names the kind of state, e.g. "Privacy protection". */
  badge?: string
  children: ReactNode
  footer?: ReactNode
  className?: string
}) {
  const styles = TONE_STYLES[tone]
  const Icon = TONE_ICONS[tone]

  return (
    <div className={cn('rounded-xl border p-5', styles.frame, className)}>
      <div className='flex items-start gap-3'>
        <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', styles.icon)} />
        <div className='min-w-0 space-y-2'>
          <div className='flex flex-wrap items-center gap-2'>
            <Title className={cn('font-semibold', styles.title)}>{title}</Title>
            {badge && (
              <span
                className={cn(
                  'inline-flex w-fit rounded-full border border-current bg-white/70 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
                  styles.title
                )}
              >
                {badge}
              </span>
            )}
          </div>
          <div className={cn('space-y-2 text-sm', styles.body)}>{children}</div>
          {footer && (
            <div className={cn('pt-1 text-xs', styles.body)}>{footer}</div>
          )}
        </div>
      </div>
    </div>
  )
}
