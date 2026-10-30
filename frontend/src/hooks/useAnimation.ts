import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type AnimationFrame, type EphemerisSeries } from '../lib/api'
import { composeFrame, type ComposedFrame, type ComposeLayers } from '../lib/frameCompose'
import { makeWindow, pointTimeline, type TimelineWindow } from '../lib/timeline'
import { useAnimationBuffer } from './useAnimationBuffer'
import { usePlayback } from './usePlayback'

export interface AnimationConfig {
  hours: number // janela
  stepH: number // passo dos quadros do chão
}

export const SKY_STEP_MIN = 30 // o céu é amostrado a cada 30 min e interpolado a 60 fps

const fetchFrame = (utc: string, signal: AbortSignal) => api.frame(utc, signal)

/** Quadro composto + número de sequência (a textura 3D só é reenviada quando ele muda). */
export type AnimatedOverlay = ComposedFrame & { seq: number; utc: string }

/**
 * Motor de animação: janela → buffer de quadros (rede) → relógio (render) → quadro composto.
 * O chão anda em blocos (um quadro a cada `stepH`); o céu, contínuo, vem de uma única série densa.
 */
export function useAnimation({ startUtc, point, layers }: {
  startUtc: string // ISO com Z
  point: { lat: number; lon: number } | null
  layers: ComposeLayers
}) {
  const [config, setConfig] = useState<AnimationConfig>({ hours: 168, stepH: 4 })
  const [win, setWin] = useState<TimelineWindow | null>(null)
  const { buffer, version } = useAnimationBuffer<AnimationFrame>(win?.times ?? null, fetchFrame)
  const playback = usePlayback(win, buffer)
  const [series, setSeries] = useState<EphemerisSeries | null>(null)
  const [error, setError] = useState<string | null>(null)

  // efemérides densas da janela inteira numa requisição (e de novo se o ponto mudar)
  const lat = point?.lat, lon = point?.lon
  useEffect(() => {
    if (!win) return
    const ctrl = new AbortController()
    const at = lat !== undefined && lon !== undefined ? { lat, lon } : undefined
    api.ephemeris(win.startUtc, win.hours, SKY_STEP_MIN, at, ctrl.signal)
      .then((s) => { setSeries(s); setError(null) })
      .catch((e) => { if (!(e instanceof DOMException)) setError(e instanceof Error ? e.message : String(e)) })
    return () => ctrl.abort()
  }, [win, lat, lon])

  const timeline = useMemo(() => (series ? pointTimeline(series) : null), [series])

  // quadro atual -> imagem, sempre no MESMO buffer RGBA (2D e textura 3D apontam para ele)
  const frame = buffer?.get(playback.index) ?? null
  const out = useRef<Uint8ClampedArray<ArrayBuffer> | undefined>(undefined)
  const seq = useRef(0)
  const [overlay, setOverlay] = useState<AnimatedOverlay | null>(null)
  const { sun, earth, golden } = layers
  useEffect(() => {
    if (!frame) return // quadro ainda não chegou: mantém o anterior na tela
    const c = composeFrame(frame, { sun, earth, golden }, out.current)
    out.current = c.rgba
    seq.current += 1
    setOverlay({ ...c, seq: seq.current, utc: frame.utc })
  }, [frame, sun, earth, golden])

  const start = useCallback(() => {
    setOverlay(null)
    setSeries(null)
    playback.reset()
    setWin(makeWindow(startUtc, config.hours, config.stepH))
    playback.play()
  }, [startUtc, config, playback])

  const stop = useCallback(() => {
    playback.pause()
    setWin(null)
    setSeries(null)
    setOverlay(null)
  }, [playback])

  const failed = buffer && win ? win.times.findIndex((_, i) => buffer.failed(i)) : -1

  return {
    active: win !== null, win, config, setConfig, start, stop, playback, buffer, version,
    series, timeline, overlay, frameUtc: frame?.utc ?? null,
    error: error ?? (failed >= 0 ? `Falha ao baixar o quadro de ${win!.times[failed]}` : null),
  }
}

export type Animation = ReturnType<typeof useAnimation>
