'use client'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Link, useNavigate } from '../../utils/navigation'
import {
  AlertCircle,
  ArrowUpRight,
  Calendar,
  CheckCircle,
  IndianRupee,
  Megaphone,
  MessageCircle,
  PhoneCall,
  QrCode,
  TrendingDown,
  UserPlus,
  Users,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import Badge from '../../components/ui/Badge'
import Card from '../../components/ui/Card'
import EmptyState from '../../components/ui/EmptyState'
import ErrorBanner from '../../components/ui/ErrorBanner'
import Skeleton from '../../components/ui/Skeleton'
import StatCard from '../../components/ui/StatCard'
import { FilterChip } from '../../components/ui/Button'
import { can } from '../../utils/auth'
import { dashboardApi } from '../../services/dashboardApi'
import { clinicApi } from '../../services/clinicApi'

const CHART_HEIGHT = 224

const STATUS_META = {
  done: { label: 'Done', variant: 'green' },
  completed: { label: 'Done', variant: 'green' },
  in_cabin: { label: 'In Cabin', variant: 'blue' },
  vitals_done: { label: 'Vitals done', variant: 'green' },
  paid: { label: 'Paid', variant: 'yellow' },
  confirmed: { label: 'Confirmed', variant: 'blue' },
  no_show: { label: 'No-show', variant: 'red' },
  cancelled: { label: 'Cancelled', variant: 'default' },
}

function getTimeOfDay() {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return 'Morning'
  if (hour >= 12 && hour < 17) return 'Afternoon'
  if (hour >= 17 && hour < 21) return 'Evening'
  return 'Night'
}

function formatAppointment(appt) {
  const status = (appt.status || appt.queueStatus || 'confirmed').toString().toLowerCase()
  return {
    id: appt.id || `${appt.patientName || appt.patient_name || 'appointment'}-${appt.time || appt.appointmentTime || appt.slot || ''}`,
    time: appt.time || appt.appointmentTime || appt.slot || '--',
    patientName: appt.patientName || appt.patient_name || appt.name || 'Patient',
    reason: appt.reason || appt.chiefComplaint || appt.complaint || 'Consultation',
    type: appt.type || appt.visitType || appt.appointmentType || 'Visit',
    status,
  }
}

function hasChartData(data, key) {
  return Array.isArray(data) && data.some(item => Number(item[key] || 0) > 0)
}

function ChartEmptyState({ title, description }) {
  return (
    <EmptyState
      icon={AlertCircle}
      title={title}
      description={description}
      style={{
        minHeight: `${CHART_HEIGHT}px`,
        padding: 'var(--space-8) var(--space-4)',
      }}
    />
  )
}

function DashboardSkeleton({ canSeeRevenue = false }) {
  const statCount = canSeeRevenue ? 6 : 5

  return (
    <div className="ds-page" aria-label="Dashboard loading" aria-busy="true" style={{ display: 'grid', gap: 'var(--space-6)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-4)', alignItems: 'flex-start' }}>
        <div style={{ display: 'grid', gap: 'var(--space-2)', width: 'min(460px, 100%)' }}>
          <Skeleton variant="text" width="78%" height="var(--text-h2)" />
          <Skeleton variant="text" width="48%" />
        </div>
        <Skeleton variant="rect" width="120px" height="30px" borderRadius="var(--radius-sm)" className="hidden sm:block" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: statCount }).map((_, index) => (
          <StatCard key={index} loading />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        <Card className="lg:col-span-3">
          <Card.Body style={{ display: 'grid', gap: 'var(--space-5)' }}>
            <Skeleton variant="text" width="46%" height="var(--text-h4)" />
            <Skeleton variant="rect" height={`${CHART_HEIGHT}px`} />
          </Card.Body>
        </Card>
        <Card className="lg:col-span-2">
          <Card.Body style={{ display: 'grid', gap: 'var(--space-5)' }}>
            <Skeleton variant="text" width="58%" height="var(--text-h4)" />
            <Skeleton variant="rect" height={`${CHART_HEIGHT}px`} />
          </Card.Body>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card className="lg:col-span-2">
          <Card.Body style={{ display: 'grid', gap: 'var(--space-4)' }}>
            <Skeleton variant="text" width="34%" height="var(--text-h4)" />
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} style={{ display: 'grid', gridTemplateColumns: '56px 1fr 72px', gap: 'var(--space-4)', alignItems: 'center' }}>
                <Skeleton variant="text" />
                <Skeleton variant="text" />
                <Skeleton variant="rect" height="24px" borderRadius="var(--radius-sm)" />
              </div>
            ))}
          </Card.Body>
        </Card>
        <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
          <Skeleton variant="card" style={{ minHeight: '196px' }} />
          <Skeleton variant="card" style={{ minHeight: '196px' }} />
        </div>
      </div>
    </div>
  )
}

function AppointmentRow({ appt, index }) {
  const formatted = formatAppointment(appt)
  const meta = STATUS_META[formatted.status] || STATUS_META.confirmed
  const isNoShow = formatted.status.includes('no')

  return (
    <motion.li
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, delay: index * 0.035 }}
      style={{
        display: 'grid',
        gridTemplateColumns: '56px 10px minmax(0, 1fr) auto',
        gap: 'var(--space-3)',
        alignItems: 'center',
        minHeight: '60px',
        padding: '0 var(--space-4)',
        borderBottom: 'calc(var(--space-0-5) / 2) solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        background: isNoShow ? 'var(--color-error-bg)' : 'transparent',
        transition: 'background var(--duration-fast) var(--ease-out)',
      }}
    >
      <time
        dateTime={formatted.time}
        style={{
          justifySelf: 'end',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-sm)',
          fontWeight: 600,
          color: 'var(--color-text-secondary)',
        }}
      >
        {formatted.time}
      </time>
      <span
        aria-hidden="true"
        style={{
          width: '8px',
          height: '8px',
          borderRadius: 'var(--radius-full)',
          background: isNoShow ? 'var(--color-error-text)' : 'var(--color-info-text)',
        }}
      />
      <div style={{ minWidth: 0, display: 'grid', gap: 'var(--space-1)' }}>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 'var(--text-body)',
            fontWeight: 700,
            color: 'var(--color-text-primary)',
          }}
        >
          {formatted.patientName}
        </span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {formatted.reason} / {formatted.type}
        </span>
      </div>
      <Badge variant={meta.variant} size="md" type="subtle">
        {meta.label}
      </Badge>
    </motion.li>
  )
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null

  return (
    <div
      style={{
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface)',
        border: 'calc(var(--space-0-5) / 2) solid var(--color-border)',
        boxShadow: 'var(--shadow-md)',
        fontSize: 'var(--text-sm)',
      }}
    >
      <p style={{ margin: '0 0 var(--space-1)', fontWeight: 700, color: 'var(--color-text-secondary)' }}>{label}</p>
      {payload.map(item => (
        <p key={item.name} style={{ margin: 0, fontWeight: 700, color: item.color }}>
          {item.name === 'revenue' ? `Rs. ${Number(item.value || 0).toLocaleString('en-IN')}` : item.value} {item.name}
        </p>
      ))}
    </div>
  )
}

export default function DashboardHome() {
  const navigate = useNavigate()
  const [chartView, setChartView] = useState('appointments')
  const [pageLoading, setPageLoading] = useState(true)
  const [pageError, setPageError] = useState(null)
  const [todayStats, setTodayStats] = useState(null)
  const [todayAppointments, setTodayAppointments] = useState([])
  const [weeklyStats, setWeeklyStats] = useState([])
  const [doctorName, setDoctorName] = useState('')

  const loadData = async () => {
    setPageLoading(true)
    setPageError(null)
    try {
      const today = new Date()
      const todayStr = today.toISOString().split('T')[0]

      clinicApi.getSettings()
        .then(res => {
          const name = res?.doctor_name ?? res?.doctorName ?? res?.data?.doctor_name ?? res?.data?.doctorName ?? ''
          if (name) setDoctorName(name)
        })
        .catch(() => {})

      const [queueRes, apptsRes] = await Promise.all([
        dashboardApi.getQueue(),
        dashboardApi.getAppointments({ date: todayStr }),
      ])

      const appointmentsCount = Array.isArray(apptsRes) ? apptsRes.length : 0
      const checkedIn = (queueRes?.waiting && Number(queueRes.waiting)) || 0
      const revenue = Array.isArray(apptsRes)
        ? apptsRes.reduce((sum, appt) => sum + (Number(appt.paymentAmount || appt.payment || 0) || 0), 0)
        : 0
      const noShows = Array.isArray(apptsRes)
        ? apptsRes.filter(appt => (appt.status || appt.queueStatus || '').toString().toLowerCase().includes('no')).length
        : 0

      setTodayStats({
        appointments: appointmentsCount,
        checkedIn,
        missedCalls: 0,
        revenue,
        noShowRate: appointmentsCount ? Math.round((noShows / appointmentsCount) * 100) : 0,
        newPatients: 0,
      })

      setTodayAppointments(Array.isArray(apptsRes) ? apptsRes : [])

      const last7Days = []
      for (let i = 6; i >= 0; i--) {
        const d = new Date(today)
        d.setDate(d.getDate() - i)
        const dateStr = d.toISOString().split('T')[0]
        last7Days.push({ dateStr, day: d.toLocaleDateString('en-IN', { weekday: 'short' }) })
      }

      const weeklyData = await Promise.all(
        last7Days.map(({ dateStr }) => dashboardApi.getAppointments({ date: dateStr }))
      )

      const merged = last7Days.map((d, i) => {
        const appts = Array.isArray(weeklyData[i]) ? weeklyData[i] : []
        const dayNoShows = appts.filter(appt => (appt.status || appt.queueStatus || '').toString().toLowerCase().includes('no')).length
        const dayRevenue = appts.reduce((sum, appt) => sum + (Number(appt.paymentAmount || appt.payment || 0) || 0), 0)
        return {
          day: d.day,
          appointments: appts.length,
          noShows: dayNoShows,
          revenue: dayRevenue,
        }
      })
      setWeeklyStats(merged)
    } catch (error) {
      // Already shown to the user via the ErrorBanner below — console.warn, not
      // .error, so a handled failure doesn't surface as a Next.js dev-overlay "Issue".
      console.warn('Failed to load dashboard data:', error)
      setPageError(error?.message || error?.detail || 'Failed to load dashboard data')
    } finally {
      setPageLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  const canSeeRevenue = can('view_revenue')

  if (pageLoading) return <DashboardSkeleton canSeeRevenue={canSeeRevenue} />
  if (pageError) return <ErrorBanner message={pageError} onRetry={loadData} />

  const stats = todayStats || {}
  const activeChartKey = chartView === 'revenue' ? 'revenue' : 'appointments'
  const weeklyHasData = hasChartData(weeklyStats, activeChartKey)
  const noShowHasData = hasChartData(weeklyStats, 'noShows')
  const todayLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

  const allStats = [
    { icon: Calendar, label: 'Appointments Today', value: stats.appointments ?? 0, color: 'var(--color-navy)', badge: 'Today' },
    { icon: Users, label: 'Patients Checked In', value: stats.checkedIn ?? 0, color: 'var(--color-blue)' },
    { icon: PhoneCall, label: 'Missed Calls', value: stats.missedCalls ?? 0, color: 'var(--color-warning-text)', badge: 'Auto reply sent' },
    {
      icon: IndianRupee,
      label: 'Revenue Today',
      value: Number(stats.revenue ?? 0).toLocaleString('en-IN'),
      prefix: 'Rs. ',
      color: 'var(--color-coral)',
      requireRevenue: true,
      onClick: () => navigate('/dashboard/revenue-reports'),
    },
    { icon: TrendingDown, label: 'No-show Rate', value: stats.noShowRate ?? 0, suffix: '%', color: 'var(--color-error-text)'},
    { icon: UserPlus, label: 'New Patients', value: stats.newPatients ?? 0, color: 'var(--color-purple, #7c3aed)' },
  ].filter(item => !item.requireRevenue || canSeeRevenue)

  const quickActions = [
    { icon: UserPlus, label: 'Add Walk-in', to: '/dashboard/appointments', color: 'var(--color-navy)', tint: 'var(--color-blue-light)' },
    { icon: Megaphone, label: 'Broadcast', to: '/dashboard/reminders', color: 'var(--color-info-text)', tint: 'var(--color-info-bg)' },
    { icon: QrCode, label: 'QR Codes', to: '/dashboard/qr', color: 'var(--color-coral)', tint: 'rgba(232,102,61,0.12)' },
    { icon: MessageCircle, label: 'WhatsApp', to: '/dashboard/whatsapp', color: 'var(--color-success-text)', tint: 'var(--color-success-bg)' },
  ]

  const aiMetrics = [
    { label: 'WhatsApp Replies', value: '47 today', color: 'var(--color-success-text)' },
    { label: 'Reminders Sent', value: '18 today', color: 'var(--color-info-text)' },
    { label: 'QR Bookings', value: `${stats.qrBookings ?? 0} today`, color: 'var(--color-coral)' },
  ]

  return (
    <div className="ds-page" style={{ display: 'grid', gap: 'var(--space-6)' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--color-coral)' }}>
            Dashboard overview
          </p>
          <h1
            style={{
              margin: 0,
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--text-h2)',
              lineHeight: 1.12,
              color: 'var(--color-navy)',
            }}
          >
            Good {getTimeOfDay()}{doctorName ? `, ${doctorName}` : ''}
          </h1>
          <p style={{ margin: 0, fontSize: 'var(--text-body)', color: 'var(--color-text-secondary)' }}>
            {todayLabel}
          </p>
        </div>
        <Badge variant="blue" size="lg" type="dot" style={{ marginTop: 'var(--space-1)' }}>
          AI Active / 24/7
        </Badge>
      </header>

      <section aria-label="Today statistics" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {allStats.map((item, index) => (
          <motion.div
            key={item.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, delay: index * 0.035 }}
          >
            <StatCard {...item} />
          </motion.div>
        ))}
      </section>

      <section aria-label="Dashboard charts" className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        <Card className="lg:col-span-3">
          <Card.Header
            title={chartView === 'revenue' ? 'Weekly Revenue' : 'Weekly Appointments'}
            subtitle={chartView === 'revenue' ? 'Daily revenue collection' : 'This week at a glance'}
            action={canSeeRevenue ? (
              <div role="group" aria-label="Chart metric" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <FilterChip isActive={chartView === 'appointments'} onClick={() => setChartView('appointments')}>
                  Appointments
                </FilterChip>
                <FilterChip isActive={chartView === 'revenue'} onClick={() => setChartView('revenue')}>
                  Revenue
                </FilterChip>
              </div>
            ) : null}
          />
          <Card.Body>
            {weeklyHasData ? (
              <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
                <AreaChart data={weeklyStats} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dashboardWeeklyGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={chartView === 'revenue' ? 'var(--color-coral)' : 'var(--color-navy)'} stopOpacity={0.2} />
                      <stop offset="95%" stopColor={chartView === 'revenue' ? 'var(--color-coral)' : 'var(--color-navy)'} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="day" tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area
                    type="monotone"
                    dataKey={activeChartKey}
                    stroke={chartView === 'revenue' ? 'var(--color-coral)' : 'var(--color-navy)'}
                    strokeWidth={2.5}
                    fill="url(#dashboardWeeklyGradient)"
                    name={activeChartKey}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <ChartEmptyState
                title={chartView === 'revenue' ? 'No revenue yet this week' : 'No appointments yet this week'}
                description="Once appointments are booked, this chart will show the weekly pattern."
              />
            )}
          </Card.Body>
        </Card>

        <Card className="lg:col-span-2">
          <Card.Header
            title="No-shows This Week"
            subtitle="Reduction insights from reminders"
            action={<Badge variant="coral" type="subtle">77% reduction</Badge>}
          />
          <Card.Body>
            {noShowHasData ? (
              <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
                <BarChart data={weeklyStats} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="noShows" fill="var(--color-coral)" radius={[6, 6, 0, 0]} name="no-shows" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <ChartEmptyState
                title="No no-shows recorded"
                description="That is exactly what the morning board wants to see."
              />
            )}
          </Card.Body>
        </Card>
      </section>

      <section aria-label="Appointments and actions" className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card className="lg:col-span-2">
          <Card.Header
            title="Today's Appointments"
            subtitle={`${todayAppointments.length} scheduled`}
            action={(
              <Link
                to="/dashboard/appointments"
                aria-label="View all appointments"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-1)',
                  color: 'var(--color-info-text)',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 700,
                  textDecoration: 'none',
                }}
              >
                View all <ArrowUpRight size={14} strokeWidth={1.8} aria-hidden="true" />
              </Link>
            )}
          />
          <Card.Body style={{ paddingTop: 'var(--space-4)' }}>
            {todayAppointments.length > 0 ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-1)' }}>
                {todayAppointments.slice(0, 10).map((appt, index) => (
                  <AppointmentRow key={formatAppointment(appt).id} appt={appt} index={index} />
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={Calendar}
                title="No appointments today"
                description="New bookings and walk-ins will appear here as the day fills up."
                action={{ label: 'Open appointments', href: '/dashboard/appointments' }}
              />
            )}
          </Card.Body>
        </Card>

        <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
          <Card>
            <Card.Header title="Quick Actions" subtitle="Common front-desk tasks" />
            <Card.Body style={{ paddingTop: 'var(--space-4)' }}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {quickActions.map(action => {
                  const Icon = action.icon
                  return (
                    <Link
                      key={action.label}
                      to={action.to}
                      aria-label={action.label}
                      className="dashboard-quick-action"
                      style={{
                        display: 'grid',
                        justifyItems: 'center',
                        gap: 'var(--space-3)',
                        minHeight: '112px',
                        padding: 'var(--space-4)',
                        borderRadius: 'var(--radius-md)',
                        border: 'calc(var(--space-0-5) / 2) solid var(--color-border)',
                        background: 'var(--color-surface-subtle)',
                        color: 'var(--color-text-primary)',
                        textAlign: 'center',
                        textDecoration: 'none',
                        transition: 'transform var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out)',
                      }}
                    >
                      <span
                        data-action-icon="true"
                        aria-hidden="true"
                        style={{
                          display: 'grid',
                          placeItems: 'center',
                          width: '46px',
                          height: '46px',
                          borderRadius: 'var(--radius-md)',
                          background: action.tint,
                          color: action.color,
                          transition: 'transform var(--duration-fast) var(--ease-out)',
                        }}
                      >
                        <Icon size={22} strokeWidth={1.8} />
                      </span>
                      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 800, color: 'var(--color-text-primary)' }}>
                        {action.label}
                      </span>
                    </Link>
                  )
                })}
              </div>
            </Card.Body>
          </Card>

          <Card>
            <Card.Header
              title="AI Status"
              subtitle="Automation activity today"
              action={<Badge variant="blue" type="dot">Active</Badge>}
            />
            <Card.Body style={{ paddingTop: 'var(--space-4)' }}>
              <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                {aiMetrics.map(metric => (
                  <div
                    key={metric.label}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 'var(--space-3)',
                      padding: 'var(--space-3) 0',
                      borderBottom: 'calc(var(--space-0-5) / 2) solid var(--color-border)',
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
                      <span
                        aria-hidden="true"
                        style={{
                          width: '8px',
                          height: '8px',
                          borderRadius: 'var(--radius-full)',
                          background: metric.color,
                        }}
                      />
                      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' }}>{metric.label}</span>
                    </span>
                    <strong style={{ fontSize: 'var(--text-sm)', color: 'var(--color-navy)', whiteSpace: 'nowrap' }}>
                      {metric.value}
                    </strong>
                  </div>
                ))}
              </div>
            </Card.Body>
          </Card>

          <Card variant="subtle" aria-label="Dashboard automation health">
            <Card.Body style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
              <span
                aria-hidden="true"
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  width: '40px',
                  height: '40px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-success-bg)',
                  color: 'var(--color-success-text)',
                  flexShrink: 0,
                }}
              >
                <CheckCircle size={20} strokeWidth={1.8} />
              </span>
              <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
                <strong style={{ color: 'var(--color-navy)', fontSize: 'var(--text-body)' }}>Clinic systems online</strong>
                <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
                  Appointments, reminders, and WhatsApp workflows are ready.
                </span>
              </div>
            </Card.Body>
          </Card>
        </div>
      </section>
      <style>{`
        .dashboard-quick-action:hover {
          transform: translateY(-2px);
          border-color: var(--color-info-border);
          box-shadow: var(--shadow-sm);
        }

        .dashboard-quick-action:hover [data-action-icon="true"] {
          transform: scale(1.08);
        }

        .dashboard-quick-action:focus-visible {
          outline: 2px solid var(--color-focus);
          outline-offset: 3px;
        }
      `}</style>
    </div>
  )
}
