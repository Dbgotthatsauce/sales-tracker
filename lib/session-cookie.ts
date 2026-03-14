export const SESSION_COOKIE = 'sb_session'

export function setSessionCookie() {
  if (typeof document === 'undefined') return
  // Secure damit der Cookie auf HTTPS (Vercel) korrekt gesetzt wird
  const secure = location.protocol === 'https:' ? ';Secure' : ''
  document.cookie = `${SESSION_COOKIE}=1;path=/;max-age=${7 * 24 * 3600};SameSite=Lax${secure}`
}

export function clearSessionCookie() {
  if (typeof document === 'undefined') return
  document.cookie = `${SESSION_COOKIE}=;path=/;max-age=0;SameSite=Lax`
}
