'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import React from 'react'
import {
  Phone, UserCheck, Briefcase, DoorClosed, Handshake,
  BookOpen, Target, CalendarCheck, CalendarX, RefreshCw,
  XCircle, Ghost, PhoneForwarded, CheckCheck, MessageSquare,
  FolderSync, CalendarPlus, Trophy, Euro, Search, LogOut,
  ChevronLeft, ChevronRight, ClipboardList,
} from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts'
import { supabase } from '@/lib/supabase'
import { ADMIN_EMAILS } from '@/lib/config'
import { clearSessionCookie } from '@/lib/session-cookie'

// ─── Types ────────────────────────────────────────────────────
type Totals = Record<string, number>
type Filter = 'today' | 'week' | 'month' | 'all' | 'custom'
type RawEvent = { event_type: string; value: number; created_at: string }
type ChartPoint = Record<string, number | string>

interface UserProfile {
  id: string
  email: string
}

const FILTER_LABELS: Record<Filter, string> = {
  today:  'Heute',
  week:   'Diese Woche',
  month:  'Dieser Monat',
  all:    'Gesamt',
  custom: 'Benutzerdefiniert',
}

function todayString() {
  return new Date().toISOString().slice(0, 10)
}

function getStartDate(filter: Filter): Date | null {
  const now = new Date()
  if (filter === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  }
  if (filter === 'week') {
    const day = now.getDay() === 0 ? 6 : now.getDay() - 1
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day, 0, 0, 0, 0)
    return monday
  }
  if (filter === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  }
  return null
}

// ─── Chart helpers ────────────────────────────────────────────
const CHART_COLORS = ['#6366f1', '#22d3ee', '#a78bfa', '#34d399', '#fb923c', '#f472b6']

const MONTH_ABBR = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez']
const WEEKDAY_ORDER = ['Mo','Di','Mi','Do','Fr','Sa','So']
const JS_DAY_TO_LABEL: Record<number, string> = { 1:'Mo', 2:'Di', 3:'Mi', 4:'Do', 5:'Fr', 6:'Sa', 0:'So' }

function getTimeBuckets(filter: Filter, from: string, to: string): string[] {
  if (filter === 'today') {
    return Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`)
  }
  if (filter === 'week') return WEEKDAY_ORDER
  if (filter === 'month') {
    const now = new Date()
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
    return Array.from({ length: days }, (_, i) => String(i + 1))
  }
  if (filter === 'all') return MONTH_ABBR
  // custom
  if (from && to) {
    const start = new Date(from + 'T00:00:00')
    const end   = new Date(to   + 'T23:59:59')
    const diffDays = Math.ceil((end.getTime() - start.getTime()) / 86400000)
    if (diffDays <= 31) {
      const buckets: string[] = []
      const cur = new Date(start)
      while (cur <= end) {
        buckets.push(`${String(cur.getDate()).padStart(2,'0')}.${String(cur.getMonth()+1).padStart(2,'0')}`)
        cur.setDate(cur.getDate() + 1)
      }
      return buckets
    }
    const buckets: string[] = []
    const cur = new Date(start.getFullYear(), start.getMonth(), 1)
    const endMonth = new Date(end.getFullYear(), end.getMonth(), 1)
    while (cur <= endMonth) {
      buckets.push(`${MONTH_ABBR[cur.getMonth()]} ${cur.getFullYear()}`)
      cur.setMonth(cur.getMonth() + 1)
    }
    return buckets
  }
  return []
}

function getEventBucket(createdAt: string, filter: Filter, from: string, to: string): string {
  const d = new Date(createdAt)
  if (filter === 'today')  return `${String(d.getHours()).padStart(2, '0')}:00`
  if (filter === 'week')   return JS_DAY_TO_LABEL[d.getDay()] ?? ''
  if (filter === 'month')  return String(d.getDate())
  if (filter === 'all')    return MONTH_ABBR[d.getMonth()]
  if (from && to) {
    const start = new Date(from + 'T00:00:00')
    const end   = new Date(to   + 'T23:59:59')
    const diffDays = Math.ceil((end.getTime() - start.getTime()) / 86400000)
    if (diffDays <= 31) {
      return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}`
    }
    return `${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`
  }
  return ''
}

function buildChartData(
  events: RawEvent[],
  kpiKeys: string[],
  filter: Filter,
  from: string,
  to: string,
): ChartPoint[] {
  // For 'all', derive the full date range from actual event data
  if (filter === 'all') {
    if (events.length === 0) return []
    const timestamps = events.map(e => new Date(e.created_at).getTime())
    const minDate = new Date(Math.min(...timestamps))
    const maxDate = new Date(Math.max(...timestamps))
    const buckets: string[] = []
    const cur = new Date(minDate.getFullYear(), minDate.getMonth(), 1)
    const end = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1)
    while (cur <= end) {
      buckets.push(`${MONTH_ABBR[cur.getMonth()]} ${cur.getFullYear()}`)
      cur.setMonth(cur.getMonth() + 1)
    }
    const acc: Record<string, Record<string, number>> = {}
    for (const b of buckets) acc[b] = Object.fromEntries(kpiKeys.map(k => [k, 0]))
    for (const ev of events) {
      if (!kpiKeys.includes(ev.event_type)) continue
      const d = new Date(ev.created_at)
      const b = `${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`
      if (acc[b] !== undefined) {
        acc[b][ev.event_type] = (acc[b][ev.event_type] ?? 0) + Number(ev.value)
      }
    }
    return buckets.map(b => ({ label: b, ...acc[b] }))
  }

  const buckets = getTimeBuckets(filter, from, to)
  const acc: Record<string, Record<string, number>> = {}
  for (const b of buckets) {
    acc[b] = Object.fromEntries(kpiKeys.map(k => [k, 0]))
  }
  for (const ev of events) {
    if (!kpiKeys.includes(ev.event_type)) continue
    const b = getEventBucket(ev.created_at, filter, from, to)
    if (b && acc[b] !== undefined) {
      acc[b][ev.event_type] = (acc[b][ev.event_type] ?? 0) + Number(ev.value)
    }
  }
  return buckets.map(b => ({ label: b, ...acc[b] }))
}

// ─── Sub-components ───────────────────────────────────────────
interface KpiCardProps { label: string; value: string | number; icon: React.ReactNode }
function KpiCard({ label, value, icon }: KpiCardProps) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest text-slate-500 leading-tight">{label}</span>
        <span className="text-slate-600 shrink-0">{icon}</span>
      </div>
      <span className="text-2xl font-bold text-slate-100 tabular-nums">{value}</span>
    </div>
  )
}

function GroupHeading({ label }: { label: string }) {
  return (
    <div className="col-span-full flex items-center gap-3 pt-2 first:pt-0">
      <span className="text-xs font-bold uppercase tracking-widest text-slate-500">{label}</span>
      <div className="flex-1 h-px bg-slate-700" />
    </div>
  )
}

interface RateCardProps { label: string; numeratorLabel: string; denominatorLabel: string; rate: string }
function RateCard({ label, numeratorLabel, denominatorLabel, rate }: RateCardProps) {
  const rateNum  = parseFloat(rate)
  const barWidth = Math.min(rateNum, 100)
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-800 p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-slate-300 leading-tight">{label}</span>
        <span className="text-2xl font-bold tabular-nums shrink-0 text-slate-100">{rate}%</span>
      </div>
      <div className="h-1 rounded-full bg-slate-700 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700 bg-indigo-500" style={{ width: `${barWidth}%` }} />
      </div>
      <div className="flex items-center gap-1 text-xs text-slate-600">
        <span className="text-slate-500">{numeratorLabel}</span>
        <span>÷</span>
        <span className="text-slate-500">{denominatorLabel}</span>
      </div>
    </div>
  )
}

function SectionHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-bold text-white">{title}</h2>
      {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
    </div>
  )
}

// ─── KPI Trend Chart ─────────────────────────────────────────
interface KpiTrendChartProps {
  data: ChartPoint[]
  kpiKeys: string[]
}

function KpiTrendChart({ data, kpiKeys }: KpiTrendChartProps) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 p-5">
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 5, right: 16, left: -10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis
            dataKey="label"
            tick={{ fill: '#64748b', fontSize: 11 }}
            axisLine={{ stroke: '#334155' }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: '#64748b', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '10px', fontSize: '12px' }}
            labelStyle={{ color: '#94a3b8', marginBottom: '4px' }}
            itemStyle={{ color: '#e2e8f0' }}
          />
          <Legend wrapperStyle={{ fontSize: '12px', color: '#94a3b8', paddingTop: '12px' }} />
          {kpiKeys.map((key, i) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Date Range Picker ────────────────────────────────────────
const MONTH_NAMES = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember']
const WEEKDAY_LABELS = ['Mo','Di','Mi','Do','Fr','Sa','So']

function makeDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function formatDisplay(ds: string): string {
  if (!ds) return ''
  const [y, m, d] = ds.split('-')
  return `${d}.${m}.${y}`
}

interface DateRangePickerProps {
  from: string
  to: string
  onChange: (from: string, to: string) => void
  onApply: (from: string, to: string) => void
  onClose: () => void
}

function DateRangePicker({ from, to, onChange, onApply, onClose }: DateRangePickerProps) {
  const ref = useRef<HTMLDivElement>(null)

  const initDate = from ? new Date(from + 'T12:00:00') : new Date()
  const [leftYear,  setLeftYear]  = useState(initDate.getFullYear())
  const [leftMonth, setLeftMonth] = useState(initDate.getMonth())

  // After first click we wait for the second; null = picking first date
  const [pendingFrom, setPendingFrom] = useState<string | null>(null)
  const [hoverDate,   setHoverDate]   = useState<string | null>(null)

  const today = todayString()

  // Right month (always leftMonth + 1)
  const rightMonth = leftMonth === 11 ? 0 : leftMonth + 1
  const rightYear  = leftMonth === 11 ? leftYear + 1 : leftYear

  function prevMonth() {
    if (leftMonth === 0) { setLeftYear(y => y - 1); setLeftMonth(11) }
    else setLeftMonth(m => m - 1)
  }
  function nextMonth() {
    if (leftMonth === 11) { setLeftYear(y => y + 1); setLeftMonth(0) }
    else setLeftMonth(m => m + 1)
  }

  function handleDayClick(ds: string) {
    if (pendingFrom === null) {
      setPendingFrom(ds)
      onChange(ds, ds)
    } else {
      const [f, t] = ds >= pendingFrom ? [pendingFrom, ds] : [ds, pendingFrom]
      onChange(f, t)
      setPendingFrom(null)
      setHoverDate(null)
    }
  }

  // Range shown while hovering after first click
  const dispFrom = pendingFrom !== null && hoverDate !== null
    ? (hoverDate >= pendingFrom ? pendingFrom : hoverDate)
    : from
  const dispTo = pendingFrom !== null && hoverDate !== null
    ? (hoverDate >= pendingFrom ? hoverDate : pendingFrom)
    : (pendingFrom !== null ? pendingFrom : to)

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  function renderMonth(year: number, month: number, hasPrev: boolean, hasNext: boolean) {
    const firstDow   = new Date(year, month, 1).getDay()
    const offset     = firstDow === 0 ? 6 : firstDow - 1
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const cells: (number | null)[] = [
      ...Array(offset).fill(null),
      ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
    ]
    while (cells.length % 7 !== 0) cells.push(null)

    return (
      <div className="flex flex-col gap-1 min-w-[224px]">
        {/* Month navigation */}
        <div className="flex items-center justify-between mb-1">
          {hasPrev
            ? <button onClick={prevMonth} className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"><ChevronLeft size={14} /></button>
            : <div className="w-6" />}
          <span className="text-sm font-bold text-slate-100">{MONTH_NAMES[month]} {year}</span>
          {hasNext
            ? <button onClick={nextMonth} className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"><ChevronRight size={14} /></button>
            : <div className="w-6" />}
        </div>

        {/* Weekday headers */}
        <div className="grid grid-cols-7 mb-0.5">
          {WEEKDAY_LABELS.map(d => (
            <span key={d} className="text-center text-xs font-semibold text-slate-500 py-1">{d}</span>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {cells.map((day, i) => {
            if (day === null) return <div key={i} className="h-8" />
            const ds       = makeDateStr(year, month, day)
            const isFrom   = ds === dispFrom
            const isTo     = ds === dispTo
            const inRange  = !!dispFrom && !!dispTo && ds > dispFrom && ds < dispTo
            const isToday  = ds === today
            const isSingle = isFrom && isTo

            return (
              <button
                key={i}
                onClick={() => handleDayClick(ds)}
                onMouseEnter={() => pendingFrom !== null && setHoverDate(ds)}
                onMouseLeave={() => pendingFrom !== null && setHoverDate(null)}
                className={[
                  'relative h-8 text-xs font-medium transition-colors cursor-pointer select-none',
                  isFrom || isTo ? 'bg-indigo-600 text-white' : '',
                  inRange        ? 'bg-indigo-900/50 text-slate-200' : '',
                  !isFrom && !isTo && !inRange ? 'text-slate-300 hover:bg-slate-700 hover:text-white' : '',
                  isSingle       ? 'rounded-lg' : isFrom ? 'rounded-l-lg' : isTo ? 'rounded-r-lg' : '',
                ].join(' ')}
              >
                {day}
                {isToday && !isFrom && !isTo && (
                  <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-indigo-400" />
                )}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  const rangeLabel = from && to
    ? from === to ? formatDisplay(from) : `${formatDisplay(from)} – ${formatDisplay(to)}`
    : 'Zeitraum wählen'

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-2 z-50 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-5 flex flex-col gap-4"
    >
      <div className="flex gap-6">
        {renderMonth(leftYear, leftMonth, true, false)}
        <div className="w-px bg-slate-700 self-stretch" />
        {renderMonth(rightYear, rightMonth, false, true)}
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-slate-700">
        <span className="text-xs text-slate-500">{pendingFrom ? `Von: ${formatDisplay(pendingFrom)} …` : rangeLabel}</span>
        <button
          onClick={() => { onApply(from, to); onClose() }}
          disabled={!from || !to || !!pendingFrom}
          className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          Anwenden
        </button>
      </div>
    </div>
  )
}

// ─── Auth Loading Screen ──────────────────────────────────────
function AuthLoading() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="flex items-center gap-3 text-slate-500">
        <span className="inline-block animate-spin text-xl">↻</span>
        <span className="text-sm">Authentifizierung…</span>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────
export default function DashboardPage() {
  const router = useRouter()

  // Auth-State
  const [authLoading, setAuthLoading] = useState(true)
  const [userEmail, setUserEmail]     = useState<string>('')
  const [userId, setUserId]           = useState<string>('')
  const [isAdmin, setIsAdmin]         = useState(false)

  // Dashboard-State
  const [totals, setTotals]               = useState<Totals>({})
  const [rawEvents, setRawEvents]         = useState<RawEvent[]>([])
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState<string | null>(null)
  const [lastUpdated, setLastUpdated]     = useState<Date | null>(null)
  const [filter, setFilter]               = useState<Filter>('today')
  const [customFrom, setCustomFrom]       = useState<string>(todayString)
  const [customTo, setCustomTo]           = useState<string>(todayString)
  const [showPicker, setShowPicker]       = useState(false)
  const [users, setUsers]                 = useState<UserProfile[]>([])
  const [selectedUserId, setSelectedUserId] = useState<string>('all')
  const [activeTab, setActiveTab]         = useState<'cold-calling' | 'setting' | 'closing'>('cold-calling')

  // ── Auth-Check beim ersten Laden ──────────────────────────
  useEffect(() => {
    async function checkAuth() {
      // getUser() validiert den Token gegen den Supabase-Server (sicherer als getSession())
      const { data: { user }, error } = await supabase.auth.getUser()

      if (error || !user) {
        clearSessionCookie()
        router.replace('/login')
        return
      }

      const email = user.email ?? ''
      const uid   = user.id
      const admin = ADMIN_EMAILS.includes(email)

      setUserEmail(email)
      setUserId(uid)
      setIsAdmin(admin)

      // Normaler User sieht nur eigene Daten → sofort User-ID setzen
      if (!admin) setSelectedUserId(uid)

      setAuthLoading(false)
    }

    checkAuth()

    // Auth-State-Änderungen abonnieren (Token-Refresh, Logout)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        clearSessionCookie()
        router.replace('/login')
      }
    })

    return () => subscription.unsubscribe()
  }, [router])

  // ── Nutzer laden (nur für Admins) ─────────────────────────
  useEffect(() => {
    if (!isAdmin || authLoading) return
    async function loadUsers() {
      const { data } = await supabase.from('user_profiles').select('id, email').order('email')
      if (data) setUsers(data)
    }
    loadUsers()
  }, [isAdmin, authLoading])

  // ── Daten laden ───────────────────────────────────────────
  function buildQuery(
    activeFilter: Filter,
    activeUserId: string,
    activeFrom: string,
    activeTo: string,
  ) {
    let q = supabase.from('tracking_events').select('event_type, value, created_at')

    if (activeFilter === 'custom') {
      if (activeFrom) q = q.gte('created_at', new Date(activeFrom).toISOString())
      if (activeTo) {
        const toDate = new Date(activeTo)
        toDate.setDate(toDate.getDate() + 1)
        q = q.lt('created_at', toDate.toISOString())
      }
    } else {
      const startDate = getStartDate(activeFilter)
      if (startDate) q = q.gte('created_at', startDate.toISOString())
    }

    if (activeUserId !== 'all') q = q.eq('user_id', activeUserId)

    return q
  }

  async function loadData(
    activeFilter: Filter  = filter,
    activeUserId: string  = selectedUserId,
    activeFrom:   string  = customFrom,
    activeTo:     string  = customTo,
  ) {
    setLoading(true)
    setError(null)

    // Paginierung: Supabase limitiert serverseitig auf max. 1000 Zeilen,
    // daher in 1000er-Batches laden bis alle Daten geholt sind.
    const PAGE = 1000
    const all: RawEvent[] = []
    let offset = 0

    while (true) {
      const { data, error: sbError } = await buildQuery(activeFilter, activeUserId, activeFrom, activeTo)
        .range(offset, offset + PAGE - 1)

      if (sbError) { setError(sbError.message); setLoading(false); return }

      all.push(...((data ?? []) as RawEvent[]))
      if ((data?.length ?? 0) < PAGE) break
      offset += PAGE
    }

    const agg: Totals = {}
    for (const row of all) {
      agg[row.event_type] = (agg[row.event_type] ?? 0) + Number(row.value)
    }
    setTotals(agg)
    setRawEvents(all)
    setLastUpdated(new Date())
    setLoading(false)
  }

  // Neu laden wenn Filter oder User-Auswahl sich ändert (und Auth fertig ist)
  useEffect(() => {
    if (authLoading) return
    loadData(filter, selectedUserId)
  }, [filter, selectedUserId, authLoading])

  async function handleLogout() {
    await supabase.auth.signOut()
    clearSessionCookie()
    router.replace('/login')
  }

  const get = (key: string) => totals[key] ?? 0

  const rate = (numKey: string, denKey: string): string => {
    const den = get(denKey)
    if (den === 0) return '0.0'
    return ((get(numKey) / den) * 100).toFixed(1)
  }

  const rateRaw = (num: number, den: number): string => {
    if (den === 0) return '0.0'
    return ((num / den) * 100).toFixed(1)
  }

  // ── Auth lädt noch → Ladescreen ──────────────────────────
  if (authLoading) return <AuthLoading />

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">

      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-950 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex flex-col gap-3">

          {/* Titelzeile */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src="/logo.svg" alt="Logo" className="h-8 w-8 object-contain" />
              <div>
                <h1 className="text-lg font-bold text-white leading-tight">Sales Tracking Dashboard</h1>
                <p className="text-xs text-slate-500">
                  {isAdmin ? 'Aggregierte KPIs aller Aktivitäten' : `Deine persönlichen KPIs · ${userEmail}`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {lastUpdated && (
                <span className="text-xs text-slate-600 hidden sm:block">
                  Stand: {lastUpdated.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr
                </span>
              )}

              {/* Nutzer-Dropdown – nur für Admins, dezent im Header */}
              {isAdmin && (
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-slate-500 text-xs">▾</span>
                  <select
                    value={selectedUserId}
                    onChange={(e) => setSelectedUserId(e.target.value)}
                    disabled={loading}
                    className="appearance-none pl-3 pr-7 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-200 cursor-pointer transition-colors hover:border-slate-500 focus:outline-none focus:border-indigo-500 disabled:cursor-not-allowed"
                  >
                    <option value="all">👥 Gesamtes Team</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.email}</option>
                    ))}
                  </select>
                </div>
              )}

              <button
                onClick={() => loadData(filter, selectedUserId)}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-colors disabled:opacity-50 cursor-pointer"
              >
                <span className={loading ? 'inline-block animate-spin' : ''}>↻</span>
                {loading ? 'Lädt…' : 'Aktualisieren'}
              </button>

              {/* Logout */}
              <button
                onClick={handleLogout}
                title="Ausloggen"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              >
                <LogOut size={13} />
                <span className="hidden sm:inline">Logout</span>
              </button>
            </div>
          </div>

          {/* Filterleiste – nur Zeitfilter */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-700 rounded-xl">
              {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => {
                    setFilter(f)
                    if (f === 'custom') setShowPicker(true)
                    else setShowPicker(false)
                  }}
                  disabled={loading}
                  className={[
                    'px-4 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 cursor-pointer disabled:cursor-not-allowed',
                    filter === f
                      ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-900'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800',
                  ].join(' ')}
                >
                  {FILTER_LABELS[f]}
                </button>
              ))}
            </div>

            {filter === 'custom' && (
              <div className="relative">
                <button
                  onClick={() => setShowPicker(p => !p)}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-200 hover:border-indigo-500 transition-colors cursor-pointer"
                >
                  <CalendarCheck size={12} />
                  {customFrom && customTo && customFrom !== customTo
                    ? `${customFrom.split('-').reverse().join('.')} – ${customTo.split('-').reverse().join('.')}`
                    : customFrom
                      ? customFrom.split('-').reverse().join('.')
                      : 'Zeitraum wählen'}
                </button>
                {showPicker && (
                  <DateRangePicker
                    from={customFrom}
                    to={customTo}
                    onChange={(f, t) => { setCustomFrom(f); setCustomTo(t) }}
                    onApply={(f, t) => loadData('custom', selectedUserId, f, t)}
                    onClose={() => setShowPicker(false)}
                  />
                )}
              </div>
            )}
          </div>

          {/* Tab-Leiste */}
          <div className="flex border-b border-slate-800 -mb-4">
            {([
              { id: 'cold-calling', label: 'Cold Calling' },
              { id: 'setting',      label: 'Setting'      },
              { id: 'closing',      label: 'Closing'      },
            ] as const).map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={[
                  'px-5 py-3 text-sm font-semibold border-b-2 transition-colors cursor-pointer',
                  activeTab === id
                    ? 'border-indigo-500 text-slate-100'
                    : 'border-transparent text-slate-500 hover:text-slate-300 hover:border-slate-600',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>

        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-10">

        {/* Error Banner */}
        {error && (
          <div className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-slate-300">
            <strong className="text-slate-300">Fehler beim Laden:</strong> {error}
          </div>
        )}

        {/* Skeleton */}
        {loading && !error && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-slate-700 bg-slate-800 h-20 animate-pulse" />
              ))}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="rounded-xl border border-slate-700 bg-slate-800 h-24 animate-pulse" />
              ))}
            </div>
          </div>
        )}

        {/* ── Tab: Cold Calling ───────────────────────────────── */}
        {!loading && activeTab === 'cold-calling' && (
          <>
            <section>
              <SectionHeading title="Aktivitäten" subtitle="Cold Calling KPIs" />
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
                <KpiCard label="Anwahlen"               value={get('Anwahlen')}                 icon={<Phone size={16} />} />
                <KpiCard label="Erreichte Personen"     value={get('Erreichte Personen')}       icon={<UserCheck size={16} />} />
                <KpiCard label="Entscheider"            value={get('Entscheider')}              icon={<Briefcase size={16} />} />
                <KpiCard label="An Vorzimmer gescheit." value={get('An Vorzimmer gescheitert')} icon={<DoorClosed size={16} />} />
                <KpiCard label="Intro"                  value={get('Intro')}                    icon={<Handshake size={16} />} />
                <KpiCard label="Short Story"            value={get('Short Story')}              icon={<BookOpen size={16} />} />
                <KpiCard label="Pitch"                  value={get('Pitch')}                    icon={<Target size={16} />} />
                <KpiCard label="Nach Termin gefragt"    value={get('Nach Termin gefragt')}      icon={<CalendarCheck size={16} />} />
                <KpiCard label="Termin vereinbart"      value={get('Termin vereinbart')}        icon={<CheckCheck size={16} />} />
                <KpiCard label="Qualifying"             value={get('Qualifying')}               icon={<ClipboardList size={16} />} />
                <KpiCard label="Nachqualifizierung"     value={get('Nachqualifizierung')}       icon={<Search size={16} />} />
              </div>
            </section>
            <section>
              <SectionHeading title="Quoten" subtitle="Conversion Rates Cold Calling" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <RateCard label="Anwahlen → Termin vereinbart"      numeratorLabel="Termin vereinbart"   denominatorLabel="Anwahlen"            rate={rate('Termin vereinbart', 'Anwahlen')} />
                <RateCard label="Anwahlen → Erreichte Personen"     numeratorLabel="Erreichte Personen"  denominatorLabel="Anwahlen"            rate={rate('Erreichte Personen', 'Anwahlen')} />
                <RateCard label="Erreichte Personen → Entscheider"  numeratorLabel="Entscheider"         denominatorLabel="Erreichte Personen"  rate={rate('Entscheider', 'Erreichte Personen')} />
                <RateCard label="Anwahlen → Entscheider"            numeratorLabel="Entscheider"         denominatorLabel="Anwahlen"            rate={rate('Entscheider', 'Anwahlen')} />
                <RateCard label="Entscheider → Termin vereinbart"   numeratorLabel="Termin vereinbart"   denominatorLabel="Entscheider"         rate={rate('Termin vereinbart', 'Entscheider')} />
                <RateCard label="Pitch → Nach Termin gefragt"       numeratorLabel="Nach Termin gefragt" denominatorLabel="Pitch"               rate={rate('Nach Termin gefragt', 'Pitch')} />
                <RateCard label="Termin vereinbart → Qualifying"    numeratorLabel="Qualifying"          denominatorLabel="Termin vereinbart"   rate={rate('Qualifying', 'Termin vereinbart')} />
              </div>
            </section>
            <section>
              <SectionHeading title="Verlauf" subtitle={`KPI-Entwicklung · ${FILTER_LABELS[filter]}`} />
              <KpiTrendChart
                data={buildChartData(rawEvents, ['Anwahlen','Erreichte Personen','Entscheider','Termin vereinbart','Qualifying'], filter, customFrom, customTo)}
                kpiKeys={['Anwahlen','Erreichte Personen','Entscheider','Termin vereinbart','Qualifying']}
              />
            </section>
          </>
        )}

        {/* ── Tab: Setting ────────────────────────────────────── */}
        {!loading && activeTab === 'setting' && (
          <>
            <section>
              <SectionHeading title="Aktivitäten" subtitle="Setting KPIs" />
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
                <KpiCard label="Setting geführt"        value={get('Setting geführt')}        icon={<MessageSquare size={16} />} />
                <KpiCard label="Setting Unqualifiziert" value={get('Setting Unqualifiziert')} icon={<XCircle size={16} />} />
                <KpiCard label="No Show"                value={get('No Show')}                icon={<Ghost size={16} />} />
                <KpiCard label="Setting Follow Up"      value={get('Setting Follow Up')}      icon={<RefreshCw size={16} />} />
                <KpiCard label="Closing terminiert"     value={get('Closing terminiert')}     icon={<PhoneForwarded size={16} />} />
              </div>
            </section>
            <section>
              <SectionHeading title="Quoten" subtitle="Conversion Rates Setting" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <RateCard label="Setting → Closing (terminiert)" numeratorLabel="Closing terminiert"     denominatorLabel="Setting geführt"   rate={rate('Closing terminiert', 'Setting geführt')} />
                <RateCard label="Setting → Unqualifiziert"       numeratorLabel="Setting Unqualifiziert" denominatorLabel="Setting geführt"   rate={rate('Setting Unqualifiziert', 'Setting geführt')} />
                <RateCard label="Termin vereinbart → No Show"    numeratorLabel="No Show"                denominatorLabel="Termin vereinbart" rate={rate('No Show', 'Termin vereinbart')} />
              </div>
            </section>
            <section>
              <SectionHeading title="Verlauf" subtitle={`KPI-Entwicklung · ${FILTER_LABELS[filter]}`} />
              <KpiTrendChart
                data={buildChartData(rawEvents, ['Setting geführt','Closing terminiert','No Show','Setting Follow Up'], filter, customFrom, customTo)}
                kpiKeys={['Setting geführt','Closing terminiert','No Show','Setting Follow Up']}
              />
            </section>
          </>
        )}

        {/* ── Tab: Closing ────────────────────────────────────── */}
        {!loading && activeTab === 'closing' && (
          <>
            <div className="rounded-xl border border-slate-600 bg-slate-800 p-5 flex items-center gap-4">
              <div className="w-10 h-10 rounded-lg bg-slate-700 flex items-center justify-center shrink-0">
                <Euro size={20} className="text-indigo-400" />
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-slate-500">Gesamtbetrag</p>
                <p className="text-3xl font-bold text-slate-100 tabular-nums">
                  {get('Betrag').toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })}
                </p>
              </div>
            </div>
            <section>
              <SectionHeading title="Aktivitäten" subtitle="Closing KPIs" />
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
                <KpiCard label="Closing geführt"          value={get('Closing geführt')}           icon={<MessageSquare size={16} />} />
                <KpiCard label="Closing No Show"          value={get('Closing No Show')}           icon={<Ghost size={16} />} />
                <KpiCard label="Closing Follow Up"        value={get('Closing Follow Up')}         icon={<FolderSync size={16} />} />
                <KpiCard label="Folgebesprechung ver."    value={get('Folgebesprechung vereinbart')} icon={<CalendarPlus size={16} />} />
                <KpiCard label="Folgebesprechung No Show" value={get('Folgebesprechung No Show')}  icon={<CalendarX size={16} />} />
                <KpiCard label="Als Kunden gewonnen"      value={get('Als Kunden gewonnen')}       icon={<Trophy size={16} />} />
              </div>
            </section>
            <section>
              <SectionHeading title="Quoten" subtitle="Conversion Rates Closing" />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <RateCard label="Closing geführt → Kunden gewonnen"       numeratorLabel="Als Kunden gewonnen"        denominatorLabel="Closing geführt"              rate={rate('Als Kunden gewonnen', 'Closing geführt')} />
                <RateCard label="Closing vereinbart → No Show Rate"        numeratorLabel="Closing No Show"            denominatorLabel="Closing terminiert"           rate={rate('Closing No Show', 'Closing terminiert')} />
                <RateCard label="Closing No Show → Folgebesprechung ver."  numeratorLabel="Folgebesprechung vereinbart" denominatorLabel="Closing No Show"             rate={rate('Folgebesprechung vereinbart', 'Closing No Show')} />
                <RateCard label="No Show → Follow Up (gesamt)"             numeratorLabel="Setting FU + Closing FU"   denominatorLabel="No Show + Closing No Show"    rate={rateRaw(get('Setting Follow Up') + get('Closing Follow Up'), get('No Show') + get('Closing No Show'))} />
                <RateCard label="Folgebesprechung ver. → No Show Rate"     numeratorLabel="Folgebesprechung No Show"   denominatorLabel="Folgebesprechung vereinbart"  rate={rate('Folgebesprechung No Show', 'Folgebesprechung vereinbart')} />
              </div>
            </section>
            <section>
              <SectionHeading title="Verlauf" subtitle={`KPI-Entwicklung · ${FILTER_LABELS[filter]}`} />
              <KpiTrendChart
                data={buildChartData(rawEvents, ['Closing geführt','Als Kunden gewonnen','Closing No Show','Closing Follow Up'], filter, customFrom, customTo)}
                kpiKeys={['Closing geführt','Als Kunden gewonnen','Closing No Show','Closing Follow Up']}
              />
            </section>
          </>
        )}

      </main>
    </div>
  )
}
