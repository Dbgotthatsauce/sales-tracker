import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Kein Import-Alias hier – Edge Runtime mag @/ nicht immer
const SESSION_COOKIE = 'sb_session'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (pathname === '/') {
    if (!request.cookies.has(SESSION_COOKIE)) {
      const loginUrl = new URL('/login', request.url)
      return NextResponse.redirect(loginUrl)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/'],
}
