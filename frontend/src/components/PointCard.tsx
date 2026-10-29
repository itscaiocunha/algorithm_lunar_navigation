import { Crosshair, Moon, Sun, SunDim } from 'lucide-react'
import type { PointIllumination } from '../lib/api'
import { fmt } from '../lib/geo'
import { cx } from '../lib/view'
import { Card, KeyValue } from './ui'

const STATUS = {
  iluminado: { label: 'Iluminado', icon: Sun, color: 'text-sun-300' },
  penumbra: { label: 'Penumbra', icon: SunDim, color: 'text-sun-500' },
  sombra: { label: 'Em sombra', icon: Moon, color: 'text-slate-400' },
} as const

export function PointCard({ point, loading, error }: { point: PointIllumination | null; loading: boolean; error: string | null }) {
  return (
    <Card title="Ponto selecionado" icon={<Crosshair className="size-4" />}>
      {error && <p className="text-sm text-rose-300">{error}</p>}
      {loading && !point && <p className="text-sm text-slate-500">Traçando o raio até o Sol…</p>}
      {point && <PointBody point={point} />}
    </Card>
  )
}

function PointBody({ point: p }: { point: PointIllumination }) {
  const s = STATUS[p.status]
  const margin = p.sun_elevation_deg - p.horizon_deg
  return (
    <div className="space-y-3">
      <div className={cx('flex items-center gap-2 text-base font-semibold', s.color)}>
        <s.icon className="size-5" />
        {s.label}
        <span className="tabular ml-auto text-sm font-medium text-slate-400">{fmt(p.fraction * 100, 0)}% do disco</span>
      </div>
      <KeyValue rows={[
        ['Lat / lon', `${fmt(p.lat, 4)}° / ${fmt(p.lon, 2)}°`],
        ['Altitude', `${fmt(p.height_m, 0)} m`],
        ['Elevação do Sol', `${fmt(p.sun_elevation_deg, 3)}°`],
        ['Azimute do Sol', `${fmt(p.sun_azimuth_deg, 1)}°`],
        ['Horizonte nessa direção', `${fmt(p.horizon_deg, 3)}°`],
        ['Sol − horizonte', `${margin >= 0 ? '+' : ''}${fmt(margin, 3)}°`],
      ]} />
      <p className="text-xs leading-relaxed text-slate-400">
        {margin > 0.27 ? 'O disco solar inteiro passa acima do relevo nessa direção.'
          : margin < -0.27 ? 'O relevo na direção do Sol está mais alto que o disco solar inteiro.'
          : 'O horizonte corta o disco solar: só parte do Sol é visível.'}
      </p>
      {p.annual && (
        <div className="rounded-lg border border-space-700 bg-space-950/50 p-2.5 text-xs text-slate-300">
          <b className="text-slate-100">Em {p.annual.year}:</b> {fmt(p.annual.illumination_pct, 1)}% do tempo com Sol ·
          maior noite de {fmt(p.annual.longest_night_h / 24, 1)} dias
          {p.annual.psr && <b className="text-ice-400"> · sombra permanente</b>}
        </div>
      )}
      <p className="tabular text-[11px] text-slate-600">Ray-casting de 1 pixel em {fmt(p.elapsed_ms, 0)} ms</p>
    </div>
  )
}
