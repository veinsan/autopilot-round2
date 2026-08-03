import NextAuth, { type AuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import KeycloakProvider from 'next-auth/providers/keycloak'
import type { JWT } from 'next-auth/jwt'

const authBypass = process.env.AUTH_BYPASS === 'true'
const realm = process.env.KEYCLOAK_REALM || 'autopilot'
const publicIssuer = `${process.env.KEYCLOAK_PUBLIC_URL}/realms/${realm}`
const internalIssuer = `${process.env.KEYCLOAK_SERVER_URL}/realms/${realm}`
const clientId = process.env.KEYCLOAK_CLIENT_ID || ''
const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET || ''

type AccessClaims = {
  sub?: string
  realm_access?: { roles?: string[] }
  resource_access?: Record<string, { roles?: string[] }>
}

function accessClaims(accessToken?: string): AccessClaims {
  if (!accessToken) return {}
  try {
    const payload = accessToken.split('.')[1]
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

function tokenRoles(accessToken?: string): string[] {
  const claims = accessClaims(accessToken)
  return Array.from(
    new Set([
      ...(claims.realm_access?.roles ?? []),
      ...(claims.resource_access?.[clientId]?.roles ?? []),
    ])
  )
}

async function refreshAccessToken(token: JWT): Promise<JWT> {
  if (!token.refreshToken) return { ...token, error: 'RefreshAccessTokenError' }
  try {
    const response = await fetch(`${internalIssuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: token.refreshToken,
      }),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('refresh rejected')
    const refreshed = await response.json()
    const accessToken = String(refreshed.access_token)
    return {
      ...token,
      accessToken,
      accessTokenExpires: Date.now() + Number(refreshed.expires_in) * 1000,
      refreshToken: refreshed.refresh_token ?? token.refreshToken,
      idToken: refreshed.id_token ?? token.idToken,
      roles: tokenRoles(accessToken),
      error: undefined,
    }
  } catch {
    return { ...token, error: 'RefreshAccessTokenError' }
  }
}

const providers = authBypass
  ? [
      CredentialsProvider({
        id: 'autopilot-dev',
        name: 'AutoPilot Dev',
        credentials: {},
        async authorize() {
          return {
            id: 'dev-user-001',
            name: 'Dev User',
            email: 'dev@autopilot.local',
          }
        },
      }),
    ]
  : [
      KeycloakProvider({
        clientId,
        clientSecret,
        issuer: publicIssuer,
        wellKnown: `${internalIssuer}/.well-known/openid-configuration`,
        authorization: {
          url: `${publicIssuer}/protocol/openid-connect/auth`,
          params: { scope: 'openid email profile' },
        },
        token: `${internalIssuer}/protocol/openid-connect/token`,
        userinfo: `${internalIssuer}/protocol/openid-connect/userinfo`,
        jwks_endpoint: `${internalIssuer}/protocol/openid-connect/certs`,
      }),
    ]

const secret = process.env.NEXTAUTH_SECRET

const authOptions: AuthOptions = {
  providers,
  pages: { signIn: '/auth/signin', error: '/auth/error' },
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (authBypass) {
        token.roles = ['admin', 'user']
        token.sub = token.sub || 'dev-user-001'
        return token
      }
      if (account) {
        const accessToken = account.access_token
        const claims = accessClaims(accessToken)
        return {
          ...token,
          accessToken,
          accessTokenExpires: Number(account.expires_at) * 1000,
          refreshToken: account.refresh_token,
          idToken: account.id_token,
          sub: claims.sub ?? profile?.sub ?? token.sub,
          roles: tokenRoles(accessToken),
        }
      }
      if (
        token.accessToken &&
        token.accessTokenExpires &&
        Date.now() < token.accessTokenExpires - 30_000
      ) {
        return token
      }
      return refreshAccessToken(token)
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken
      session.accessTokenExpires = token.accessTokenExpires
      session.idToken = token.idToken
      session.roles = token.roles ?? []
      session.sub = token.sub
      session.error = token.error
      return session
    },
    async redirect({ url, baseUrl }) {
      if (url.startsWith('/')) return `${baseUrl}${url}`
      if (new URL(url).origin === baseUrl) return url
      return baseUrl
    },
  },
  secret: secret || 'build-only-placeholder',
  debug: false,
}

const handler = NextAuth(authOptions)
export { handler as GET, handler as POST }
