// Compõe um quadro de animação (nibbles Sol/Terra) numa imagem RGBA — no MESMO buffer a cada quadro.
//
// A imagem é usada como está pelo mapa 2D (ImageData sobre o relevo) e pela textura única da
// cena 3D (DataTexture que aponta para este buffer): trocar de quadro é reescrever os pixels e
// marcar `needsUpdate`, sem alocar memória nova na CPU nem na GPU.
//
// Mesmas camadas e pesos dos tiles analíticos (tiles.py): Sol em inferno (80%), hachura ciano onde
// só a Terra é visível (35–100% conforme a fração do disco) e Zona de Ouro em verde (85%).
import { COLORS } from './layers'
import type { AnimationFrame } from './api'

/** matplotlib "inferno" em 16 níveis (os 4 bits do quadro), de render.colorize. */
export const INFERNO16: readonly (readonly [number, number, number])[] = [
  [0, 0, 3], [11, 7, 38], [36, 11, 78], [65, 9, 103], [93, 18, 110], [120, 28, 109], [147, 37, 103], [174, 48, 91],
  [199, 62, 76], [220, 80, 57], [237, 104, 37], [247, 133, 14], [251, 164, 10], [249, 197, 44], [242, 230, 96], [252, 254, 164],
]

export interface ComposeLayers {
  sun: boolean
  earth: boolean
  golden: boolean
}

export interface FrameStats {
  lit_pct: number
  earth_pct: number
  golden_pct: number
}

export interface ComposedFrame {
  rgba: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
  stats: FrameStats
}

export const COMPOSE_SCALE = 2 // 2 px por pixel do DEM: hachura legível (listras de 320 m)

/**
 * Escreve o quadro em `out` (reaproveitado se tiver o tamanho certo) e devolve estatísticas da área.
 * Composição "over" pré-multiplicada; o resultado é RGBA não pré-multiplicado.
 */
export function composeFrame(frame: AnimationFrame, layers: ComposeLayers, out?: Uint8ClampedArray<ArrayBuffer>,
                             scale = COMPOSE_SCALE): ComposedFrame {
  const { rows, cols, bytes } = frame
  const width = cols * scale, height = rows * scale
  const rgba = out && out.length === width * height * 4 ? out : new Uint8ClampedArray(width * height * 4)
  const [cr, cg, cb] = COLORS.comms
  const [gr, gg, gb] = COLORS.golden
  let lit = 0, earthN = 0, gold = 0
  for (let i = 0; i < bytes.length; i++) {
    const s = bytes[i] >> 4, e = bytes[i] & 15
    if (s) lit++
    if (e) earthN++
    if (s && e) gold++
  }
  for (let y = 0; y < height; y++) {
    const row = ((y / scale) | 0) * cols
    for (let x = 0; x < width; x++) {
      const v = bytes[row + ((x / scale) | 0)]
      const s = v >> 4, e = v & 15
      let r = 0, g = 0, b = 0, a = 0 // pré-multiplicado
      if (layers.sun) {
        const c = INFERNO16[s]
        r = c[0] * 0.8; g = c[1] * 0.8; b = c[2] * 0.8; a = 0.8
      }
      const golden = layers.golden && s > 0 && e > 0
      if (layers.earth && e > 0 && !golden && (x + y) % 8 < 2) {
        const ah = 0.35 + (0.65 * e) / 15
        r = r * (1 - ah) + cr * ah; g = g * (1 - ah) + cg * ah; b = b * (1 - ah) + cb * ah; a = a + ah * (1 - a)
      }
      if (golden) {
        r = r * 0.15 + gr * 0.85; g = g * 0.15 + gg * 0.85; b = b * 0.15 + gb * 0.85; a = a + 0.85 * (1 - a)
      }
      const k = (y * width + x) * 4
      if (a > 0) {
        rgba[k] = r / a; rgba[k + 1] = g / a; rgba[k + 2] = b / a
      } else {
        rgba[k] = rgba[k + 1] = rgba[k + 2] = 0
      }
      rgba[k + 3] = a * 255
    }
  }
  const pct = (n: number) => (100 * n) / bytes.length
  return { rgba, width, height, stats: { lit_pct: pct(lit), earth_pct: pct(earthN), golden_pct: pct(gold) } }
}
