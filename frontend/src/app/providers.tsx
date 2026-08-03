'use client'

import { SessionProvider } from 'next-auth/react'
import { ToastProvider } from '@/components/ui/toast'
import { CommandPalette } from '@/components/CommandPalette'
import { AIProvider } from '@/context/AIContext'
import { AIManager } from '@/components/ai/AIManager'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider
      basePath={`${process.env.NEXT_PUBLIC_BASE_PATH || ''}/api/auth`}
      refetchInterval={5 * 60}
      refetchOnWindowFocus
    >
      <AIProvider>
        {children}
        <AIManager />
        <ToastProvider />
        <CommandPalette />
      </AIProvider>
    </SessionProvider>
  )
}
