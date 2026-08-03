'use client'

import { getProviders, signIn } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CardWatermark } from '@/components/ui/card-watermark'
import { Button } from '@/components/ui/button'
import { Icons } from '@/components/ui/icons'
import { Logomark } from '@/components/brand'

function SignInContent() {
  const searchParams = useSearchParams()
  const callbackUrl = searchParams.get('callbackUrl') || '/'
  const [providerId, setProviderId] = useState<string | null>(null)

  useEffect(() => {
    void getProviders().then((providers) => {
      const selected = providers?.keycloak
        ? 'keycloak'
        : providers?.['autopilot-dev']
          ? 'autopilot-dev'
          : null
      setProviderId(selected)
      if (selected === 'autopilot-dev') {
        void signIn(selected, { callbackUrl, redirect: true })
      }
    })
  }, [callbackUrl])

  const isDev = providerId === 'autopilot-dev'

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
      className='w-full max-w-md'
    >
      <Card className='relative overflow-hidden bg-white shadow-float-lg'>
        <CardWatermark opacity={4} scale={1} />
        <CardHeader className='relative z-10 space-y-4 pb-8 text-center'>
          <div className='mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-brand-navy shadow-xl'>
            <Logomark variant='light' size={48} />
          </div>
          <div>
            <CardTitle className='text-display-5 font-bold text-brand-navy'>
              AutoPilot
            </CardTitle>
            <p className='mt-2 text-muted-foreground'>
              {isDev
                ? 'Signing in with the local development identity…'
                : 'Sign in to the HR Command Center'}
            </p>
          </div>
        </CardHeader>
        <CardContent className='relative z-10 space-y-4 px-8 pb-8'>
          {isDev ? (
            <div className='flex justify-center py-4'>
              <div className='h-8 w-8 animate-spin rounded-full border-4 border-brand-navy border-t-transparent' />
            </div>
          ) : (
            <Button
              onClick={() =>
                providerId &&
                signIn(providerId, { callbackUrl, redirect: true })
              }
              variant='gradient'
              size='lg'
              className='w-full py-6 text-base'
              disabled={!providerId}
            >
              <Icons.shield className='mr-2 h-4 w-4' />
              Sign in with Keycloak
            </Button>
          )}
          {!providerId && (
            <p className='text-center text-xs text-muted-foreground'>
              Loading the identity provider…
            </p>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className='flex min-h-screen items-center justify-center bg-background'>
          <div className='h-8 w-8 animate-spin rounded-full border-4 border-brand-navy border-t-transparent' />
        </div>
      }
    >
      <SignInContent />
    </Suspense>
  )
}
