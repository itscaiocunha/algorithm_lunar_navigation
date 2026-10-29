import { describe, expect, it } from 'vitest'
import { childrenOf, isAncestor, parentOf, screenError, selectTiles, tileBounds, type SelectOptions, type TileMeta } from './quadtree'

// mesma grade do backend: DEM de 608 km, 128 células por tile, nível máximo 6 (células de 74 m)
const META: TileMeta = {
  x0: -304_000, y0: 304_000, size_m: 608_000, tile_cells: 128, texture_px: 256, max_zoom: 6,
  native_pixel_m: 80, leaf_cell_m: 74.22, height_min_m: -7080, height_max_m: 6968,
}

const opts = (camera: [number, number, number], extra: Partial<SelectOptions> = {}): SelectOptions => ({
  camera, fovYDeg: 42, viewportHeightPx: 900, maxScreenErrorPx: 3, exaggeration: 3, ...extra,
})

const area = (k: { z: number }) => 4 ** -k.z // fração da área da raiz

describe('quadtree', () => {
  it('parentesco', () => {
    const kids = childrenOf({ z: 2, x: 1, y: 3 })
    expect(kids).toHaveLength(4)
    for (const c of kids) {
      expect(parentOf(c)).toEqual({ z: 2, x: 1, y: 3 })
      expect(isAncestor({ z: 2, x: 1, y: 3 }, c)).toBe(true)
    }
    expect(isAncestor({ z: 2, x: 0, y: 0 }, kids[0])).toBe(false)
  })

  it('folhas selecionadas cobrem a raiz exatamente, sem sobreposição', () => {
    const tiles = selectTiles(META, opts([0, 40, 60]))
    expect(tiles.reduce((s, k) => s + area(k), 0)).toBeCloseTo(1, 10)
    for (const a of tiles) for (const b of tiles) expect(isAncestor(a, b)).toBe(false)
  })

  it('câmera muito longe: poucos tiles grosseiros', () => {
    const tiles = selectTiles(META, opts([0, 20_000, 20_000]))
    expect(tiles.length).toBeLessThanOrEqual(4)
    expect(Math.max(...tiles.map((t) => t.z))).toBeLessThanOrEqual(1)
  })

  it('câmera rasante perto do Shackleton: nível máximo perto, grosseiro longe', () => {
    const cam: [number, number, number] = [8, 6, 6] // ~1 km acima da borda (km, cena)
    const tiles = selectTiles(META, opts(cam))
    const near = tiles.filter((t) => {
      const b = tileBounds(META, t)
      return b.xmin <= 8000 && 8000 <= b.xmax && b.ymin <= -6000 && -6000 <= b.ymax
    })
    expect(near[0].z).toBe(META.max_zoom)
    expect(Math.min(...tiles.map((t) => t.z))).toBeLessThanOrEqual(3)
    expect(tiles.length).toBeLessThanOrEqual(256) // teto respeitado mesmo na câmera rasante
  })

  it('erro de tela cai com a distância e com o nível', () => {
    const k = { z: 3, x: 3, y: 3 }
    expect(screenError(META, k, opts([0, 10, 0]))).toBeGreaterThan(screenError(META, k, opts([0, 1000, 0])))
    expect(screenError(META, { z: 4, x: 6, y: 6 }, opts([0, 500, 0]))).toBeLessThan(screenError(META, k, opts([0, 500, 0])))
  })

  it('frustum culling descarta tiles fora da vista', () => {
    const onlyWest = (box: { min: number[]; max: number[] }) => box.min[0] < 0
    const tiles = selectTiles(META, opts([0, 40, 60], { isVisible: onlyWest }))
    expect(tiles.every((t) => tileBounds(META, t).xmin < 0)).toBe(true)
    const all = selectTiles(META, opts([0, 40, 60]))
    expect(tiles.length).toBeLessThan(all.length)
  })

  it('respeita o teto de tiles', () => {
    expect(selectTiles(META, opts([8, 5, 6], { maxScreenErrorPx: 0.1, maxTiles: 64 })).length).toBeLessThanOrEqual(64)
  })
})
