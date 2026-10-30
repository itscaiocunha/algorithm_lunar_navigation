import { describe, expect, it } from 'vitest'
import { composeFrame, INFERNO16 } from './frameCompose'
import { COLORS } from './layers'

// 4 pixels: sombra total · só Sol (disco inteiro) · só Terra (disco inteiro) · Sol + Terra
const frame = { utc: 'x', rows: 1, cols: 4, bytes: new Uint8Array([0x00, 0xf0, 0x0f, 0xff]) }
const all = { sun: true, earth: true, golden: true }
const px = (rgba: Uint8ClampedArray, width: number, x: number, y = 0) => [...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 4)]

describe('composeFrame', () => {
  it('estatísticas da área', () => {
    expect(composeFrame(frame, all, undefined, 1).stats).toEqual({ lit_pct: 50, earth_pct: 50, golden_pct: 25 })
  })

  it('Sol em inferno a 80%, Zona de Ouro verde por cima', () => {
    const { rgba, width } = composeFrame(frame, all, undefined, 1)
    expect(px(rgba, width, 0)).toEqual([...INFERNO16[0], 204]) // sombra: preto do inferno
    expect(px(rgba, width, 1)).toEqual([...INFERNO16[15], 204])
    const g = px(rgba, width, 3)
    expect(g[3]).toBe(247) // 0,8 + 0,85·0,2 = 0,97
    expect(g[1]).toBeGreaterThan(200) // dominado pelo verde
  })

  it('hachura ciano só nas listras, e só onde não é Zona de Ouro', () => {
    const { rgba, width } = composeFrame(frame, { sun: false, earth: true, golden: true }, undefined, 2)
    // pixel 2 do DEM ocupa x = 4..5, y = 0..1; listra quando (x + y) % 8 < 2 — aqui nunca
    for (const [x, y] of [[4, 0], [5, 0], [4, 1], [5, 1]]) expect(px(rgba, width, x, y)).toEqual([0, 0, 0, 0])
    expect(px(rgba, width, 6, 0)[1]).toBe(COLORS.golden[1]) // pixel 3: Zona de Ouro, sem hachura
    const f2 = { ...frame, bytes: new Uint8Array([0x0f, 0x0f, 0x0f, 0x0f]) }
    const c = composeFrame(f2, { sun: false, earth: true, golden: true }, undefined, 2)
    expect(px(c.rgba, c.width, 0, 0)).toEqual([...COLORS.comms, 255])
  })

  it('reaproveita o buffer de saída (sem alocar por quadro)', () => {
    const first = composeFrame(frame, all)
    const second = composeFrame({ ...frame, bytes: new Uint8Array([0xff, 0xff, 0xff, 0xff]) }, all, first.rgba)
    expect(second.rgba).toBe(first.rgba)
    expect(second.stats.golden_pct).toBe(100)
  })
})
