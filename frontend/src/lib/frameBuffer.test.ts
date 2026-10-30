import { describe, expect, it, vi } from 'vitest'
import { FrameBuffer } from './frameBuffer'

/** fetch falso: cada chamada fica pendente até o teste resolvê-la, na ordem que quiser. */
function fakeFetch() {
  const calls: { i: number; signal: AbortSignal; resolve: (v: string) => void; reject: (e: Error) => void }[] = []
  const fetchFrame = (i: number, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => { calls.push({ i, signal, resolve, reject }) })
  return { calls, fetchFrame }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('FrameBuffer', () => {
  it('busca em ordem a partir do cursor, respeitando a concorrência', () => {
    const f = fakeFetch()
    const buf = new FrameBuffer(20, { fetchFrame: f.fetchFrame, ahead: 10, behind: 2, concurrency: 2 })
    buf.start()
    expect(f.calls.map((c) => c.i)).toEqual([0, 1])
  })

  it('resposta fora de ordem cai no índice certo (sem condição de corrida)', async () => {
    const f = fakeFetch()
    const buf = new FrameBuffer(10, { fetchFrame: f.fetchFrame, ahead: 5, behind: 0, concurrency: 2 })
    buf.start()
    f.calls[1].resolve('quadro 1') // "14 h" chega antes de "12 h"
    await flush()
    expect(buf.has(0)).toBe(false)
    expect(buf.get(1)).toBe('quadro 1')
    expect(buf.bufferedUntil()).toBe(0) // a reprodução ainda espera pelo quadro 0
    f.calls[0].resolve('quadro 0')
    await flush()
    expect(buf.get(0)).toBe('quadro 0')
    expect(buf.bufferedUntil()).toBe(2)
  })

  it('mover o cursor cancela o que saiu da janela e reprioriza a fila', async () => {
    const f = fakeFetch()
    const buf = new FrameBuffer(100, { fetchFrame: f.fetchFrame, ahead: 4, behind: 1, concurrency: 2 })
    buf.start()
    buf.setCursor(50) // usuário arrastou o scrubber
    expect(f.calls[0].signal.aborted).toBe(true)
    expect(f.calls[1].signal.aborted).toBe(true)
    expect(f.calls.slice(2).map((c) => c.i)).toEqual([50, 51])
    f.calls[0].resolve('velho') // chegou depois do cancelamento: descartado
    await flush()
    expect(buf.has(0)).toBe(false)
  })

  it('descarta da memória o que fica fora da janela deslizante', async () => {
    const f = fakeFetch()
    const buf = new FrameBuffer(30, { fetchFrame: f.fetchFrame, ahead: 3, behind: 1, concurrency: 1 })
    buf.start()
    for (let k = 0; k < 4; k++) { f.calls[k].resolve(`q${k}`); await flush() }
    expect(buf.loaded()).toEqual([0, 1, 2, 3])
    buf.setCursor(3)
    expect(buf.loaded()).toEqual([2, 3]) // behind = 1
    expect(f.calls.at(-1)!.i).toBe(4)
  })

  it('repete falhas com espera e marca o quadro como falho depois do limite', async () => {
    vi.useFakeTimers()
    const f = fakeFetch()
    const buf = new FrameBuffer(3, { fetchFrame: f.fetchFrame, ahead: 2, behind: 0, concurrency: 1, maxRetries: 2, retryDelayMs: 100 })
    buf.start()
    f.calls[0].reject(new Error('503'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toHaveLength(1) // esperando o backoff
    await vi.advanceTimersByTimeAsync(100)
    expect(f.calls.map((c) => c.i)).toEqual([0, 0])
    f.calls[1].reject(new Error('503'))
    await vi.advanceTimersByTimeAsync(0)
    expect(buf.failed(0)).toBe(true)
    expect(f.calls.at(-1)!.i).toBe(1) // segue para o próximo quadro
    vi.useRealTimers()
  })

  it('stop cancela tudo e ignora respostas atrasadas', async () => {
    const f = fakeFetch()
    const onChange = vi.fn()
    const buf = new FrameBuffer(5, { fetchFrame: f.fetchFrame, ahead: 4, behind: 0, concurrency: 2, onChange })
    buf.start()
    buf.stop()
    expect(f.calls.every((c) => c.signal.aborted)).toBe(true)
    f.calls[0].resolve('tarde')
    await flush()
    expect(buf.loaded()).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
  })
})
