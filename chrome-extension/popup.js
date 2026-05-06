// =============================================================
// Banner sofort verstecken – bevor irgendein async-Code läuft.
// Der Side Panel merkt sich den letzten DOM-Zustand, daher muss
// der Fehlerzustand beim jedem Öffnen synchron zurückgesetzt werden.
// =============================================================
document.getElementById('session-expired-banner')?.classList.add('hidden')

// =============================================================
// Konfiguration
// =============================================================
const SUPABASE_URL      = 'https://tcfoiduoquheqmnoigto.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRjZm9pZHVvcXVoZXFtbm9pZ3RvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0OTM1OTEsImV4cCI6MjA4OTA2OTU5MX0.8w9dxDfrgw5UG69BJW5se653wjXK1scNNGbnNr58524'

// =============================================================
// Session-Storage
// =============================================================
const SESSION_KEY = 'st_session'

function saveSession(accessToken, refreshToken, userId, email) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ accessToken, refreshToken, userId, email }))
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) ?? null } catch { return null }
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY)
}

// =============================================================
// Token-Verwaltung: Ablauf prüfen & automatisch erneuern
// =============================================================
function isTokenExpired(token) {
  try {
    // JWT nutzt Base64url (ohne Padding) – atob() braucht Standard-Base64 mit Padding
    const base64url = token.split('.')[1]
    const base64    = base64url.replace(/-/g, '+').replace(/_/g, '/')
    const padded    = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=')
    const payload   = JSON.parse(atob(padded))
    // 60 Sekunden Puffer
    return payload.exp * 1000 < Date.now() + 60_000
  } catch {
    // Kann Token nicht parsen → kein Refresh erzwingen, API-Call entscheidet selbst
    return false
  }
}

async function supabaseRefresh(refreshToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  if (!res.ok) return null
  const data = await res.json()
  if (!data.access_token) return null
  return { accessToken: data.access_token, refreshToken: data.refresh_token }
}

// Gibt einen gültigen Access-Token zurück oder null wenn die Session weg ist
async function getValidToken() {
  const session = loadSession()
  if (!session?.accessToken) return null

  if (!isTokenExpired(session.accessToken)) return session.accessToken

  // Token abgelaufen → versuchen zu erneuern
  if (!session.refreshToken) { clearSession(); return null }
  const refreshed = await supabaseRefresh(session.refreshToken)
  if (!refreshed) { clearSession(); return null }

  saveSession(refreshed.accessToken, refreshed.refreshToken, session.userId, session.email)
  return refreshed.accessToken
}

// =============================================================
// Supabase Auth – REST API
// =============================================================
async function supabaseSignIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error_description || data.msg || 'Login fehlgeschlagen')
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    userId:       data.user.id,
    email:        data.user.email,
  }
}

async function supabaseSignOut(accessToken) {
  await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
  })
}

async function supabaseGetUser(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
  })
  if (!res.ok) return null
  const data = await res.json()
  return data?.id ? data : null
}

// =============================================================
// Supabase REST API – Event eintragen
// =============================================================
async function trackEvent(eventType, value, accessToken, userId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/tracking_events`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify({ user_id: userId, event_type: eventType, value }),
  })
  if (!res.ok) {
    const text = await res.text()
    const err  = new Error(`HTTP ${res.status}: ${text}`)
    if (res.status === 401) err.isAuthError = true
    throw err
  }
}

// Schreibt ein Event – bei 401 einmal Token refreshen und nochmals versuchen.
// Wirft { isAuthError: true } nur wenn Auth auch nach Refresh scheitert.
async function trackEventWithAuth(eventType, value) {
  const s = loadSession()
  if (!s?.accessToken) {
    const err = new Error('Keine Session')
    err.isAuthError = true
    throw err
  }
  try {
    await trackEvent(eventType, value, s.accessToken, s.userId)
  } catch (err) {
    if (!err.isAuthError) throw err          // echter Netzwerk-/DB-Fehler, kein Auth-Problem

    // 401 → Token einmalig refreshen und Schreibvorgang wiederholen
    if (!s.refreshToken) throw err
    const refreshed = await supabaseRefresh(s.refreshToken)
    if (!refreshed) throw err
    saveSession(refreshed.accessToken, refreshed.refreshToken, s.userId, s.email)
    // Retry – wenn das nochmals 401 wirft, propagiert der Fehler als isAuthError
    await trackEvent(eventType, value, refreshed.accessToken, s.userId)
  }
}

// =============================================================
// Supabase REST API – Heutige Summen laden
// =============================================================
async function loadDailyTotals(accessToken, userId) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const startOfDay = today.toISOString()

  const url = new URL(`${SUPABASE_URL}/rest/v1/tracking_events`)
  url.searchParams.set('select', 'event_type,value')
  url.searchParams.set('user_id', `eq.${userId}`)
  url.searchParams.set('created_at', `gte.${startOfDay}`)

  const res = await fetch(url.toString(), {
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
  })
  if (!res.ok) return {}

  const rows = await res.json()
  const totals = {}
  for (const row of rows) {
    totals[row.event_type] = (totals[row.event_type] ?? 0) + Number(row.value)
  }
  return totals
}

// =============================================================
// Gamification – Partikel & Sound
// =============================================================
function spawnConfetti(originEl) {
  const app       = document.querySelector('.app')
  const appRect   = app.getBoundingClientRect()
  const btnRect   = originEl.getBoundingClientRect()
  const originX   = btnRect.left - appRect.left + btnRect.width  / 2
  const originY   = btnRect.top  - appRect.top  + btnRect.height / 2
  const emojis    = ['🎊', '🎉', '✨', '🎁', '⭐', '💫', '🎈', '🥳']

  for (let i = 0; i < 22; i++) {
    const el = document.createElement('span')
    el.className = 'particle particle-confetti'
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)]
    const angle = (Math.random() * Math.PI * 2)
    const dist  = 60 + Math.random() * 140
    el.style.cssText = `
      left: ${originX}px;
      top:  ${originY}px;
      font-size: ${11 + Math.random() * 13}px;
      --dx: ${Math.cos(angle) * dist}px;
      --dy: ${Math.sin(angle) * dist - 60}px;
      animation-delay:    ${Math.random() * 0.15}s;
      animation-duration: ${1.4 + Math.random() * 0.8}s;
    `
    app.appendChild(el)
    el.addEventListener('animationend', () => el.remove())
  }
}

function spawnMoneyRain() {
  const app    = document.querySelector('.app')
  const height = app.getBoundingClientRect().height
  const emojis = ['💰', '💵', '💶', '💸', '🤑', '💴', '💳']

  for (let i = 0; i < 28; i++) {
    const el = document.createElement('span')
    el.className = 'particle particle-money'
    el.textContent = emojis[Math.floor(Math.random() * emojis.length)]
    const dur  = 1.6 + Math.random() * 1.4
    const spin = (Math.random() > 0.5 ? 1 : -1) * (180 + Math.random() * 360)
    el.style.cssText = `
      left: ${Math.random() * 96}%;
      top:  -32px;
      font-size: ${13 + Math.random() * 14}px;
      --fall: ${height + 50}px;
      --spin: ${spin}deg;
      animation-delay:    ${Math.random() * 0.8}s;
      animation-duration: ${dur}s;
    `
    app.appendChild(el)
    el.addEventListener('animationend', () => el.remove())
  }
}

function playSound(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()

    if (type === 'termin') {
      // Aufsteigendes Arpeggio: C5-E5-G5-C6
      [523, 659, 784, 1047].forEach((freq, i) => {
        const osc  = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.type = 'sine'; osc.frequency.value = freq
        const t = ctx.currentTime + i * 0.11
        gain.gain.setValueAtTime(0, t)
        gain.gain.linearRampToValueAtTime(0.28, t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
        osc.start(t); osc.stop(t + 0.35)
      })
    } else if (type === 'kunde') {
      // Cha-Ching: metallischer Impuls + tiefer Nachhall
      [[1400, 'triangle', 0],   [2100, 'triangle', 0.06],
       [2800, 'triangle', 0.1], [700,  'sine',     0.05]].forEach(([freq, wave, delay]) => {
        const osc  = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.type = wave; osc.frequency.value = freq
        const t = ctx.currentTime + delay
        gain.gain.setValueAtTime(0, t)
        gain.gain.linearRampToValueAtTime(0.22, t + 0.01)
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55)
        osc.start(t); osc.stop(t + 0.6)
      })
    }
  } catch (_) { /* Audio nicht verfügbar – kein Problem */ }
}

function triggerCelebration(eventType, originEl) {
  if (eventType === 'Termin vereinbart') {
    spawnConfetti(originEl)
    playSound('termin')
  } else if (eventType === 'Als Kunden gewonnen') {
    spawnMoneyRain()
    playSound('kunde')
  }
}

// =============================================================
// Toast Notification
// =============================================================
let toastTimer = null
function showToast(message, type = 'ok') {
  const toast = document.getElementById('toast')
  toast.textContent = message
  toast.className = `toast show ${type}`
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.className = 'toast hidden' }, 2200)
}

// =============================================================
// UI: Views umschalten
// =============================================================
function showLoginView(errorMsg = null) {
  document.getElementById('login-view').classList.remove('hidden')
  document.getElementById('tracker-view').classList.add('hidden')
  hideSessionExpiredBanner()
  if (errorMsg) showLoginError(errorMsg)
  document.getElementById('loginEmail').focus()
}

function showSessionExpiredBanner() {
  document.getElementById('session-expired-banner').classList.remove('hidden')
}
function hideSessionExpiredBanner() {
  document.getElementById('session-expired-banner').classList.add('hidden')
}

function showTrackerView(email) {
  document.getElementById('login-view').classList.add('hidden')
  document.getElementById('tracker-view').classList.remove('hidden')
  document.getElementById('userEmail').textContent = email
  hideSessionExpiredBanner()
}

function showLoginError(msg) {
  const el = document.getElementById('login-error')
  el.textContent = msg
  el.classList.remove('hidden')
}
function hideLoginError() {
  document.getElementById('login-error').classList.add('hidden')
}

function setLoginLoading(isLoading) {
  const btn     = document.getElementById('loginBtn')
  const btnText = document.getElementById('loginBtnText')
  const spinner = document.getElementById('loginBtnSpinner')
  btn.disabled        = isLoading
  btnText.textContent = isLoading ? 'Einloggen…' : 'Einloggen'
  spinner.classList.toggle('hidden', !isLoading)
}

// =============================================================
// Initialisierung – Session beim Öffnen prüfen
// =============================================================
function initAuth() {
  // Kein async-Check beim Start: gespeichertes Token wird blind vertraut.
  // Ungültige Tokens werden erst beim nächsten echten Schreibvorgang erkannt.
  const session = loadSession()
  if (session?.accessToken) {
    showTrackerView(session.email)
    initTracker(session.accessToken, session.userId)
    return
  }
  showLoginView()
}

// =============================================================
// Login-Formular
// =============================================================
document.getElementById('loginBtn').addEventListener('click', handleLogin)
document.getElementById('loginPassword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleLogin()
})

async function handleLogin() {
  hideLoginError()
  const email    = document.getElementById('loginEmail').value.trim()
  const password = document.getElementById('loginPassword').value
  if (!email || !password) { showLoginError('Bitte E-Mail und Passwort eingeben.'); return }

  setLoginLoading(true)
  try {
    const { accessToken, refreshToken, userId, email: userEmail } = await supabaseSignIn(email, password)
    saveSession(accessToken, refreshToken, userId, userEmail)
    showTrackerView(userEmail)
    initTracker(accessToken, userId)
  } catch (err) {
    showLoginError(err.message)
  } finally {
    setLoginLoading(false)
  }
}

// =============================================================
// Logout
// =============================================================
document.getElementById('logoutBtn').addEventListener('click', async () => {
  const session = loadSession()
  if (session?.accessToken) await supabaseSignOut(session.accessToken).catch(() => {})
  clearSession()
  showLoginView()
})

// =============================================================
// Tracker initialisieren
// =============================================================
function initTracker(accessToken, userId) {

  // ── Tab Navigation ───────────────────────────────────────
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
      tab.classList.add('active')
      document.getElementById(tab.dataset.tab).classList.add('active')
    })
  })

  // ── Heutige Summen laden und Counter befüllen ────────────
  async function refreshCounters() {
    const s = loadSession()
    if (!s?.accessToken) return   // kein Token → still ignorieren, kein Banner
    try {
      const totals = await loadDailyTotals(s.accessToken, s.userId ?? userId)
      document.querySelectorAll('.kpi-btn').forEach(btn => {
        const input = btn.querySelector('.counter-input')
        if (!input) return
        // Fokussiertes Feld NIEMALS überschreiben
        if (document.activeElement === input) return
        const val = Math.round(totals[btn.dataset.event] ?? 0)
        input.value        = val
        input.dataset.prev = val
      })
    } catch (err) {
      console.error('Fehler beim Laden der Tagessummen:', err)
      // Nur lesen, kein Banner – Schreibvorgänge entscheiden über Auth-Fehler
    }
  }

  refreshCounters()

  // ── Diff senden ──────────────────────────────────────────
  async function sendDiff(eventType, diff, counterInput, originBtn) {
    if (diff === 0) return
    try {
      await trackEventWithAuth(eventType, diff)
      // Erfolg → eventuellen Fehlerbanner sofort ausblenden
      hideSessionExpiredBanner()
      if (diff > 0) {
        showToast(`✓ ${eventType}${diff !== 1 ? ` (+${diff})` : ''}`, 'ok')
        if (diff === 1) triggerCelebration(eventType, originBtn)
      } else {
        showToast(`↩ ${eventType} (${diff})`, 'undo')
      }
    } catch (err) {
      console.error('Tracking-Fehler:', err)
      counterInput.value = counterInput.dataset.prev
      if (err.isAuthError) {
        showSessionExpiredBanner()
      } else {
        showToast('Fehler beim Speichern', 'err')
      }
    }
  }

  // ── KPI Button Events ────────────────────────────────────
  document.querySelectorAll('.kpi-btn').forEach(btn => {
    const eventType    = btn.dataset.event
    const counterInput = btn.querySelector('.counter-input')

    // Klick auf den großen Button → +1
    btn.addEventListener('click', async (e) => {
      if (e.target === counterInput) return   // Klick auf Input ignorieren
      const prev = parseInt(counterInput.dataset.prev ?? '0', 10)
      const next = prev + 1
      counterInput.value        = next
      counterInput.dataset.prev = next
      await sendDiff(eventType, 1, counterInput, btn)
    })

    // Klick/Mousedown auf Input: nicht an Button weitergeben
    counterInput.addEventListener('click',     (e) => e.stopPropagation())
    counterInput.addEventListener('mousedown', (e) => e.stopPropagation())

    // Fokus: gesamten Text markieren, damit man sofort überschreiben kann
    counterInput.addEventListener('focus', (e) => e.target.select())

    // Tippen: 800ms Debounce – leeres Feld darf stehen bleiben
    counterInput.addEventListener('input', () => {
      clearTimeout(counterInput._debounce)
      if (counterInput.value === '') return          // leer lassen, bis Nutzer fertig ist
      counterInput._debounce = setTimeout(async () => {
        const prev = parseInt(counterInput.dataset.prev ?? '0', 10)
        const next = parseInt(counterInput.value, 10)
        if (isNaN(next)) { counterInput.value = prev; return }
        const diff = next - prev
        if (diff === 0) return
        counterInput.dataset.prev = next
        await sendDiff(eventType, diff, counterInput, btn)
      }, 800)
    })

    // Blur / Enter: sofort senden, leeres Feld → 0
    counterInput.addEventListener('change', async () => {
      clearTimeout(counterInput._debounce)
      const prev    = parseInt(counterInput.dataset.prev ?? '0', 10)
      const rawVal  = counterInput.value.trim()
      const next    = rawVal === '' ? 0 : parseInt(rawVal, 10)
      if (isNaN(next)) { counterInput.value = prev; return }
      if (rawVal === '') counterInput.value = 0      // leeres Feld als 0 anzeigen
      const diff = next - prev
      if (diff === 0) return
      counterInput.dataset.prev = next
      await sendDiff(eventType, diff, counterInput, btn)
    })
  })

  // ── Betrag-Eingabefeld ───────────────────────────────────
  async function submitBetrag() {
    const input    = document.getElementById('betragInput')
    const absValue = parseFloat(input.value)
    if (isNaN(absValue) || absValue <= 0) {
      showToast('Bitte gültigen Betrag eingeben', 'err')
      input.focus()
      return
    }
    const btn = document.getElementById('betragBtn')
    btn.disabled = true
    try {
      await trackEventWithAuth('Betrag', absValue)
      // Erfolg → eventuellen Fehlerbanner ausblenden
      hideSessionExpiredBanner()
      input.value = ''
      showToast(`✓ Betrag ${absValue.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })} gespeichert`, 'ok')
    } catch (err) {
      console.error('Betrag-Fehler:', err)
      if (err.isAuthError) {
        showSessionExpiredBanner()
      } else {
        showToast('Fehler beim Speichern', 'err')
      }
    } finally {
      btn.disabled = false
    }
  }

  document.getElementById('betragBtn').addEventListener('click', submitBetrag)
  document.getElementById('betragInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitBetrag()
  })

  // ── Gesprächs-Checkliste ─────────────────────────────────
  const CHECKLIST_KEY = 'st_checklist'

  function loadChecklist() {
    try { return JSON.parse(localStorage.getItem(CHECKLIST_KEY)) ?? {} } catch { return {} }
  }
  function saveChecklist(state) {
    localStorage.setItem(CHECKLIST_KEY, JSON.stringify(state))
  }

  function renderChecklist() {
    const state = loadChecklist()
    document.querySelectorAll('.checklist-item').forEach(item => {
      const key      = item.dataset.check
      const required = parseInt(item.dataset.required ?? '1', 10)
      const count    = state[key] ?? 0
      const checked  = count >= required

      item.classList.toggle('checked', checked)

      const checkEl = item.querySelector('.checklist-check')
      checkEl.textContent = checked ? '✓' : ''

      const countEl = item.querySelector('.checklist-count')
      if (countEl) countEl.textContent = `${count}/${required}`
    })
  }

  document.querySelectorAll('.checklist-item').forEach(item => {
    item.addEventListener('click', async () => {
      const key       = item.dataset.check
      const eventType = item.dataset.event
      const required  = parseInt(item.dataset.required ?? '1', 10)
      const state     = loadChecklist()
      const current   = state[key] ?? 0
      if (required === 1 && current >= 1) return   // einfache Items: kein Re-Click
      state[key] = current + 1
      saveChecklist(state)
      renderChecklist()
      if (eventType) {
        try { await trackEventWithAuth(eventType, 1) } catch (_) { /* still loca */ }
      }
    })
  })

  document.getElementById('checklistResetBtn').addEventListener('click', () => {
    localStorage.removeItem(CHECKLIST_KEY)
    renderChecklist()
  })

  renderChecklist()
}

// =============================================================
// Session-Banner: Neu einloggen
// =============================================================
document.getElementById('reloginBtn').addEventListener('click', () => {
  clearSession()
  showLoginView()
})

// =============================================================
// Start
// =============================================================
initAuth()
