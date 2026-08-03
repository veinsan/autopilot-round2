'use client'

import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import Link from 'next/link'
import apiClient from '@/lib/api-client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Icons } from '@/components/ui/icons'

type Dashboard = {
  workers: number
  open_cases: number
  critical_cases: number
  cohorts: number
  integrations: Array<{
    integration_key: string
    status: string
    last_success_at?: string
  }>
  refreshed_at: string
}

const metrics: Array<{
  key: keyof Pick<
    Dashboard,
    'workers' | 'open_cases' | 'critical_cases' | 'cohorts'
  >
  label: string
  icon: ComponentType<{ className?: string }>
}> = [
  { key: 'workers', label: 'Workers monitored', icon: Icons.users },
  { key: 'open_cases', label: 'Open cases', icon: Icons.workbench },
  {
    key: 'critical_cases',
    label: 'Critical priority',
    icon: Icons.alertTriangle,
  },
  { key: 'cohorts', label: 'Active cohorts', icon: Icons.layers },
]

export default function CommandCenterPage() {
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiClient<Dashboard>('/api/hr/dashboard')
      .then(setData)
      .catch((err: Error) => setError(err.message))
  }, [])

  return (
    <div className='space-y-6'>
      <div className='flex flex-col justify-between gap-4 sm:flex-row sm:items-end'>
        <div>
          <p className='text-sm font-medium text-brand-cornflower'>
            HR & People Ops
          </p>
          <h1 className='text-display-3 font-bold tracking-tight text-brand-navy'>
            Command Center
          </h1>
          <p className='mt-2 text-muted-foreground'>
            Review onboarding, compliance, payroll, and Day 1 readiness risks.
          </p>
        </div>
        <Button asChild variant='gradient'>
          <Link href='/workbench'>
            Open Workbench <Icons.arrowRight className='h-4 w-4' />
          </Link>
        </Button>
      </div>

      {error && (
        <Card className='border-destructive/40'>
          <CardContent className='p-4 text-sm text-destructive'>
            Operational data could not be loaded: {error}
          </CardContent>
        </Card>
      )}

      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        {metrics.map(({ key, label, icon: Icon }) => {
          return (
            <Card key={key}>
              <CardContent className='flex items-start justify-between p-5'>
                <div>
                  <p className='text-sm text-muted-foreground'>{label}</p>
                  <p className='mt-2 text-3xl font-bold text-brand-navy'>
                    {data ? data[key] : '—'}
                  </p>
                </div>
                <Icon className='h-5 w-5 text-brand-cornflower' />
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2'>
            <Icons.activity className='h-5 w-5 text-brand-cornflower' />
            Integration health
          </CardTitle>
        </CardHeader>
        <CardContent className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          {data?.integrations.length ? (
            data.integrations.map((item) => (
              <div key={item.integration_key} className='rounded-lg border p-3'>
                <p className='font-medium text-brand-navy'>
                  {item.integration_key}
                </p>
                <p className='mt-1 text-sm capitalize text-muted-foreground'>
                  {item.status}
                </p>
              </div>
            ))
          ) : (
            <p className='text-sm text-muted-foreground'>
              No integration operations have been recorded.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
