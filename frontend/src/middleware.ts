import { withAuth } from 'next-auth/middleware'

export default withAuth({
  pages: { signIn: '/auth/signin' },
  callbacks: {
    authorized: ({ token }) => Boolean(token),
  },
})

export const config = {
  matcher: [
    '/((?!api/auth|auth/|_next/static|_next/image|favicon.ico|.*\\.svg|.*\\.png|.*\\.ico).*)',
  ],
}
