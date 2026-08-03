import { getToken } from 'next-auth/jwt'
import { type NextRequest, NextResponse } from 'next/server'

const sessionCookies = [
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
  'next-auth.csrf-token',
  '__Secure-next-auth.csrf-token',
  'next-auth.callback-url',
  '__Secure-next-auth.callback-url',
]

export async function GET(request: NextRequest) {
  const home = process.env.NEXTAUTH_URL || request.nextUrl.origin
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
  })
  let destination = `${home}/auth/signin`

  if (process.env.AUTH_BYPASS !== 'true' && process.env.KEYCLOAK_PUBLIC_URL) {
    const realm = process.env.KEYCLOAK_REALM || 'autopilot'
    const logout = new URL(
      `${process.env.KEYCLOAK_PUBLIC_URL}/realms/${realm}/protocol/openid-connect/logout`
    )
    logout.searchParams.set('post_logout_redirect_uri', `${home}/auth/signin`)
    logout.searchParams.set('client_id', process.env.KEYCLOAK_CLIENT_ID || '')
    if (token?.idToken) logout.searchParams.set('id_token_hint', token.idToken)
    destination = logout.toString()
  }

  const response = NextResponse.redirect(destination)
  for (const name of sessionCookies) {
    response.cookies.set(name, '', { expires: new Date(0), path: '/' })
  }
  return response
}
