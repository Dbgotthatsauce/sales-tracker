// =============================================================
// Konfiguration – trage hier deine Supabase-Daten ein
// =============================================================
const SUPABASE_URL      = 'https://tcfoiduoquheqmnoigto.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRjZm9pZHVvcXVoZXFtbm9pZ3RvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0OTM1OTEsImV4cCI6MjA4OTA2OTU5MX0.8w9dxDfrgw5UG69BJW5se653wjXK1scNNGbnNr58524'

// =============================================================
// Session-Storage (localStorage bleibt über Popup-Öffnungen erhalten)
// =============================================================
const SESSION_KEY = 'st_session'

function saveSession(accessToken, userId, email) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ accessToken, userId, email }))
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) ?? null
  } catch {
    return null
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY)
}

// =============================================================
// Supabase Auth – REST API
// =============================================================
async function supabaseSignIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey':       SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error_description || data.msg || 'Login fehlgeschlagen')
  }
  return { accessToken: data.access_token, userId: data.user.id, email: data.user.email }
}

async function supabaseSignOut(accessToken) {
  await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${accessToken}`,
    },
  })
}

async function supabaseGetUser(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${accessToken}`,
    },
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
    throw new Error(`HTTP ${res.status}: ${text}`)
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
  if (errorMsg) showLoginError(errorMsg)
  document.getElementById('loginEmail').focus()
}

function showTrackerView(email) {
  document.getElementById('login-view').classList.add('hidden')
  document.getElementById('tracker-view').classList.remove('hidden')
  document.getElementById('userEmail').textContent = email
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
async function initAuth() {
  const session = loadSession()

  if (session?.accessToken) {
    // Token gegen Supabase validieren
    const user = await supabaseGetUser(session.accessToken)
    if (user) {
      showTrackerView(session.email)
      initTracker(session.accessToken, session.userId)
      return
    }
    // Token abgelaufen
    clearSession()
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

  if (!email || !password) {
    showLoginError('Bitte E-Mail und Passwort eingeben.')
    return
  }

  setLoginLoading(true)
  try {
    const { accessToken, userId, email: userEmail } = await supabaseSignIn(email, password)
    saveSession(accessToken, userId, userEmail)
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
  if (session?.accessToken) {
    await supabaseSignOut(session.accessToken).catch(() => {})
  }
  clearSession()
  // Korrektur-Modus zurücksetzen
  document.getElementById('correctionMode').checked = false
  document.querySelector('.app').classList.remove('correction-mode')
  document.getElementById('correctionBanner').classList.add('hidden')
  showLoginView()
})

// =============================================================
// Tracker initialisieren (wird nach erfolgreichem Login aufgerufen)
// =============================================================
function initTracker(accessToken, userId) {

  // ── Korrektur-Modus ────────────────────────────────────────
  const correctionToggle = document.getElementById('correctionMode')
  const correctionBanner = document.getElementById('correctionBanner')
  const appEl            = document.querySelector('.app')

  // Sicherstellen, dass kein doppelter Listener hängt
  const newToggle = correctionToggle.cloneNode(true)
  correctionToggle.replaceWith(newToggle)

  newToggle.addEventListener('change', () => {
    const active = newToggle.checked
    appEl.classList.toggle('correction-mode', active)
    correctionBanner.classList.toggle('hidden', !active)
  })

  // ── Tab Navigation ─────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
      tab.classList.add('active')
      document.getElementById(tab.dataset.tab).classList.add('active')
    })
  })

  // ── Betrag-Eingabefeld ─────────────────────────────────────
  async function submitBetrag() {
    const input = document.getElementById('betragInput')
    const absValue = parseFloat(input.value)

    if (isNaN(absValue) || absValue <= 0) {
      showToast('Bitte gültigen Betrag eingeben', 'err')
      input.focus()
      return
    }

    const currentSession = loadSession()
    const token = currentSession?.accessToken ?? accessToken
    const uid   = currentSession?.userId     ?? userId

    const betragBtn = document.getElementById('betragBtn')
    betragBtn.disabled = true

    try {
      await trackEvent('Betrag', absValue, token, uid)
      input.value = ''
      showToast(`✓ Betrag ${absValue.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })} gespeichert`, 'ok')
    } catch (err) {
      console.error('Betrag-Fehler:', err)
      showToast('Fehler beim Speichern', 'err')
    } finally {
      betragBtn.disabled = false
    }
  }

  document.getElementById('betragBtn').addEventListener('click', submitBetrag)
  document.getElementById('betragInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitBetrag()
  })

  // ── KPI Button Clicks ──────────────────────────────────────
  document.querySelectorAll('.kpi-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const eventType  = btn.dataset.event
      const manualInput = document.getElementById('manualValue')
      const rawValue   = manualInput.value.trim()
      const absValue   = rawValue !== '' ? parseFloat(rawValue) : 1

      if (isNaN(absValue) || absValue <= 0) {
        showToast('Ungültiger Wert eingegeben', 'err')
        return
      }

      // Frische Session aus localStorage lesen (Token könnte erneuert worden sein)
      const currentSession = loadSession()
      const token = currentSession?.accessToken ?? accessToken
      const uid   = currentSession?.userId     ?? userId

      const isCorrection = document.getElementById('correctionMode').checked
      const value        = isCorrection ? -absValue : absValue

      const allBtns = document.querySelectorAll('.kpi-btn')
      allBtns.forEach(b => b.disabled = true)

      try {
        await trackEvent(eventType, value, token, uid)

        const displayValue = Number.isInteger(absValue) ? absValue : absValue.toFixed(2)
        if (isCorrection) {
          showToast(`↩ −${displayValue} ${eventType}`, 'undo')
        } else {
          showToast(absValue !== 1 ? `✓ ${eventType} (+${displayValue})` : `✓ ${eventType}`, 'ok')
        }
        manualInput.value = ''

      } catch (err) {
        console.error('Tracking-Fehler:', err)
        showToast('Fehler beim Speichern', 'err')
      } finally {
        allBtns.forEach(b => b.disabled = false)
      }
    })
  })
}

// =============================================================
// Start
// =============================================================
initAuth()
