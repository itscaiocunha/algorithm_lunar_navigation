import { Antenna, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import type { BodyAtPoint, PointIllumination } from '../lib/api'
import { fmt, signed } from '../lib/geo'
import { cx } from '../lib/view'

const SUN_TONE: Record<string, string> = { nominal: 'text-sun-300', parcial: 'text-sun-500', sem_energia: 'text-slate-500' }
const EARTH_TONE: Record<string, string> = {
  banda_larga: 'text-ice-400', degradado: 'text-sky-300', emergencia: 'text-amber-300', los: 'text-slate-500',
}

function BodyLine({ icon, name, body, tone }: { icon: ReactNode; name: string; body: BodyAtPoint; tone: string }) {
  return (
    <div className="grid grid-cols-[16px_96px_56px_74px_1fr] items-baseline gap-x-2">
      <span className={cx('translate-y-0.5', tone)}>{icon}</span>
      <span className="text-slate-400">{name}</span>
      <span className="tabular text-right font-semibold text-slate-100">{signed(body.elevation_deg)}</span>
      <span className="tabular whitespace-nowrap text-slate-400">fração {fmt(body.fraction * 100, 0)}%</span>
      <span className={cx('text-right whitespace-nowrap', tone)}>{body.label}</span>
    </div>
  )
}

/** Telemetria separada de Sol e Terra (usada no tooltip e na ficha do ponto). */
export function TelemetryLines({ p }: { p: PointIllumination }) {
  return (
    <div className="space-y-1 text-[12px]">
      <BodyLine icon={<Sun className="size-3.5" />} name="Elevação solar" body={p.sun} tone={SUN_TONE[p.sun.level]} />
      <BodyLine icon={<Antenna className="size-3.5" />} name="Elevação Terra" body={p.earth} tone={EARTH_TONE[p.earth.level]} />
      <div className="flex items-baseline gap-2 border-t border-space-700 pt-1.5">
        <span className="text-slate-400">Status</span>
        <span className={cx('font-semibold', p.golden ? 'text-emerald-300' : 'text-slate-200')}>{p.status}</span>
        {p.golden && <span className="ml-auto rounded bg-emerald-400/15 px-1.5 text-[10.5px] font-semibold text-emerald-300">ZONA DE OURO</span>}
      </div>
    </div>
  )
}

export function EngineeringTooltip({ point, loading, x, y }: { point: PointIllumination | null; loading: boolean; x: number; y: number }) {
  return (
    <div className="pointer-events-none absolute z-10 w-[480px] rounded-lg border border-space-600 bg-space-950/92 px-3 py-2.5 shadow-2xl backdrop-blur"
         style={{ left: x + 18, top: y + 18, transform: `translate(${x > 600 ? '-110%' : '0'}, ${y > 420 ? '-115%' : '0'})` }}>
      {point ? (
        <>
          <div className="tabular mb-1.5 flex justify-between text-[10.5px] text-slate-500">
            <span>{fmt(point.lat, 4)}° · {fmt(point.lon, 2)}° · {fmt(point.height_m, 0)} m</span>
            <span>atraso de sinal {fmt(point.earth.light_time_s, 3)} s</span>
          </div>
          <TelemetryLines p={point} />
          {loading && <div className="mt-1 text-[10px] text-slate-600">atualizando…</div>}
        </>
      ) : (
        <div className="text-xs text-slate-500">Traçando raios até o Sol e a Terra…</div>
      )}
    </div>
  )
}
