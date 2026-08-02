'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import apiClient from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type Policy = { version_id: string; status: string; created_at: string; change_summary: string; activated_at?: string }

export default function PolicyStudioPage() {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [summary, setSummary] = useState('')
  const [snapshot, setSnapshot] = useState('{\n  "reason_codes": [],\n  "routing": {}\n}')
  const [message, setMessage] = useState<string | null>(null)
  const load = useCallback(() => apiClient<{ policies: Policy[] }>('/api/hr/policies').then((result) => setPolicies(result.policies)).catch((err: Error) => setMessage(err.message)), [])
  useEffect(() => { load() }, [load])
  const create = async (event: FormEvent) => { event.preventDefault(); try { await apiClient('/api/hr/policies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ change_summary: summary, config_snapshot: JSON.parse(snapshot) }) }); setMessage('Draft kebijakan dibuat. Jalankan simulasi sebelum approval dan aktivasi.'); setSummary(''); await load() } catch (err) { setMessage(err instanceof Error ? err.message : 'Snapshot JSON tidak valid') } }
  const advance = async (policy: Policy) => {
    try {
      if (policy.status === 'draft') {
        const result = await apiClient<{ result: { workers_evaluated: number; findings_by_code: Record<string, number> }> }>('/api/hr/policies/simulations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version_id: policy.version_id }) })
        setMessage(`Simulasi selesai: ${result.result.workers_evaluated} pekerja dievaluasi, ${Object.values(result.result.findings_by_code).reduce((total, count) => total + count, 0)} finding.`)
      } else if (policy.status === 'simulated') {
        await apiClient(`/api/hr/policies/${policy.version_id}/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) })
        setMessage('Persetujuan dicatat. Versi siap diaktifkan oleh Admin.')
      } else if (policy.status === 'approved') {
        await apiClient(`/api/hr/policies/${policy.version_id}/activate`, { method: 'POST' })
        setMessage('Versi kebijakan aktif secara atomik.')
      }
      await load()
    } catch (err) { setMessage(err instanceof Error ? err.message : 'Aksi policy gagal') }
  }
  const actionLabel: Record<string, string> = { draft: 'Simulasikan', simulated: 'Setujui', approved: 'Aktifkan' }
  return <div className='grid gap-6 xl:grid-cols-[1.1fr_.9fr]'>
    <div><p className='text-sm font-medium text-brand-cornflower'>Governed configuration</p><h1 className='text-display-3 font-bold tracking-tight text-brand-navy'>Policy Studio</h1><p className='mt-2 text-muted-foreground'>Setiap versi immutable, dapat disimulasikan, dan memiliki jejak persetujuan.</p><div className='mt-6 space-y-3'>{policies.map((policy) => <Card key={policy.version_id}><CardContent className='p-4'><div className='flex justify-between gap-4'><div><p className='font-medium text-brand-navy'>{policy.change_summary}</p><p className='mt-1 font-mono text-xs text-muted-foreground'>{policy.version_id}</p></div><div className='flex items-center gap-2'><span className='h-fit rounded-full bg-brand-cornflower/15 px-2 py-1 text-xs font-semibold capitalize text-brand-navy'>{policy.status}</span>{actionLabel[policy.status] && <Button size='sm' variant='outline' onClick={() => advance(policy)}>{actionLabel[policy.status]}</Button>}</div></div></CardContent></Card>)}{policies.length === 0 && <Card><CardContent className='p-5 text-sm text-muted-foreground'>Belum ada policy version yang dapat ditampilkan.</CardContent></Card>}</div></div>
    <Card className='h-fit'><CardHeader><CardTitle>Buat draft</CardTitle></CardHeader><CardContent><form className='space-y-4' onSubmit={create}><Input value={summary} onChange={(event) => setSummary(event.target.value)} minLength={3} placeholder='Ringkasan perubahan' required /><textarea value={snapshot} onChange={(event) => setSnapshot(event.target.value)} className='min-h-64 w-full rounded-lg border border-input bg-white p-3 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-brand-cornflower/50' aria-label='Policy configuration JSON' /><Button type='submit' variant='gradient'>Simpan sebagai draft</Button>{message && <p className='text-sm text-muted-foreground'>{message}</p>}</form></CardContent></Card>
  </div>
}
