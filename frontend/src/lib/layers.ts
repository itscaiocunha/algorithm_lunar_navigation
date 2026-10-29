// Camadas analíticas compostas no navegador a partir das frações cruas (uint8) da API.
//
// Quatro estados exclusivos por pixel (mesma definição de src/lunar_navigator/link.py):
//   golden      Sol E Terra visíveis       -> verde de alto contraste
//   power_only  só Sol                      -> amarelo/laranja (camada do Sol, já vem do backend)
//   comms_only  só Terra                    -> hachura diagonal ciano ("cobertura de rádio")
//   none        nenhum                      -> preto (sombra) da camada do Sol

export const COLORS = {
  golden: [52, 211, 153] as const, // emerald-400
  comms: [64, 200, 255] as const, // ice-400
}

export function decodeUint8(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export interface StateMasks {
  /** alpha 0..255 da hachura: Terra visível (ponderada pela fração) — onde não vira ouro */
  comms: Uint8ClampedArray
  /** 255 onde Sol e Terra estão visíveis ao mesmo tempo */
  golden: Uint8ClampedArray
}

/**
 * Máscaras por pixel. Com `showGolden`, a intersecção vira verde e a hachura fica só onde há
 * Terra sem Sol; sem ela, a hachura cobre toda a área com Terra visível (sobreposição bruta).
 * A opacidade da hachura cresce com a fração do disco: enlace degradado aparece mais fraco.
 */
export function stateMasks(sun: Uint8Array, earth: Uint8Array, showGolden: boolean): StateMasks {
  const n = sun.length
  const comms = new Uint8ClampedArray(n)
  const golden = new Uint8ClampedArray(n)
  for (let i = 0; i < n; i++) {
    if (earth[i] === 0) continue
    if (showGolden && sun[i] > 0) golden[i] = 255
    else comms[i] = 90 + (165 * earth[i]) / 255
  }
  return { comms, golden }
}

function maskCanvas(alpha: Uint8ClampedArray, cols: number, rows: number, rgb: readonly number[]): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = cols
  c.height = rows
  const img = new ImageData(cols, rows)
  for (let i = 0; i < alpha.length; i++) {
    img.data[4 * i] = rgb[0]
    img.data[4 * i + 1] = rgb[1]
    img.data[4 * i + 2] = rgb[2]
    img.data[4 * i + 3] = alpha[i]
  }
  c.getContext('2d')!.putImageData(img, 0, 0)
  return c
}

/** Hachura diagonal fina em alta resolução (scale× o raster), recortada pela máscara. */
export function hatchLayer(alpha: Uint8ClampedArray, cols: number, rows: number, scale = 3, period = 16): string {
  const big = document.createElement('canvas')
  big.width = cols * scale
  big.height = rows * scale
  const ctx = big.getContext('2d')!
  const [r, g, b] = COLORS.comms
  ctx.strokeStyle = `rgb(${r} ${g} ${b})`
  ctx.lineWidth = 3.2
  ctx.beginPath()
  for (let k = -big.height; k < big.width; k += period) {
    ctx.moveTo(k, big.height)
    ctx.lineTo(k + big.height, 0)
  }
  ctx.stroke()
  ctx.globalCompositeOperation = 'destination-in'
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(maskCanvas(alpha, cols, rows, [0, 0, 0]), 0, 0, big.width, big.height)
  return big.toDataURL('image/png')
}

export function fillLayer(alpha: Uint8ClampedArray, cols: number, rows: number, rgb: readonly number[], opacity = 0.85): string {
  const scaled = alpha.map((a) => a * opacity)
  return maskCanvas(scaled, cols, rows, rgb).toDataURL('image/png')
}
