import { describe, expect, it } from 'vitest'
import { CURVATURE_GLSL, curvatureDropKm, curvedPoint, injectCurvature, MOON_RADIUS_KM as R } from './curvature'

// Referência independente: trigonometria esférica direta (não a fórmula vetorial do módulo).
// Na estereográfica polar, ρ = 2R·tan(θ/2), onde θ é o ângulo ao centro da Lua.
const sphere = (rho: number, h = 0) => {
  const theta = 2 * Math.atan(rho / (2 * R))
  return { horizontal: (R + h) * Math.sin(theta), up: (R + h) * Math.cos(theta) - R }
}

describe('curvatura lunar', () => {
  it('no polo nada muda', () => {
    curvedPoint(0, 0, 1.5, 3).forEach((v, i) => expect(v).toBeCloseTo([0, 4.5, 0][i], 9))
  })

  it('a 300 km do polo a superfície cai 25,7 km (não 26,1 km da fórmula plana)', () => {
    const [x, y, z] = curvedPoint(300, 0, 0, 1)
    const ref = sphere(300)
    expect(y).toBeCloseTo(ref.up, 6)
    expect(y).toBeCloseTo(-25.7, 1)
    expect(x).toBeCloseTo(ref.horizontal, 6) // encolhe ~0,75% na horizontal
    expect(z).toBeCloseTo(0, 9)
    expect(R - Math.sqrt(R * R - 300 * 300)).toBeCloseTo(26.1, 1) // aproximação plana, para comparação
    expect(curvatureDropKm(300)).toBeCloseTo(-ref.up, 6)
  })

  it('o exagero vale para o relevo, não para a esfera', () => {
    const e1 = curvedPoint(0, 200, 0, 1)[1]
    const e3 = curvedPoint(0, 200, 0, 3)[1]
    expect(e3).toBeCloseTo(e1, 9) // altitude zero: mesma queda com qualquer exagero
    const peak = curvedPoint(0, 200, 2, 3)
    expect(Math.hypot(peak[0], peak[1] + R, peak[2])).toBeCloseTo(R + 6, 6) // raio = R + h·e
  })

  it('direção: +y do mapa vai para −Z da cena, +x para +X', () => {
    expect(curvedPoint(0, 100, 0, 1)[2]).toBeLessThan(0)
    expect(curvedPoint(100, 0, 0, 1)[0]).toBeGreaterThan(0)
  })

  it('curvature=0 devolve o plano exagerado', () => {
    expect(curvedPoint(120, -40, 2, 3, 0)).toEqual([120, 6, 40])
  })

  it('injeta os três trechos no shader', () => {
    const shader = {
      vertexShader: '#include <common>\nvoid main(){\n#include <beginnormal_vertex>\n#include <begin_vertex>\n}',
      uniforms: {} as Record<string, { value: unknown }>,
    }
    const uniforms = { uMoonR: { value: R }, uExaggeration: { value: 3 }, uCurvature: { value: 1 } }
    injectCurvature(shader, uniforms)
    expect(shader.vertexShader).toContain(CURVATURE_GLSL.trim().split('\n')[0])
    expect(shader.vertexShader).toContain('transformed = lunarPosition(transformed);')
    expect(shader.vertexShader).toContain('objectNormal = lunarNormal(position, objectNormal);')
    expect(shader.uniforms.uExaggeration).toBe(uniforms.uExaggeration) // compartilhado por referência
  })
})
