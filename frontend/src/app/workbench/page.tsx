'use client'

import { useCallback, useEffect, useState } from 'react'
import apiClient from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Icons } from '@/components/ui/icons'

type Case = { case_id: string; employee_id?: string; case_type: string; priority: string; status: string; recommended_action?: string; created_at: string }

export default function WorkbenchPage() {
  const [cases, setCases] = useState<Case[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = useCallback(() => apiClient<{ cases: Case[] }>('/api/hr/cases').then((result) => { setCases(result.cases); setError(null) }).catch((err: Error) => setError(err.message)), [])
  useEffect(() => { load() }, [load])

  const action = async (caseId: string, decision: 'claim' | 'resolve') => {
    setBusy(caseId)
    try { await apiClient(`/api/hr/cases/${caseId}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) }); await load() } catch (err) { setError(err instanceof Error ? err.message : 'Aksi gagal') } finally { setBusy(null) }
  }

  return <div className='space-y-6'>
    <div><p className='text-sm font-medium text-brand-cornflower'>Human-in-the-loop</p><h1 className='text-display-3 font-bold tracking-tight text-brand-navy'>HR Workbench</h1><p className='mt-2 text-muted-foreground'>Kasus hanya dapat ditutup oleh manusia. Sinyal baru akan membuka kembali kasus terkait.</p></div>
    {error && <Card className='border-destructive/40'><CardContent className='p-4 text-sm text-destructive'>{error}</CardContent></Card>}
    <div className='space-y-3'>
      {cases.map((item) => <Card key={item.case_id}><CardContent className='flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between'><div><div className='flex items-center gap-2'><span className='rounded-full bg-brand-cornflower/15 px-2 py-1 text-xs font-semibold uppercase text-brand-navy'>{item.priority}</span><span className='text-sm text-muted-foreground'>{item.status}</span></div><h2 className='mt-2 font-semibold text-brand-navy'>{item.case_type}</h2><p className='mt-1 text-sm text-muted-foreground'>Pegawai: {item.employee_id || 'Tidak tersedia'}{item.recommended_action ? ` · ${item.recommended_action}` : ''}</p></div><div className='flex gap-2'><Button variant='outline' disabled={busy === item.case_id || item.status === 'resolved'} onClick={() => action(item.case_id, 'claim')}>Ambil</Button><Button disabled={busy === item.case_id || item.status === 'resolved'} onClick={() => action(item.case_id, 'resolve')}>Selesaikan</Button></div></CardContent></Card>)}
      {!error && cases.length === 0 && <Card><CardContent className='flex items-center gap-3 p-8 text-muted-foreground'><Icons.checkCircle className='h-5 w-5 text-emerald-600' />Tidak ada kasus standar yang perlu ditangani.</CardContent></Card>}
    </div>
  </div>
}
