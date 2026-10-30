// Seleção de tiles da quadtree por erro em espaço de tela (LOD), sem dependência de three.js.
import { curvatureDropKm, MOON_RADIUS_KM } from './curvature'
//
// Cena 3D (km): X = x do mapa, Y = altitude × exagero, Z = −y do mapa.
// Um tile se divide em 4 quando o tamanho da sua célula, projetado na tela a partir da
// distância da câmera, passa de `maxScreenErrorPx` pixels — e só se estiver no campo de visão.

export interface TileMeta {
  x0: number
  y0: number
  size_m: number
  tile_cells: number
  texture_px: number
  max_zoom: number
  native_pixel_m: number
  leaf_cell_m: number
  height_min_m: number
  height_max_m: number
  /** região onde a camada analítica é O(1) no servidor (área com cache de horizontes) */
  fast_bounds?: { x_min: number; x_max: number; y_min: number; y_max: number } | null
}

/** Fração da área do tile que cai na região analítica rápida (0..1). */
export function fastFraction(meta: TileMeta, k: TileKey): number {
  const f = meta.fast_bounds
  if (!f) return 0
  const b = tileBounds(meta, k)
  const w = Math.max(0, Math.min(b.xmax, f.x_max) - Math.max(b.xmin, f.x_min))
  const h = Math.max(0, Math.min(b.ymax, f.y_max) - Math.max(b.ymin, f.y_min))
  return (w * h) / (b.size * b.size)
}

export interface TileKey {
  z: number
  x: number
  y: number
}

export interface TileBox {
  min: [number, number, number]
  max: [number, number, number]
}

export const tileId = (k: TileKey) => `${k.z}/${k.x}/${k.y}`

export function parseTileId(id: string): TileKey {
  const [z, x, y] = id.split('/').map(Number)
  return { z, x, y }
}

export function parentOf(k: TileKey): TileKey | null {
  return k.z === 0 ? null : { z: k.z - 1, x: k.x >> 1, y: k.y >> 1 }
}

export function childrenOf(k: TileKey): TileKey[] {
  const z = k.z + 1, x = 2 * k.x, y = 2 * k.y
  return [{ z, x, y }, { z, x: x + 1, y }, { z, x, y: y + 1 }, { z, x: x + 1, y: y + 1 }]
}

export function isAncestor(a: TileKey, b: TileKey): boolean {
  if (a.z >= b.z) return false
  const s = b.z - a.z
  return b.x >> s === a.x && b.y >> s === a.y
}

/** Limites do tile no plano do mapa (metros) e tamanho da célula. */
export function tileBounds(meta: TileMeta, k: TileKey) {
  const size = meta.size_m / 2 ** k.z
  const xmin = meta.x0 + k.x * size
  const ymax = meta.y0 - k.y * size
  return { xmin, xmax: xmin + size, ymin: ymax - size, ymax, size, cell: size / meta.tile_cells }
}

/**
 * Caixa do tile na cena (km), com a faixa global de altitudes do DEM.
 *
 * Com curvatura, o vertex shader leva o vértice (x, y, h) a r·u na esfera (r = R + h·e). Isso
 * (1) desce a superfície até ~26 km nas bordas e (2) escala a horizontal por s = 4R·r / (ρ² + 4R²),
 * encolhendo o tile em direção ao polo. A caixa usa os extremos exatos de s e da queda no tile —
 * senão o culling da quadtree descartaria tiles que estão na tela.
 */
export function tileBox(meta: TileMeta, k: TileKey, exaggeration: number, curvature = 0): TileBox {
  const b = tileBounds(meta, k)
  const hMin = (meta.height_min_m / 1000) * exaggeration, hMax = (meta.height_max_m / 1000) * exaggeration
  const xs = [b.xmin / 1000, b.xmax / 1000], ys = [b.ymin / 1000, b.ymax / 1000]
  if (!curvature) return { min: [xs[0], hMin, -ys[1]], max: [xs[1], hMax, -ys[0]] }
  const R = MOON_RADIUS_KM
  const dx = Math.max(xs[0], 0, -xs[1]), dy = Math.max(ys[0], 0, -ys[1])
  const rhoNear = Math.hypot(dx, dy)
  const rhoFar = Math.max(...xs.flatMap((x) => ys.map((y) => Math.hypot(x, y))))
  const sMin = (4 * R * (R + hMin)) / (rhoFar ** 2 + 4 * R * R)
  const sMax = (4 * R * (R + hMax)) / (rhoNear ** 2 + 4 * R * R)
  const span = (v: number[]) => { const c = v.flatMap((q) => [q * sMin, q * sMax]); return [Math.min(...c), Math.max(...c)] }
  const [x0, x1] = span(xs), [y0, y1] = span(ys)
  const mix = (a: number, c: number) => a + (c - a) * curvature
  return {
    min: [mix(xs[0], x0), Math.min(hMin, hMin - curvature * curvatureDropKm(rhoFar)), mix(-ys[1], -y1)],
    max: [mix(xs[1], x1), hMax - curvature * curvatureDropKm(rhoNear), mix(-ys[0], -y0)],
  }
}

export function distanceToBox(p: [number, number, number], box: TileBox): number {
  let d2 = 0
  for (let i = 0; i < 3; i++) {
    const v = Math.max(box.min[i] - p[i], 0, p[i] - box.max[i])
    d2 += v * v
  }
  return Math.sqrt(d2)
}

export interface SelectOptions {
  camera: [number, number, number]
  fovYDeg: number
  viewportHeightPx: number
  maxScreenErrorPx: number
  exaggeration: number
  curvature?: number // 0 = plano, 1 = esfera (deve casar com o vertex shader)
  isVisible?: (box: TileBox) => boolean
  maxTiles?: number
}

/** Erro (px) de exibir o tile na resolução atual: tamanho da célula projetado na tela. */
export function screenError(meta: TileMeta, k: TileKey, o: SelectOptions): number {
  const cellKm = tileBounds(meta, k).cell / 1000
  const d = Math.max(distanceToBox(o.camera, tileBox(meta, k, o.exaggeration, o.curvature)), 1e-3)
  return (cellKm * o.viewportHeightPx) / (2 * d * Math.tan(((o.fovYDeg * Math.PI) / 180) / 2))
}

/**
 * Folhas da quadtree a desenhar: refinadas onde o erro na tela é grande, cortadas fora da vista.
 * Refinamento guloso pelo MAIOR erro: com o teto de tiles, o detalhe vai primeiro para perto da
 * câmera (uma busca em largura gastaria o orçamento refinando a paisagem distante).
 */
export function selectTiles(meta: TileMeta, o: SelectOptions): TileKey[] {
  const maxTiles = o.maxTiles ?? 256
  const visible = (k: TileKey) => !o.isVisible || o.isVisible(tileBox(meta, k, o.exaggeration, o.curvature))
  const leaves: { k: TileKey; err: number }[] = []
  const add = (k: TileKey) => { if (visible(k)) leaves.push({ k, err: screenError(meta, k, o) }) }
  add({ z: 0, x: 0, y: 0 })
  for (;;) {
    let best = -1
    for (let i = 0; i < leaves.length; i++) {
      const l = leaves[i]
      if (l.k.z < meta.max_zoom && l.err > o.maxScreenErrorPx && (best < 0 || l.err > leaves[best].err)) best = i
    }
    if (best < 0 || leaves.length + 3 > maxTiles) break
    const [{ k }] = leaves.splice(best, 1)
    childrenOf(k).forEach(add)
  }
  return leaves.map((l) => l.k)
}
