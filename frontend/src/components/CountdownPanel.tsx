import { AlertTriangle, Antenna, Sparkles, Sun, Timer } from 'lucide-react'
import type { ReactNode } from 'react'
import type { BodyCountdown, Countdown, CountdownEventName } from '../lib/api'
import { fmt, tMinus } from '../lib/geo'
import { cx } from '../lib/view'

const ALERT_S = 24 * 3600 // abaixo de 24 h a janela está colapsando

const EVENT_LABEL: Record<CountdownEventName, string> = {
  sunset: 'para Sunset',
  sunrise: 'para Sunrise',
  los: 'para Loss of Signal (LOS)',
  aos: 'para Acquisition of Signal (AOS)',
  degradation: 'para degradação de RF',
  full_signal: 'para banda larga',
}

const utcShort = (utc: string) => utc.replace('T', ' ').replace(/:\d\dZ$/, ' UTC')

function BodyRow({ icon, name, body, tone }: { icon: ReactNode; name: string; body: BodyCountdown; tone: string }) {
  const s = body.seconds
  const alert = s !== null && s < ALERT_S && (body.event === 'sunset' || body.event === 'los' || body.event === 'degradation')
  const secondary = body.events.filter((e) => e.event !== body.event)
  return (
    <div className={cx('rounded-lg border px-3 py-2.5', alert ? 'border-amber-400/60 bg-amber-400/[0.08]' : 'border-space-700 bg-space-950/50')}>
      <div className="flex items-center gap-2 text-[11px] tracking-wide text-slate-500 uppercase">
        <span className={tone}>{icon}</span> {name}
        {alert && <span className="ml-auto flex items-center gap-1 font-semibold text-amber-300 normal-case"><AlertTriangle className="size-3.5" /> &lt; 24 h</span>}
      </div>
      {s !== null && body.event ? (
        <>
          <div className="mt-1 flex items-baseline gap-2">
            <span className={cx('tabular font-mono text-[22px] leading-none font-bold tracking-tight', alert ? 'text-amber-300' : tone)}>
              {tMinus(s)}
            </span>
            <span className="text-[12.5px] text-slate-300">{EVENT_LABEL[body.event]}</span>
          </div>
          <div className="tabular mt-1 text-[11px] text-slate-500">
            {body.utc && utcShort(body.utc)} · ±{body.uncertainty_min} min (modelo de 80 m)
          </div>
          {secondary.map((e) => (
            <div key={e.event + e.seconds} className="tabular mt-0.5 text-[11px] text-slate-400">
              {tMinus(e.seconds)} {EVENT_LABEL[e.event]}
            </div>
          ))}
        </>
      ) : (
        <div className="mt-1 text-[12.5px] text-slate-300">
          {body.state === 'hidden' ? 'Permanece oculto' : 'Permanece visível'} pelos próximos {fmt(body.searched_days, 0)} dias
        </div>
      )}
    </div>
  )
}

export function CountdownPanel({ data, loading, simulatedUtc }: { data: Countdown | null; loading: boolean; simulatedUtc: string }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-slate-100">
        <Timer className="size-4 text-sun-400" /> Contagem regressiva
        {loading && <span className="ml-auto text-[11px] font-normal text-slate-500">varredura + bisseção…</span>}
      </div>
      {data && (
        <>
          <BodyRow icon={<Sun className="size-3.5" />} name="Sol · energia" body={data.sun} tone="text-sun-300" />
          <BodyRow icon={<Antenna className="size-3.5" />} name="Terra · rádio" body={data.earth} tone="text-ice-400" />
          {data.golden && data.golden_ends_seconds != null && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-400/40 bg-emerald-400/[0.07] px-3 py-2 text-[12.5px] text-emerald-200">
              <Sparkles className="size-4 text-emerald-300" />
              Zona de Ouro termina em <b className="tabular font-mono text-emerald-300">{tMinus(data.golden_ends_seconds)}</b>
            </div>
          )}
          <p className="text-[10.5px] leading-relaxed text-slate-600">
            Contado a partir do instante simulado ({simulatedUtc.replace('T', ' ')} UTC). Varredura de 1 h com o perfil de horizonte
            do pixel, raiz refinada pelo ray-casting exato · {fmt(data.elapsed_ms, 0)} ms
          </p>
        </>
      )}
    </div>
  )
}
