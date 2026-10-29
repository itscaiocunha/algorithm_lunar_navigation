import type { Bounds } from './api'

// Estado da câmera do mapa 2D (deck.gl OrthographicView), em km no plano polar estereográfico.
export interface ViewState {
  target: [number, number, number]
  zoom: number
}

/** Enquadra a área inteira numa altura de tela de `heightPx` pixels. */
export function initialViewState(bounds: Bounds, heightPx: number): ViewState {
  const spanKm = (bounds.y_max - bounds.y_min) / 1000
  return { target: [0, 0, 0], zoom: Math.log2((heightPx * 0.92) / spanKm) }
}

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}
