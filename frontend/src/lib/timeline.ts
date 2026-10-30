// Linha do tempo da animação: janela de quadros, interpolação das efemérides e eventos no pixel.
import type { CountdownEvent, CountdownEventName, EphemerisSeries } from './api'

export const LUNAR_DAY_S = 29.530589 * 86400 // mês sinódico: do nascer ao nascer do Sol no polo

export interface PlaybackRate {
  id: string
  label: string
  factor: number // segundos simulados por segundo real
}

export const RATES: PlaybackRate[] = [
  { id: '1x', label: '1× real', factor: 1 },
  { id: '10x', label: '10×', factor: 10 },
  { id: '1h', label: '1 h/s', factor: 3600 },
  { id: 'lunar', label: '1 dia lunar/min', factor: LUNAR_DAY_S / 60 },
]

export interface TimelineWindow {
  startUtc: string // ISO com Z
  hours: number
  stepH: number
  stepS: number
  durationS: number
  times: string[] // instante de cada quadro do chão
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + 'Z'

export function makeWindow(startUtc: string, hours: number, stepH: number): TimelineWindow {
  const t0 = Date.parse(startUtc)
  const n = Math.floor(hours / stepH + 1e-9) + 1
  const times = Array.from({ length: n }, (_, k) => iso(t0 + k * stepH * 3_600_000))
  return { startUtc: iso(t0), hours, stepH, stepS: stepH * 3600, durationS: (n - 1) * stepH * 3600, times }
}

export const timeAt = (w: TimelineWindow, tS: number) => iso(Date.parse(w.startUtc) + tS * 1000)

/** Valor da série amostrada a cada `stepS` no instante t (linear; fora da série, o extremo). */
export function sampleLinear(values: number[], stepS: number, tS: number): number {
  const pos = Math.max(0, Math.min(values.length - 1, tS / stepS))
  const i = Math.min(values.length - 2, Math.floor(pos))
  if (i < 0) return values[0]
  const w = pos - i
  return values[i] * (1 - w) + values[i + 1] * w
}

/** Como `sampleLinear`, para ângulos em graus: interpola pelo arco mais curto (359° → 1° passa por 0°). */
export function sampleAngleDeg(values: number[], stepS: number, tS: number): number {
  const pos = Math.max(0, Math.min(values.length - 1, tS / stepS))
  const i = Math.min(values.length - 2, Math.floor(pos))
  if (i < 0) return values[0]
  const d = ((values[i + 1] - values[i] + 540) % 360) - 180
  return (values[i] + d * (pos - i) + 360) % 360
}

export interface TimelineEvent {
  tS: number // segundos desde o início da janela
  kind: CountdownEventName
  exact: boolean // confirmado pelo ray-casting exato; senão, estimativa do perfil de horizonte
}

/** Estado no instante t: o inicial, invertido a cada troca já ocorrida. */
export function stateAt(initial: boolean, events: TimelineEvent[], tS: number): boolean {
  let s = initial
  for (const e of events) {
    if (e.tS > tS) break
    s = !s
  }
  return s
}

/** Intervalos [início, fim] (s) em que o estado é verdadeiro — as faixas sob o scrubber. */
export function segments(initial: boolean, events: TimelineEvent[], durationS: number): [number, number][] {
  const out: [number, number][] = []
  let on = initial, from = 0
  for (const e of events) {
    if (e.tS > durationS) break
    if (on) out.push([from, e.tS])
    on = !on
    from = e.tS
  }
  if (on) out.push([from, durationS])
  return out
}

export interface Track {
  initial: boolean
  events: TimelineEvent[]
}

export interface PointTimeline {
  sun: Track // alguma parte do Sol visível (energia)
  earth: Track // alguma parte da Terra visível (LOS/AOS)
  earthFull: Track // disco inteiro da Terra (banda larga)
}

/**
 * Estados no pixel: estado inicial pela margem da série e as trocas pelos eventos da janela, que o
 * servidor refina com a mesma bisseção (ray-casting exato) do countdown. A Terra some exatamente
 * na linha vermelha do LOS porque as duas coisas são o mesmo número.
 */
export function pointTimeline(series: EphemerisSeries): PointTimeline | null {
  const p = series.point
  if (!p) return null
  const track = (m: number[], events: CountdownEvent[], kinds: CountdownEventName[]): Track => ({
    initial: m[0] > 0,
    events: events.filter((e) => kinds.includes(e.event)).map((e) => ({ tS: e.seconds, kind: e.event, exact: e.exact })),
  })
  return {
    sun: track(p.sun.margin_deg, p.sun.events, ['sunrise', 'sunset']),
    earth: track(p.earth.margin_deg, p.earth.events, ['aos', 'los']),
    earthFull: track(p.earth.margin_full_deg, p.earth.events, ['full_signal', 'degradation']),
  }
}
