import { useCallback, useEffect, useRef, useState } from 'react'
import type { FrameBuffer } from '../lib/frameBuffer'
import { RATES, type TimelineWindow } from '../lib/timeline'

/** Relógio da simulação, mutável: o céu 3D o lê a cada quadro (60 fps) sem re-render do React. */
export interface PlaybackClock {
  tS: number // segundos simulados desde o início da janela (contínuo)
  playing: boolean
}

const UI_HZ = 10 // o React só vê o relógio 10×/s; o 3D lê o ref direto

/**
 * Loop de reprodução (requestAnimationFrame): só CONSOME o buffer. O relógio avança na velocidade
 * escolhida; ao cruzar para um quadro que ainda não chegou, ele para na borda (estado "buffering",
 * como no YouTube) e continua sozinho quando a rede alcança a linha do tempo.
 */
export function usePlayback(win: TimelineWindow | null, buffer: FrameBuffer<unknown> | null) {
  const clock = useRef<PlaybackClock>({ tS: 0, playing: false })
  const [playing, setPlaying] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [rateId, setRateId] = useState('lunar')
  const [index, setIndex] = useState(0) // quadro do chão em exibição
  const [tS, setTS] = useState(0) // relógio para a UI (10 Hz)
  const factor = (RATES.find((r) => r.id === rateId) ?? RATES[0]).factor

  // o cursor do buffer segue o quadro em exibição (a fila de download anda junto)
  useEffect(() => { buffer?.setCursor(index) }, [buffer, index])

  useEffect(() => {
    clock.current.playing = playing
    if (!playing || !win || !buffer) return
    const last = win.times.length - 1
    let raf = 0
    let prev = performance.now()
    let lastUi = 0
    let stalled = false
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - prev) / 1000) // aba em segundo plano não dá salto
      prev = now
      const c = clock.current
      const shown = Math.min(last, Math.floor(c.tS / win.stepS + 1e-9))
      let t = c.tS + dt * factor
      let wait = !buffer.has(shown)
      if (wait) t = c.tS // o próprio quadro ainda não chegou (logo após o scrubber)
      const target = Math.min(last, Math.floor(t / win.stepS + 1e-9))
      for (let k = shown + 1; k <= target && !wait; k++) {
        if (!buffer.has(k)) { t = k * win.stepS - 1e-3; wait = true } // segura na borda do quadro que falta
      }
      const ended = t >= win.durationS
      if (ended) t = win.durationS
      c.tS = t
      const idx = Math.min(last, Math.floor(t / win.stepS + 1e-9))
      if (idx !== shown) setIndex(idx)
      if (wait !== stalled) { stalled = wait; setBuffering(wait) }
      if (now - lastUi > 1000 / UI_HZ || ended) { lastUi = now; setTS(t) }
      if (ended) { setPlaying(false); return }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, win, buffer, factor])

  const seek = useCallback((t: number) => {
    if (!win) return
    const v = Math.max(0, Math.min(win.durationS, t))
    clock.current.tS = v
    setIndex(Math.min(win.times.length - 1, Math.floor(v / win.stepS + 1e-9)))
    setTS(v)
  }, [win])

  const play = useCallback(() => {
    if (win && clock.current.tS >= win.durationS) seek(0) // no fim: recomeça
    setPlaying(true)
  }, [win, seek])

  const pause = useCallback(() => setPlaying(false), [])

  /** Volta ao início — chamado por quem cria uma janela nova, antes de trocá-la. */
  const reset = useCallback(() => {
    clock.current.tS = 0
    setIndex(0)
    setTS(0)
    setBuffering(false)
  }, [])

  return { clock, playing, buffering: playing && buffering, rateId, setRateId, index, tS, seek, play, pause, reset }
}

export type Playback = ReturnType<typeof usePlayback>
