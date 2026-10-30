import { Clapperboard, Crosshair, LoaderCircle, Pause, Play, Square } from 'lucide-react'
import { useRef, type PointerEvent } from 'react'
import type { Animation } from '../hooks/useAnimation'
import type { CountdownEventName } from '../lib/api'
import { fmt } from '../lib/geo'
import { LUNAR_DAY_S, RATES, segments, stateAt, timeAt, type TimelineEvent, type Track } from '../lib/timeline'
import { cx } from '../lib/view'
import { Card, Segmented } from './ui'

const WINDOWS = [
  { value: '168', label: '7 dias' },
  { value: String(LUNAR_DAY_S / 3600), label: 'Dia lunar' },
]
const STEPS = [{ value: '1', label: '1 h' }, { value: '2', label: '2 h' }, { value: '4', label: '4 h' }]

const MARKER: Record<CountdownEventName, { label: string; color: string; critical?: boolean }> = {
  los: { label: 'LOS', color: 'bg-rose-500', critical: true },
  aos: { label: 'AOS', color: 'bg-emerald-400' },
  sunset: { label: 'Pôr do Sol', color: 'bg-amber-400' },
  sunrise: { label: 'Nascer do Sol', color: 'bg-sun-300' },
  degradation: { label: 'Degradação de RF', color: 'bg-orange-400' },
  full_signal: { label: 'Banda larga', color: 'bg-sky-300' },
}

const short = (utc: string) => utc.slice(8, 10) + '/' + utc.slice(5, 7) + ' ' + utc.slice(11, 16)
function elapsed(s: number) {
  const h = Math.floor(s / 3600)
  return `T+${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`
}

/** Linha do tempo da simulação: transporte, velocidade, scrubber com buffer, eventos e faixas do pixel. */
export function TimelinePlayer({ anim, disabled, hasPoint, onAnalyze }: {
  anim: Animation
  disabled?: string | null // motivo, se a animação não puder rodar (ex.: sem cache de horizontes)
  hasPoint: boolean
  onAnalyze: (utc: string) => void
}) {
  const { win, playback: pb, buffer, timeline, overlay, config } = anim
  const bar = useRef<HTMLDivElement>(null)
  const dur = win?.durationS ?? 1
  const pct = (t: number) => `${(100 * Math.max(0, Math.min(dur, t))) / dur}%`

  const seekAt = (e: PointerEvent<HTMLDivElement>) => {
    const r = bar.current!.getBoundingClientRect()
    pb.seek(((e.clientX - r.left) / r.width) * dur)
  }

  // quadros em memória, agrupados em trechos contínuos (a barra "carregado" do YouTube)
  const loaded = buffer?.loaded() ?? []
  const runs: [number, number][] = []
  for (const i of loaded) {
    const lastRun = runs.at(-1)
    if (lastRun && lastRun[1] === i - 1) lastRun[1] = i
    else runs.push([i, i])
  }
  const step = win?.stepS ?? 1
  const events: TimelineEvent[] = timeline
    ? [...timeline.sun.events, ...timeline.earth.events, ...timeline.earthFull.events].filter((e) => e.tS >= 0 && e.tS <= dur)
    : []
  const at = (track: Track) => stateAt(track.initial, track.events, pb.tS)
  const days = Math.floor(dur / 86400)

  return (
    <Card title="Animação" icon={<Clapperboard className="size-4" />}>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs text-slate-400">
        <span>Janela</span>
        <Segmented value={String(config.hours)} onChange={(v) => anim.setConfig({ ...config, hours: +v })} options={WINDOWS} />
        <span>Passo do chão</span>
        <Segmented value={String(config.stepH)} onChange={(v) => anim.setConfig({ ...config, stepH: +v })} options={STEPS} />
      </div>
      {win && (win.hours !== config.hours || win.stepH !== config.stepH) && (
        <p className="mt-1 text-[11px] text-slate-500">A nova janela vale no próximo Play depois do Stop.</p>
      )}

      <div className="mt-3 flex items-center gap-2">
        {pb.playing ? (
          <button onClick={pb.pause} aria-label="Pausar" className="flex size-9 items-center justify-center rounded-full bg-sun-400 text-space-950 hover:brightness-110">
            <Pause className="size-4 fill-current" />
          </button>
        ) : (
          <button onClick={win ? pb.play : anim.start} disabled={!!disabled} aria-label="Reproduzir" title={disabled ?? undefined}
                  className="flex size-9 items-center justify-center rounded-full bg-sun-400 text-space-950 hover:brightness-110 disabled:opacity-40">
            <Play className="size-4 fill-current" />
          </button>
        )}
        <button onClick={anim.stop} disabled={!win} aria-label="Parar"
                className="flex size-8 items-center justify-center rounded-full border border-space-600 text-slate-300 hover:border-sun-400 disabled:opacity-30">
          <Square className="size-3.5 fill-current" />
        </button>
        <div className="tabular ml-1 leading-tight">
          <div className="text-[13px] text-slate-100">{win ? short(timeAt(win, pb.tS)) : '—'} <span className="text-slate-500">UTC</span></div>
          <div className="text-[11px] text-slate-500">{win ? elapsed(pb.tS) : 'parado'}</div>
        </div>
        {pb.buffering && (
          <span className="ml-auto flex items-center gap-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] text-amber-300">
            <LoaderCircle className="size-3 animate-spin" /> buffering
          </span>
        )}
      </div>

      <div className="mt-2">
        <Segmented value={pb.rateId} onChange={pb.setRateId} options={RATES.map((r) => ({ value: r.id, label: r.label }))} />
      </div>

      {win && (
        <div className="mt-4 select-none">
          {/* marcadores de evento acima da barra */}
          <div className="relative h-4">
            {events.map((e, k) => (
              <span key={k} className={cx('absolute top-0 -translate-x-1/2 text-[9.5px] font-semibold whitespace-nowrap',
                MARKER[e.kind].critical ? 'text-rose-400' : 'text-slate-500')} style={{ left: pct(e.tS) }}>
                {MARKER[e.kind].critical || e.kind === 'sunset' ? MARKER[e.kind].label : ''}
              </span>
            ))}
          </div>
          <div ref={bar} className="relative h-7 cursor-pointer touch-none"
               onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seekAt(e) }}
               onPointerMove={(e) => { if (e.buttons === 1) seekAt(e) }}>
            <div className="absolute inset-x-0 top-2.5 h-2 rounded-full bg-space-800" />
            {runs.map(([a, b]) => (
              <div key={a} className="absolute top-2.5 h-2 rounded-full bg-slate-600"
                   style={{ left: pct(a * step), width: `calc(${pct((b - a + 1) * step)} - 0px)` }} />
            ))}
            <div className="absolute top-2.5 h-2 rounded-full bg-sun-400/70" style={{ width: pct(pb.tS) }} />
            {events.map((e, k) => (
              <div key={k} title={`${MARKER[e.kind].label} · ${short(timeAt(win, e.tS))} UTC${e.exact ? ' · bisseção (exato)' : ' · perfil de horizonte'}`}
                   className={cx('absolute top-0 h-7 -translate-x-1/2', MARKER[e.kind].color, MARKER[e.kind].critical ? 'w-[3px]' : 'w-px',
                     !e.exact && 'opacity-50')}
                   style={{ left: pct(e.tS) }} />
            ))}
            <div className="absolute top-1 size-5 -translate-x-1/2 rounded-full border-2 border-space-950 bg-sun-300 shadow"
                 style={{ left: pct(pb.tS) }} />
          </div>
          {/* faixas de estado no pixel selecionado */}
          {timeline ? (
            <div className="mt-1 space-y-[3px]">
              <Band label="Sol visível no ponto" track={timeline.sun} dur={dur} color="bg-sun-400/80" />
              <Band label="Terra visível no ponto" track={timeline.earth} dur={dur} color="bg-ice-400/80" />
              <div className="flex gap-3 pt-0.5 text-[10px] text-slate-500">
                <span><i className="mr-1 inline-block h-1 w-3 rounded bg-sun-400/80 align-middle" />Sol no ponto</span>
                <span><i className="mr-1 inline-block h-1 w-3 rounded bg-ice-400/80 align-middle" />Terra no ponto</span>
                <span><i className="mr-1 inline-block h-2.5 w-[3px] bg-rose-500 align-middle" />LOS</span>
              </div>
            </div>
          ) : (
            <p className="mt-1 text-[11px] text-slate-500">
              {hasPoint ? 'Calculando a trajetória no ponto…' : 'Selecione um ponto no mapa para marcar LOS, AOS e pôr do Sol na linha do tempo.'}
            </p>
          )}
          <div className="tabular mt-1 flex justify-between text-[10px] text-slate-600">
            {Array.from({ length: Math.min(days, 7) + 1 }, (_, k) => Math.round((k * days) / Math.min(days, 7))).map((d) => (
              <span key={d}>{d}d</span>
            ))}
          </div>

          <div className="tabular mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] text-slate-400">
            <span>Quadros no buffer</span>
            <span className="text-right">{loaded.length} / {win.times.length}{buffer?.pending ? ` · ${buffer.pending} baixando` : ''}</span>
            {overlay && (
              <>
                <span>Área com Sol · Terra</span>
                <span className="text-right"><span className="text-sun-300">{fmt(overlay.stats.lit_pct, 1)}%</span> · <span className="text-ice-400">{fmt(overlay.stats.earth_pct, 1)}%</span></span>
                <span>Zona de Ouro na área</span><span className="text-right text-emerald-300">{fmt(overlay.stats.golden_pct, 1)}%</span>
              </>
            )}
            {timeline && (
              <>
                <span>No ponto</span>
                <span className="text-right">
                  <span className={at(timeline.sun) ? 'text-sun-300' : 'text-slate-500'}>{at(timeline.sun) ? 'Sol' : 'noite'}</span>
                  {' · '}
                  <span className={at(timeline.earth) ? 'text-ice-400' : 'font-semibold text-rose-400'}>
                    {at(timeline.earth) ? (at(timeline.earthFull) ? 'Terra' : 'Terra parcial') : 'LOS'}
                  </span>
                </span>
              </>
            )}
          </div>
          {!pb.playing && (
            <button onClick={() => onAnalyze(timeAt(win, pb.tS))}
                    className="mt-3 flex items-center gap-1.5 text-xs text-sun-300 hover:underline">
              <Crosshair className="size-3.5" /> Analisar este instante (ray-casting completo)
            </button>
          )}
        </div>
      )}
      {(anim.error || disabled) && <p className="mt-2 text-[12px] text-rose-300">{anim.error ?? disabled}</p>}
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        O chão muda em blocos (um mapa de horizontes a cada passo, área de ±30 km); Sol e Terra andam contínuos, interpolados de
        uma série de efemérides a cada 30 min. Os quadros são baixados à frente da reprodução; se a rede atrasar, a animação espera.
      </p>
    </Card>
  )
}

function Band({ label, track, dur, color }: { label: string; track: Track; dur: number; color: string }) {
  return (
    <div title={label}>
      <div className="relative h-[5px] rounded-full bg-space-800">
        {segments(track.initial, track.events, dur).map(([a, b]) => (
          <div key={a} className={cx('absolute h-full rounded-full', color)} style={{ left: `${(100 * a) / dur}%`, width: `${(100 * (b - a)) / dur}%` }} />
        ))}
      </div>
    </div>
  )
}
