import { Crosshair } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Countdown, PointIllumination } from '../lib/api'
import { CountdownPanel } from './CountdownPanel'
import { fmt, signed } from '../lib/geo'
import { TelemetryLines } from './Telemetry'
import { Card, KeyValue } from './ui'

export function PointCard({ point, loading, error, countdown, countdownLoading, simulatedUtc }: {
  point: PointIllumination | null
  loading: boolean
  error: string | null
  countdown: Countdown | null
  countdownLoading: boolean
  simulatedUtc: string
}) {
  return (
    <Card title="Ponto selecionado" icon={<Crosshair className="size-4" />}>
      {error && <p className="text-sm text-rose-300">{error}</p>}
      {loading && !point && <p className="text-sm text-slate-500">Traçando os raios até o Sol e a Terra…</p>}
      {point && (
        <PointBody point={point}>
          <CountdownPanel data={countdown} loading={countdownLoading} simulatedUtc={simulatedUtc} />
        </PointBody>
      )}
    </Card>
  )
}

function PointBody({ point: p, children }: { point: PointIllumination; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <TelemetryLines p={p} compact />
      {children}
      <KeyValue rows={[
        ['Lat / lon', `${fmt(p.lat, 4)}° / ${fmt(p.lon, 2)}°`],
        ['Altitude', `${fmt(p.height_m, 0)} m`],
        ['Sol: azimute · horizonte', `${fmt(p.sun.azimuth_deg, 1)}° · ${signed(p.sun.horizon_deg)}`],
        ['Terra: azimute · horizonte', `${fmt(p.earth.azimuth_deg, 1)}° · ${signed(p.earth.horizon_deg)}`],
        ['Disco da Terra', `${fmt(2 * p.earth.angular_radius_deg, 2)}° de diâmetro`],
        ['Atraso de sinal (Terra)', `${fmt(p.earth.light_time_s, 3)} s`],
      ]} />
      {p.annual && (
        <div className="rounded-lg border border-space-700 bg-space-950/50 p-2.5 text-xs leading-relaxed text-slate-300">
          <b className="text-slate-100">Em {p.annual.year}:</b> Sol {fmt(p.annual.illumination_pct, 1)}% · Terra{' '}
          {fmt(p.annual.any_earth_pct, 1)}% · Zona de Ouro {fmt(p.annual.golden_pct, 1)}%<br />
          Maior janela de ouro <b className="text-emerald-300">{fmt(p.annual.longest_golden_h / 24, 1)} d</b> · maior
          noite {fmt(p.annual.longest_night_h / 24, 1)} d · maior LOS {fmt(p.annual.longest_los_h / 24, 1)} d
          {p.annual.psr && <b className="text-ice-400"> · sombra permanente</b>}
        </div>
      )}
      <p className="tabular text-[11px] text-slate-600">2 ray-castings exatos (Sol + Terra) em {fmt(p.elapsed_ms, 0)} ms</p>
    </div>
  )
}
