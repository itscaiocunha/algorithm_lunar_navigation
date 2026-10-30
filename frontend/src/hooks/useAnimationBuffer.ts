import { useEffect, useMemo, useState } from 'react'
import { FrameBuffer } from '../lib/frameBuffer'

export interface AnimationBufferOptions {
  ahead?: number // quadros à frente do cursor (~12 s de folga a "1 dia lunar/min" com passo de 4 h)
  behind?: number // quadros mantidos atrás (voltar o scrubber sem rebaixar)
  concurrency?: number // 2: enquanto um quadro trafega, o servidor já calcula o próximo
}

/**
 * Esteira de download dos quadros da animação, separada da renderização.
 *
 * `times` define a linha do tempo (um quadro por instante). O buffer vive enquanto `times` não
 * mudar; trocar a janela cancela tudo e libera a memória. `version` muda a cada quadro que chega
 * (para a UI redesenhar a barra de carregamento) — o loop de reprodução consulta o buffer direto.
 */
export function useAnimationBuffer<T>(
  times: string[] | null,
  fetchFrame: (utc: string, signal: AbortSignal) => Promise<T>,
  { ahead = 36, behind = 12, concurrency = 2 }: AnimationBufferOptions = {},
) {
  const [version, setVersion] = useState(0)
  const buffer = useMemo(() => (times?.length
    ? new FrameBuffer<T>(times.length, {
      fetchFrame: (i, signal) => fetchFrame(times[i], signal),
      ahead, behind, concurrency,
      onChange: () => setVersion((v) => v + 1),
    })
    : null), [times, fetchFrame, ahead, behind, concurrency])
  useEffect(() => {
    if (!buffer) return
    buffer.start()
    return () => buffer.stop() // aborta requisições e solta os quadros
  }, [buffer])
  return { buffer, version }
}
