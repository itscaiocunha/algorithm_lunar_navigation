import { describe, expect, it } from 'vitest'
import { curvedPoint, injectCurvature, localUp } from './curvature'
import { injectOverlay } from './overlay'

const fakeShader = () => ({
  vertexShader: '#include <common>\nvoid main() {\n#include <beginnormal_vertex>\n#include <begin_vertex>\n}',
  fragmentShader: '#include <common>\nvoid main() {\n#include <map_fragment>\n}',
  uniforms: {} as Record<string, { value: unknown }>,
})

describe('camada animada no shader', () => {
  it('injeta varying, uniforms e a mistura depois do map_fragment, junto com a curvatura', () => {
    const s = fakeShader()
    injectCurvature(s, { uMoonR: { value: 1737.4 }, uExaggeration: { value: 3 }, uCurvature: { value: 1 } })
    const u = { uOverlay: { value: null }, uOverlayBox: { value: [-30, 30, 60, 60] as [number, number, number, number] }, uOverlayOn: { value: 1 } }
    injectOverlay(s, u)
    expect(s.vertexShader).toContain('vLunarMap = vec2(position.x, -position.z);')
    expect(s.vertexShader).toContain('transformed = lunarPosition(transformed);')
    expect(s.fragmentShader.indexOf('#include <map_fragment>')).toBeLessThan(s.fragmentShader.indexOf('texture2D(uOverlay'))
    expect(s.uniforms.uOverlayBox).toBe(u.uOverlayBox) // mesmo objeto: um quadro novo vale para todos os tiles
    expect(s.uniforms.uExaggeration.value).toBe(3)
  })
})

describe('vertical local', () => {
  it('no polo é +Y; a 120 km inclina ~4° para fora do polo', () => {
    const near = (v: number[], w: number[]) => v.forEach((c, i) => expect(c).toBeCloseTo(w[i], 9))
    near(localUp(0, 0), [0, 1, 0])
    const up = localUp(120, 0)
    expect((Math.acos(up[1]) * 180) / Math.PI).toBeCloseTo(3.96, 1)
    expect(up[0]).toBeGreaterThan(0)
    near(localUp(120, 0, 0), [0, 1, 0]) // sem curvatura
  })

  it('é perpendicular à superfície curvada (diferenças finitas)', () => {
    const [x, y, d] = [80, -60, 0.01]
    const p = curvedPoint(x, y, 0, 1)
    const px = curvedPoint(x + d, y, 0, 1), py = curvedPoint(x, y + d, 0, 1)
    const up = localUp(x, y)
    const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0)
    expect(dot(up, px.map((v, i) => v - p[i])) / d).toBeCloseTo(0, 4)
    expect(dot(up, py.map((v, i) => v - p[i])) / d).toBeCloseTo(0, 4)
  })
})
