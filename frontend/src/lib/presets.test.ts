import { describe, expect, it } from 'vitest'
import { latLonToMap } from './geo'
import { CUSTOM_ID, findPreset, LANDING_PRESETS } from './presets'

const SHACKLETON_CENTER = latLonToMap(-89.67, 129.78) // centro da cratera (~21 km de diâmetro)

describe('catálogo de missões', () => {
  it('ids únicos, coordenadas dentro do DEM (80°S–90°S) e origem declarada', () => {
    expect(new Set(LANDING_PRESETS.map((p) => p.id)).size).toBe(LANDING_PRESETS.length)
    for (const p of LANDING_PRESETS.filter((p) => p.id !== CUSTOM_ID)) {
      expect(p.lat!).toBeLessThanOrEqual(-80.5)
      expect(p.source.length).toBeGreaterThan(0)
    }
  })

  it('Connecting Ridge usa longitude oeste (a leste cairia dentro da Shackleton)', () => {
    const p = findPreset('connecting-ridge')
    const { x, y } = latLonToMap(p.lat!, p.lon!)
    expect(x).toBeLessThan(0)
    expect(Math.hypot(x, y) / 1000).toBeCloseTo(16.6, 0)
  })

  it('Peak Near Shackleton otimizado fica sobre a borda da Shackleton, não no fundo', () => {
    const p = findPreset('peak-near-shackleton')
    const { x, y } = latLonToMap(p.lat!, p.lon!)
    const fromCenterKm = Math.hypot(x - SHACKLETON_CENTER.x, y - SHACKLETON_CENTER.y) / 1000
    expect(fromCenterKm).toBeGreaterThan(9.5) // raio da cratera ≈ 10,5 km
    expect(fromCenterKm).toBeLessThan(11.5)
  })

  it('nenhum alvo do catálogo usa as coordenadas contestadas anteriores', () => {
    const coords = LANDING_PRESETS.map((p) => `${p.lat},${p.lon}`)
    expect(coords).not.toContain('-89.78,129.54') // fundo da Shackleton
    expect(coords).not.toContain('-85.28,53.27') // centro da Nobile
    expect(coords).not.toContain('-87.3,77') // interior da Faustini
  })

  it('id desconhecido cai na coordenada personalizada', () => {
    expect(findPreset('nao-existe').id).toBe(CUSTOM_ID)
  })
})
