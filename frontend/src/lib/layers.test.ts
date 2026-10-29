import { describe, expect, it } from 'vitest'
import { decodeUint8, stateMasks } from './layers'

describe('estados Sol/Terra', () => {
  // pixels: [ouro, só Sol, só Terra (total), só Terra (degradada), nenhum]
  const sun = new Uint8Array([255, 200, 0, 0, 0])
  const earth = new Uint8Array([128, 0, 255, 51, 0])

  it('com Zona de Ouro: verde na intersecção, hachura só onde há Terra sem Sol', () => {
    const { golden, comms } = stateMasks(sun, earth, true)
    expect([...golden]).toEqual([255, 0, 0, 0, 0])
    expect(comms[0]).toBe(0)
    expect(comms[1]).toBe(0)
    expect(comms[2]).toBe(255)
    expect(comms[4]).toBe(0)
  })

  it('enlace degradado tem hachura mais fraca que o nominal', () => {
    const { comms } = stateMasks(sun, earth, true)
    expect(comms[3]).toBeGreaterThan(0)
    expect(comms[3]).toBeLessThan(comms[2])
  })

  it('sem Zona de Ouro: hachura em toda área com Terra visível', () => {
    const { golden, comms } = stateMasks(sun, earth, false)
    expect([...golden]).toEqual([0, 0, 0, 0, 0])
    expect([...comms].map((a) => a > 0)).toEqual([true, false, true, true, false])
  })

  it('decodifica base64 uint8', () => {
    expect([...decodeUint8(btoa(String.fromCharCode(0, 128, 255)))]).toEqual([0, 128, 255])
  })
})
