import { describe, expect, it } from 'vitest'
import { addHours, latLonToMap, mapToLatLon, tMinus, toUtcIso } from './geo'

describe('projeção polar estereográfica', () => {
  it('polo sul fica na origem', () => {
    const { x, y } = latLonToMap(-90, 0)
    expect(Math.abs(x)).toBeLessThan(1e-6)
    expect(Math.abs(y)).toBeLessThan(1e-6)
  })

  it('ida e volta mapa -> lat/lon -> mapa', () => {
    for (const [x, y] of [[12_000, -40_000], [-150_000, 90_000], [3_000, 250_000]]) {
      const { lat, lon } = mapToLatLon(x, y)
      const back = latLonToMap(lat, lon)
      expect(back.x).toBeCloseTo(x, 4)
      expect(back.y).toBeCloseTo(y, 4)
    }
  })

  it('bate com o PROJ', () => {
    // Referência: rasterio.warp.transform(longlat -> stere) para (lon 90°, lat -80°)
    const { x, y } = latLonToMap(-80, 90)
    expect(x).toBeCloseTo(304_005.608, 2)
    expect(Math.abs(y)).toBeLessThan(1e-6)
  })
})

describe('datas UTC', () => {
  it('completa segundos e marca UTC', () => {
    expect(toUtcIso('2026-11-20T00:00')).toBe('2026-11-20T00:00:00Z')
  })
  it('soma horas atravessando o dia', () => {
    expect(addHours('2026-11-20T18:00:00', 12)).toBe('2026-11-21T06:00:00')
  })
})

describe('contagem regressiva', () => {
  it('formata em horas totais e minutos', () => {
    expect(tMinus(72 * 3600 + 15 * 60)).toBe('T− 72h 15m')
    expect(tMinus(9 * 3600 + 30 * 60 + 29)).toBe('T− 09h 30m')
    expect(tMinus(-5)).toBe('T− 00h 00m')
  })
})
