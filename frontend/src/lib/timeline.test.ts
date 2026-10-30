import { describe, expect, it } from 'vitest'
import type { EphemerisSeries } from './api'
import {
  LUNAR_DAY_S, makeWindow, pointTimeline, RATES, sampleAngleDeg, sampleLinear, segments, stateAt, type TimelineEvent,
} from './timeline'

describe('janela e interpolação', () => {
  it('7 dias a cada 4 h = 43 quadros, do início ao fim', () => {
    const w = makeWindow('2026-11-20T00:00:00Z', 168, 4)
    expect(w.times).toHaveLength(43)
    expect(w.times[1]).toBe('2026-11-20T04:00:00Z')
    expect(w.times.at(-1)).toBe('2026-11-27T00:00:00Z')
    expect(w.durationS).toBe(168 * 3600)
  })

  it('interpola linearmente e prende nos extremos', () => {
    expect(sampleLinear([0, 10, 20], 60, 90)).toBeCloseTo(15)
    expect(sampleLinear([0, 10, 20], 60, -5)).toBe(0)
    expect(sampleLinear([0, 10, 20], 60, 1e6)).toBe(20)
  })

  it('ângulo atravessa 360° pelo arco curto', () => {
    expect(sampleAngleDeg([350, 10], 100, 50)).toBeCloseTo(0)
    expect(sampleAngleDeg([10, 350], 100, 25)).toBeCloseTo(5)
  })

  it('"1 dia lunar por minuto" toca 29,5 dias em 60 s', () => {
    const r = RATES.find((x) => x.id === 'lunar')!
    expect((r.factor * 60) / 86400).toBeCloseTo(29.53, 2)
    expect(LUNAR_DAY_S / 86400).toBeCloseTo(29.53, 2)
  })
})

describe('eventos no pixel', () => {
  const ev: TimelineEvent[] = [{ tS: 1.5 * 3600, kind: 'los', exact: true }, { tS: 3.5 * 3600, kind: 'aos', exact: true }]

  it('estado e faixas alternam a cada evento', () => {
    expect(stateAt(true, ev, 3600)).toBe(true)
    expect(stateAt(true, ev, 2 * 3600)).toBe(false)
    expect(stateAt(true, ev, 4 * 3600)).toBe(true)
    expect(segments(true, ev, 4 * 3600)).toEqual([[0, 1.5 * 3600], [3.5 * 3600, 4 * 3600]])
    expect(segments(false, [], 100)).toEqual([])
  })

  it('a Terra some exatamente no instante do LOS da bisseção', () => {
    const series = {
      start_utc: '2026-11-20T00:00:00Z', step_s: 3600, n: 5,
      center: {} as EphemerisSeries['center'],
      point: {
        sun: { margin_deg: [1, 1, 1, 1, 1], margin_full_deg: [1, 1, 1, 1, 1], events: [] },
        earth: {
          margin_deg: [1, 0.5, -0.5, -1, 1], margin_full_deg: [-1, -1, -1, -1, -1],
          events: [{ event: 'los', seconds: 5040, utc: '', exact: true }, { event: 'aos', seconds: 12_700, utc: '', exact: true }],
        },
      },
    } as unknown as EphemerisSeries
    const tl = pointTimeline(series)!
    expect(tl.earth.events.map((e) => e.kind)).toEqual(['los', 'aos'])
    expect(stateAt(tl.earth.initial, tl.earth.events, 5039)).toBe(true)
    expect(stateAt(tl.earth.initial, tl.earth.events, 5041)).toBe(false) // a margem interpolada diria 1,5 h; vale a bisseção
    expect(tl.earthFull.events).toEqual([]) // degradação/banda larga ficam na própria faixa
    expect(tl.sun.initial).toBe(true)
  })
})
