'use client'

import { useEffect, useState } from 'react'
import apiClient from '@/lib/api-client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Icons } from '@/components/ui/icons'

type Integration = {
  integration_key: string
  category: string
  status: string
  checked_at: string
  last_success_at?: string
  detail?: string
}
export default function DataManagerPage() {
  const [items, setItems] = useState<Integration[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    apiClient<{ integrations: Integration[] }>('/api/hr/data-manager')
      .then((result) => setItems(result.integrations))
      .catch((err: Error) => setError(err.message))
  }, [])
  return (
    <div className='space-y-6'>
      <div>
        <p className='text-sm font-medium text-brand-cornflower'>
          Operational observability
        </p>
        <h1 className='text-display-3 font-bold tracking-tight text-brand-navy'>
          Data Manager
        </h1>
        <p className='mt-2 text-muted-foreground'>
          Status comes from real integration operations, not test messages.
        </p>
      </div>
      {error && <p className='text-sm text-destructive'>{error}</p>}
      <div className='grid gap-4 md:grid-cols-2'>
        {items.map((item) => (
          <Card key={item.integration_key}>
            <CardHeader>
              <CardTitle className='flex items-center justify-between text-base'>
                <span>{item.integration_key}</span>
                <Icons.activity className='h-4 w-4 text-brand-cornflower' />
              </CardTitle>
            </CardHeader>
            <CardContent className='space-y-1 text-sm text-muted-foreground'>
              <p className='capitalize'>
                {item.category} · {item.status}
              </p>
              <p>Last checked: {new Date(item.checked_at).toLocaleString()}</p>
              {item.last_success_at && (
                <p>
                  Last successful operation:{' '}
                  {new Date(item.last_success_at).toLocaleString()}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      {!error && items.length === 0 && (
        <Card>
          <CardContent className='p-5 text-sm text-muted-foreground'>
            No health checks have been recorded.
          </CardContent>
        </Card>
      )}
    </div>
  )
}
