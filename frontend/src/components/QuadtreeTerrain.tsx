import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { curvedPoint, injectCurvature, MOON_RADIUS_KM } from '../lib/curvature'
import {
  fastFraction, isAncestor, parentOf, selectTiles, tileBounds, tileId, type TileKey, type TileMeta,
} from '../lib/quadtree'

// Terreno do DEM inteiro com Nível de Detalhe (quadtree):
//  - a cada ~0,25 s (se a câmera mexeu) escolhe as folhas pelo erro em espaço de tela + frustum;
//  - carrega alturas (Float32) e textura de cada folha, do mais grosseiro ao mais fino, 6 por vez;
//  - enquanto uma folha não chega, desenha o ancestral carregado mais próximo (sem buracos);
//  - saias verticais nas bordas escondem frestas entre tiles e entre níveis;
//  - expurgo LRU com orçamento de tiles: geometria e texturas são liberadas da GPU (dispose).

export interface AnalyticSpec {
  utc: string
  sun: boolean
  earth: boolean
  golden: boolean
}

export interface LodStats {
  loaded: number
  rendered: number
  vertices: number
  gpuMB: number
  maxZoom: number
  pending: number
  analyticReady: number
  analyticWanted: number
}

interface TileData {
  key: TileKey
  geometry: THREE.BufferGeometry // plana (x, h, −y em km): a GPU aplica exagero e curvatura
  relief: THREE.Texture
  analytic: THREE.Texture | null
  analyticKey: string | null
  bytes: number
  lastUsed: number
  picking: THREE.BufferGeometry | null // cópia curvada só para o clique (CPU), criada sob demanda
  pickingKey: string | null
  // enquanto a camada analítica própria não chega: recorte da textura de um ancestral (clone com
  // offset/repeat; o three.js compartilha a imagem na GPU entre clones da mesma fonte)
  fallback: { tex: THREE.Texture; src: THREE.Texture; key: string } | null
}

const hasAnalytic = (t: TileData | undefined, ak: string) => !!t?.analytic && t.analyticKey === ak

function dropFallback(t: TileData) {
  t.fallback?.tex.dispose()
  t.fallback = null
}

function disposeTile(t: TileData) {
  t.geometry.dispose(); t.relief.dispose(); t.analytic?.dispose(); t.picking?.dispose(); dropFallback(t)
}

/**
 * Raycasting contra a superfície CURVADA. O three.js testa o raio na CPU, mas a curvatura só existe
 * na GPU: contra a geometria plana, um clique na borda erraria por quilômetros (a superfície desce
 * até ~26 km). Filtra pela esfera envolvente curvada e só então monta a cópia curvada do tile.
 */
function curvedRaycast(this: THREE.Mesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
  const { tile, exaggeration, curvature } = this.userData as { tile: TileData; exaggeration: number; curvature: number }
  const key = `${exaggeration}|${curvature}`
  if (tile.pickingKey !== key) {
    const sphere = tile.geometry.boundingSphere!
    const c = curvedPoint(sphere.center.x, -sphere.center.z, sphere.center.y, exaggeration, curvature)
    const bound = new THREE.Sphere(new THREE.Vector3(...c), sphere.radius * Math.max(1, exaggeration) + 2)
    if (!raycaster.ray.intersectsSphere(bound)) return
    const src = tile.geometry.attributes.position.array as Float32Array
    const pos = new Float32Array(src.length)
    for (let i = 0; i < src.length; i += 3) pos.set(curvedPoint(src[i], -src[i + 2], src[i + 1], exaggeration, curvature), i)
    tile.picking?.dispose()
    tile.picking = new THREE.BufferGeometry()
    tile.picking.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    tile.picking.setAttribute('uv', tile.geometry.attributes.uv)
    tile.picking.setIndex(tile.geometry.index)
    tile.picking.computeBoundingSphere()
    tile.pickingKey = key
  }
  const proxy = new THREE.Mesh(tile.picking!, this.material)
  proxy.matrixWorld.copy(this.matrixWorld)
  const before = intersects.length
  THREE.Mesh.prototype.raycast.call(proxy, raycaster, intersects)
  for (let i = before; i < intersects.length; i++) intersects[i].object = this // o evento é do tile real
}

const MAX_SCREEN_ERROR_PX = 4
const MAX_SELECTED = 160 // folhas desenhadas
const GPU_BUDGET_MB = 128 // orçamento de memória: acima disso o LRU expurga o que não está na tela
const CONCURRENCY = 6
const ANALYTIC_CONCURRENCY = 4 // dentro da área com horizontes é O(1); fora, ~0,3–0,6 s por tile
const LEVEL_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#6366f1', '#d946ef', '#ffffff', '#94a3b8', '#64748b']

const loader = new THREE.TextureLoader()

function buildGeometry(h: Float32Array, n: number, b: ReturnType<typeof tileBounds>): THREE.BufferGeometry {
  const v = n + 1
  const nv = v * v
  const edge: number[] = [] // índices dos vértices da borda, em sequência fechada
  for (let i = 0; i < v; i++) edge.push(i) // norte
  for (let j = 1; j < v; j++) edge.push(j * v + n) // leste
  for (let i = n - 1; i >= 0; i--) edge.push(n * v + i) // sul
  for (let j = n - 1; j >= 1; j--) edge.push(j * v) // oeste

  // 1. superfície: posições, uv e normais calculadas SÓ com os triângulos da superfície
  const surf = new THREE.BufferGeometry()
  const pos = new Float32Array(nv * 3)
  const uv = new Float32Array(nv * 2)
  const valid = new Uint8Array(nv)
  for (let j = 0; j < v; j++) {
    for (let i = 0; i < v; i++) {
      const k = j * v + i
      valid[k] = Number.isFinite(h[k]) ? 1 : 0
      pos.set([(b.xmin + i * b.cell) / 1000, valid[k] ? h[k] / 1000 : 0, -(b.ymax - j * b.cell) / 1000], k * 3)
      uv.set([i / n, 1 - j / n], k * 2)
    }
  }
  const idx: number[] = []
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * v + i, c = a + 1, bb = a + v, d = bb + 1
      if (valid[a] && valid[bb] && valid[c] && valid[d]) idx.push(a, bb, c, c, bb, d)
    }
  }
  surf.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  surf.setIndex(idx)
  surf.computeVertexNormals()
  const nrm = surf.attributes.normal.array as Float32Array

  // 2. saias: vértices PRÓPRIOS (topo + base) com a normal da borda — se compartilhassem os
  //    vértices da superfície, a parede vertical entortaria a normal e a borda ficaria escura.
  //    Profundidade ≥ 0,3 km: cobre o descasamento entre leituras vizinhas (< 30 m) e entre níveis.
  const skirt = Math.max(0.3, (4 * b.cell) / 1000)
  const m = edge.length
  const total = nv + 2 * m
  const P = new Float32Array(total * 3), N = new Float32Array(total * 3), U = new Float32Array(total * 2)
  P.set(pos); N.set(nrm); U.set(uv)
  edge.forEach((src, s2) => {
    for (const [slot, dy] of [[nv + s2, 0], [nv + m + s2, -skirt]] as const) {
      P.set([pos[src * 3], pos[src * 3 + 1] + dy, pos[src * 3 + 2]], slot * 3)
      N.set([nrm[src * 3], nrm[src * 3 + 1], nrm[src * 3 + 2]], slot * 3)
      U.set([uv[src * 2], uv[src * 2 + 1]], slot * 2)
    }
  })
  for (let s2 = 0; s2 < m; s2++) {
    const a = edge[s2], b2 = edge[(s2 + 1) % m]
    if (!valid[a] || !valid[b2]) continue
    const ta = nv + s2, tb = nv + ((s2 + 1) % m), ba = nv + m + s2, bb2 = nv + m + ((s2 + 1) % m)
    idx.push(ta, ba, tb, tb, ba, bb2)
  }
  surf.dispose()
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(P, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2))
  g.setIndex(idx)
  g.computeBoundingSphere()
  return g
}

/** Bytes na GPU: posição + normal + uv (8 floats/vértice), índice (16 ou 32 bits) e textura RGBA com mipmaps. */
function gpuBytes(g: THREE.BufferGeometry, texturePx: number): number {
  const idx = g.index
  return g.attributes.position.count * 8 * 4 + (idx ? idx.count * idx.array.BYTES_PER_ELEMENT : 0) + texturePx ** 2 * 4 * 1.33
}

function setupTexture(t: THREE.Texture): THREE.Texture {
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

const analyticKeyOf = (a: AnalyticSpec) => `${a.utc}|${+a.sun}${+a.earth}${+a.golden}`

export function QuadtreeTerrain({ meta, exaggeration, curvature, analytic, debugLevels, onStats, onClickMap }: {
  meta: TileMeta
  exaggeration: number
  curvature: number // 0 = plano do mapa, 1 = esfera lunar (vertex shader)
  analytic: AnalyticSpec | null
  debugLevels: boolean
  onStats?: (s: LodStats) => void
  onClickMap?: (x_m: number, y_m: number) => void
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)
  // uniforms compartilhados por TODOS os tiles (mesmo programa de shader): mudar o exagero ou a
  // curvatura é só trocar um número na GPU — nenhuma geometria é reconstruída
  // (ref: objeto mutável que pertence à GPU; só é lido na compilação do shader e em efeitos)
  const uniforms = useRef({
    uMoonR: { value: MOON_RADIUS_KM }, uExaggeration: { value: exaggeration }, uCurvature: { value: curvature },
  })
  const last = useRef({ t: 0, pos: new THREE.Vector3(Infinity, 0, 0), quat: new THREE.Quaternion() })
  useEffect(() => {
    uniforms.current.uExaggeration.value = exaggeration
    uniforms.current.uCurvature.value = curvature
    last.current.pos.set(Infinity, 0, 0) // força reavaliar a seleção (as caixas mudaram)
    invalidate()
  }, [exaggeration, curvature, invalidate])
  const onBeforeCompile = useCallback(
    (shader: THREE.WebGLProgramParametersWithUniforms) => injectCurvature(shader, uniforms.current), [])
  const cache = useRef(new Map<string, TileData>())
  const inflight = useRef(new Map<string, AbortController>())
  const analyticInflight = useRef(new Set<string>())
  const [selected, setSelected] = useState<TileKey[]>([{ z: 0, x: 0, y: 0 }])
  const selectedRef = useRef<TileKey[]>([{ z: 0, x: 0, y: 0 }])
  const [rendered, setRendered] = useState<TileData[]>([])
  const [version, setVersion] = useState(0) // incrementa quando um tile termina de carregar (libera a fila)
  const aKey = analytic ? analyticKeyOf(analytic) : null
  const aKeyRef = useRef(aKey) // lido em callbacks assíncronos, que guardam closures antigas
  const metaRef = useRef(meta)
  useEffect(() => { aKeyRef.current = aKey; metaRef.current = meta }, [aKey, meta])

  // o que desenhar: a folha se carregada; senão o ancestral carregado mais próximo (o ancestral
  // prevalece sobre descendentes, evitando sobreposição). Chamado só em callbacks, nunca no render.
  const recompute = () => {
    const set = new Map<string, TileData>()
    for (const k of selectedRef.current) {
      for (let a: TileKey | null = k; a; a = parentOf(a)) {
        const t = cache.current.get(tileId(a))
        if (t) { set.set(tileId(a), t); break }
      }
    }
    const list = [...set.values()]
    let out = list.filter((t) => !list.some((o) => isAncestor(o.key, t.key)))
    const now = performance.now()
    const ak = aKeyRef.current
    if (ak) {
      // a câmera girou ou afastou e pediu um tile mais grosso ainda sem análise: se os 4 filhos já
      // têm a camada, continua desenhando os filhos até o pai chegar (a cor não "pisca")
      out = out.flatMap((t) => {
        if (hasAnalytic(t, ak)) return [t]
        const kids = [0, 1].flatMap((dy) => [0, 1].map((dx) => cache.current.get(tileId({ z: t.key.z + 1, x: 2 * t.key.x + dx, y: 2 * t.key.y + dy }))))
        return kids.every((c) => hasAnalytic(c, ak)) ? (kids as TileData[]) : [t]
      })
      // tile novo, mais fino, sem análise: recorta a textura do ancestral mais próximo que já tem
      for (const t of out) {
        if (hasAnalytic(t, ak)) { dropFallback(t); continue }
        let src: TileData | undefined
        for (let a = parentOf(t.key); a && !src; a = parentOf(a)) {
          const c = cache.current.get(tileId(a))
          if (hasAnalytic(c, ak)) src = c
        }
        if (!src) { dropFallback(t); continue }
        src.lastUsed = now // a fonte do recorte não pode ser expurgada antes do tile
        if (t.fallback?.src === src.analytic && t.fallback.key === ak) continue
        dropFallback(t)
        const bt = tileBounds(metaRef.current, t.key), bs = tileBounds(metaRef.current, src.key)
        const tex = src.analytic!.clone()
        tex.repeat.set(bt.size / bs.size, bt.size / bs.size)
        tex.offset.set((bt.xmin - bs.xmin) / bs.size, (bt.ymin - bs.ymin) / bs.size)
        t.fallback = { tex, src: src.analytic!, key: ak }
      }
    }
    out.forEach((t) => { t.lastUsed = now })
    setRendered(out)
  }
  const tileLoaded = () => { recompute(); setVersion((v) => v + 1) }
  const pendingFrame = useRef(0)
  const frustum = useMemo(() => new THREE.Frustum(), [])
  const box = useMemo(() => new THREE.Box3(), [])
  const projView = useMemo(() => new THREE.Matrix4(), [])

  // 1. seleção por erro de tela + frustum (throttle: 4×/s, só se a câmera mexeu)
  useFrame(({ clock, invalidate }) => {
    const l = last.current
    const moved = l.pos.distanceToSquared(camera.position) >= 1e-6 || l.quat.angleTo(camera.quaternion) >= 1e-4
    if (!moved) return
    if (clock.elapsedTime - l.t < 0.25) {
      // render sob demanda: se a câmera parar dentro da janela de 0,25 s não viria outro quadro,
      // e a seleção ficaria velha — agenda um quadro para reavaliar
      if (!pendingFrame.current) pendingFrame.current = window.setTimeout(() => { pendingFrame.current = 0; invalidate() }, 260)
      return
    }
    l.t = clock.elapsedTime
    l.pos.copy(camera.position)
    l.quat.copy(camera.quaternion)
    camera.updateMatrixWorld()
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    frustum.setFromProjectionMatrix(projView)
    const next = selectTiles(meta, {
      camera: [camera.position.x, camera.position.y, camera.position.z], fovYDeg: camera.fov,
      viewportHeightPx: size.height, maxScreenErrorPx: MAX_SCREEN_ERROR_PX, exaggeration, curvature, maxTiles: MAX_SELECTED,
      isVisible: (b) => frustum.intersectsBox(box.set(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max))),
    })
    const prev = selectedRef.current
    if (prev.length === next.length && prev.every((k, i) => tileId(k) === tileId(next[i]))) return
    selectedRef.current = next
    setSelected(next)
    recompute()
  })

  // 2. carregamento: grosso -> fino, cancela o que saiu da seleção
  useEffect(() => {
    const wanted = new Map<string, TileKey>()
    for (const k of selected) {
      for (let a: TileKey | null = k; a; a = parentOf(a)) {
        if (a.z <= 2 || a === k) wanted.set(tileId(a), a) // ancestrais grosseiros = substitutos rápidos
      }
    }
    for (const [id, ctrl] of inflight.current) if (!wanted.has(id)) { ctrl.abort(); inflight.current.delete(id) }
    const queue = [...wanted.values()].filter((k) => !cache.current.has(tileId(k)) && !inflight.current.has(tileId(k)))
    queue.sort((a, b) => a.z - b.z)
    const free = CONCURRENCY - inflight.current.size
    for (const k of queue.slice(0, Math.max(0, free))) {
      const id = tileId(k)
      const ctrl = new AbortController()
      inflight.current.set(id, ctrl)
      const b = tileBounds(meta, k)
      Promise.all([
        fetch(`/api/tiles/${id}/heights`, { signal: ctrl.signal }).then((r) => r.arrayBuffer()),
        loader.loadAsync(`/api/tiles/${id}/relief.png`),
      ]).then(([buf, tex]) => {
        if (ctrl.signal.aborted) { tex.dispose(); return }
        const geometry = buildGeometry(new Float32Array(buf), meta.tile_cells, b)
        const bytes = gpuBytes(geometry, meta.texture_px)
        cache.current.set(id, { key: k, geometry, relief: setupTexture(tex), analytic: null, analyticKey: null, bytes, lastUsed: performance.now(), picking: null, pickingKey: null, fallback: null })
      }).catch(() => undefined).finally(() => {
        inflight.current.delete(id)
        tileLoaded()
      })
    }
  }, [selected, version, meta])

  // 4. camada analítica: progressiva, do mais perto da câmera ao mais longe
  useEffect(() => {
    if (!analytic || !aKey) return
    for (const t of cache.current.values()) {
      if (t.analyticKey && t.analyticKey !== aKey) { t.analytic?.dispose(); t.analytic = null; t.analyticKey = null }
    }
    // tile sem análise e sem ancestral para recortar: pede antes um ancestral 2 níveis acima — um
    // pedido cobre 16 tiles com uma prévia grosseira, em vez de deixá-los com o relevo cru
    const want = new Map<string, { t: TileData; preview: boolean }>()
    for (const t of rendered) {
      if (t.analyticKey === aKey) continue
      if (t.fallback?.key !== aKey) {
        for (let a = parentOf(t.key); a; a = parentOf(a)) {
          const c = cache.current.get(tileId(a))
          if (c && a.z <= t.key.z - 2 && c.analyticKey !== aKey) { want.set(tileId(a), { t: c, preview: true }); break }
        }
      }
      if (!want.has(tileId(t.key))) want.set(tileId(t.key), { t, preview: false })
    }
    const todo = [...want.entries()].filter(([id]) => !analyticInflight.current.has(`${id}|${aKey}`))
    const center = (t: TileData) => { const b = tileBounds(meta, t.key); return new THREE.Vector3((b.xmin + b.xmax) / 2000, 0, -(b.ymin + b.ymax) / 2000) }
    // prévias primeiro; depois os tiles na região rápida (horizontes, ~60 ms); depois por distância (ray-casting, ~2 s)
    const cost = ({ t, preview }: { t: TileData; preview: boolean }) =>
      (preview ? 0 : 1e7) + (1 - fastFraction(meta, t.key)) * 1e6 + center(t).distanceTo(camera.position)
    const sorted = todo.map(([, w]) => w).sort((a, b) => cost(a) - cost(b)).map((w) => w.t)
    const free = ANALYTIC_CONCURRENCY - analyticInflight.current.size
    for (const t of sorted.slice(0, Math.max(0, free))) {
      const id = `${tileId(t.key)}|${aKey}`
      analyticInflight.current.add(id)
      const q = new URLSearchParams({ utc: analytic.utc, sun: String(analytic.sun), earth: String(analytic.earth), golden: String(analytic.golden) })
      loader.loadAsync(`/api/tiles/${tileId(t.key)}/analytic.png?${q}`).then((tex) => {
        const cur = cache.current.get(tileId(t.key))
        if (!cur) { tex.dispose(); return }
        cur.analytic?.dispose()
        cur.analytic = setupTexture(tex)
        cur.analyticKey = aKey
      }).catch(() => undefined).finally(() => {
        analyticInflight.current.delete(id)
        tileLoaded()
      })
    }
  }, [rendered, aKey, analytic, meta, camera])

  // 5. expurgo LRU (nunca o que está na tela) + estatísticas
  useEffect(() => {
    const onScreen = new Set(rendered.map((t) => tileId(t.key)))
    const tileBytes = (t: TileData) => t.bytes + (t.analytic ? meta.texture_px ** 2 * 4 * 1.33 : 0)
    let total = [...cache.current.values()].reduce((s, t) => s + tileBytes(t), 0)
    if (total > GPU_BUDGET_MB * 2 ** 20) {
      const victims = [...cache.current.entries()].filter(([id, t]) => !onScreen.has(id) && t.key.z > 1)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      for (const [id, t] of victims) {
        if (total <= GPU_BUDGET_MB * 2 ** 20) break
        total -= tileBytes(t)
        disposeTile(t)
        cache.current.delete(id)
      }
    }
    onStats?.({
      loaded: cache.current.size,
      rendered: rendered.length,
      vertices: rendered.reduce((s, t) => s + t.geometry.attributes.position.count, 0),
      gpuMB: total / 2 ** 20,
      maxZoom: rendered.reduce((m, t) => Math.max(m, t.key.z), 0),
      pending: inflight.current.size,
      analyticReady: aKey ? rendered.filter((t) => t.analyticKey === aKey).length : 0,
      analyticWanted: aKey ? rendered.length : 0,
    })
  }, [rendered, aKey, onStats, meta])

  // libera tudo ao desmontar
  useEffect(() => {
    const c = cache.current
    const inf = inflight.current
    return () => {
      for (const ctrl of inf.values()) ctrl.abort()
      for (const t of c.values()) disposeTile(t)
      c.clear()
    }
  }, [])

  const onClick = (e: ThreeEvent<MouseEvent>, k: TileKey) => {
    if (!onClickMap || !e.uv || e.delta > 4) return
    e.stopPropagation()
    const b = tileBounds(meta, k)
    onClickMap(b.xmin + e.uv.x * b.size, b.ymin + e.uv.y * b.size)
  }

  return (
    <group>
      {rendered.map((t) => (
        // frustumCulled=false: a esfera envolvente da CPU é a do tile plano, mas a GPU desce a superfície
        // até ~26 km; o culling correto já foi feito pela quadtree, com caixas que incluem a curvatura
        <mesh key={tileId(t.key)} geometry={t.geometry} frustumCulled={false} raycast={curvedRaycast}
              userData={{ tile: t, exaggeration, curvature }} onClick={(e) => onClick(e, t.key)}>
          <meshStandardMaterial map={!aKey ? t.relief : t.analyticKey === aKey && t.analytic ? t.analytic
                                     : t.fallback?.key === aKey ? t.fallback.tex : t.relief} roughness={1} metalness={0}
                                side={THREE.DoubleSide} transparent alphaTest={0.5}
                                onBeforeCompile={onBeforeCompile} customProgramCacheKey={() => 'lunar-curvature-v1'}
                                color={debugLevels ? LEVEL_COLORS[t.key.z % LEVEL_COLORS.length] : '#ffffff'} />
        </mesh>
      ))}
    </group>
  )
}
