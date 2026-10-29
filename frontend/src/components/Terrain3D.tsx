import { Line, OrbitControls, useTexture } from '@react-three/drei'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { Suspense, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { BodyDirection, Terrain } from '../lib/api'
import { decodeHeights } from '../lib/api'
import { signed } from '../lib/geo'

// Plano em km: X = x do mapa, -Z = y do mapa (meridiano 0° para "dentro" da cena), Y = altitude.

export interface TextureLayer {
  url: string
  alpha: number
}

interface Props {
  terrain: Terrain
  baseUrl: string // relevo sombreado (sempre por baixo)
  layers: TextureLayer[] // desenhadas em ordem sobre o relevo
  exaggeration: number
  sun?: BodyDirection
  earth?: BodyDirection
  marker?: { x_m: number; y_m: number } | null
  onClickMap?: (x_m: number, y_m: number) => void
}

function useTerrainGeometry(terrain: Terrain, exaggeration: number) {
  const heights = useMemo(() => decodeHeights(terrain), [terrain])
  return useMemo(() => {
    const [rows, cols] = terrain.shape
    const b = terrain.bounds
    const geo = new THREE.PlaneGeometry((b.x_max - b.x_min) / 1000, (b.y_max - b.y_min) / 1000, cols - 1, rows - 1)
    const pos = geo.attributes.position as THREE.BufferAttribute
    const mean = (terrain.min_m + terrain.max_m) / 2
    // PlaneGeometry: vértices linha a linha, de cima (y+) para baixo — mesma ordem da matriz do DEM
    for (let i = 0; i < pos.count; i++) pos.setZ(i, ((heights[i] - mean) / 1000) * exaggeration)
    pos.needsUpdate = true
    geo.computeVertexNormals()
    return geo
  }, [terrain, heights, exaggeration])
}

/** Compõe as camadas sobre o relevo num único canvas (na resolução da maior imagem). */
function useLayeredTexture(baseUrl: string, layers: TextureLayer[]) {
  const images = useTexture([baseUrl, ...layers.map((l) => l.url)])
  const alphas = layers.map((l) => l.alpha).join(',')
  const texture = useMemo(() => {
    const size = Math.max(...images.map((t) => (t.image as HTMLImageElement).width))
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')!
    images.forEach((t, i) => {
      ctx.globalAlpha = i === 0 ? 1 : Number(alphas.split(',')[i - 1])
      ctx.drawImage(t.image as HTMLImageElement, 0, 0, size, size)
    })
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 8
    return tex
  }, [images, alphas])
  useEffect(() => () => texture.dispose(), [texture])
  return texture
}

function TerrainMesh({ terrain, baseUrl, layers, exaggeration, onClickMap }: Props) {
  const geometry = useTerrainGeometry(terrain, exaggeration)
  const texture = useLayeredTexture(baseUrl, layers)

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!onClickMap || !e.uv || e.delta > 4) return // ignora cliques que foram arrastos
    const b = terrain.bounds
    onClickMap(b.x_min + e.uv.x * (b.x_max - b.x_min), b.y_min + e.uv.y * (b.y_max - b.y_min))
  }

  return (
    <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} onClick={onClick}>
      <meshStandardMaterial map={texture} roughness={1} metalness={0} />
    </mesh>
  )
}

/** Seta tracejada do centro até o corpo; a elevação é ampliada (×3) só para ficar legível. */
function BodyIndicator({ body, radiusKm, color, size }: { body: BodyDirection; radiusKm: number; color: string; size: number }) {
  const [dx, dy] = body.map_dir
  const dir = new THREE.Vector3(dx, 0, -dy).normalize()
  const above = body.elevation_deg > 0
  const height = above ? radiusKm * Math.tan(THREE.MathUtils.degToRad(Math.min(body.elevation_deg * 3, 40))) + 1.5 : 0.6
  const tip = dir.clone().multiplyScalar(radiusKm).setY(height)
  return (
    <group>
      <Line points={[[0, 0.3, 0], tip.toArray()]} color={color} lineWidth={2} dashed dashSize={1.2} gapSize={0.8}
            transparent opacity={above ? 1 : 0.35} />
      <mesh position={tip}>
        <sphereGeometry args={[size, 24, 24]} />
        <meshBasicMaterial color={color} transparent opacity={above ? 1 : 0.35} />
      </mesh>
    </group>
  )
}

function Marker({ x_m, y_m, terrain, exaggeration }: { x_m: number; y_m: number; terrain: Terrain; exaggeration: number }) {
  const x = x_m / 1000
  const z = -y_m / 1000
  const half = ((terrain.max_m - terrain.min_m) / 2000) * exaggeration
  return <Line points={[[x, -half, z], [x, half + 2, z]]} color="#7dff7a" lineWidth={2} />
}

export function Terrain3D(props: Props) {
  const { terrain, sun, earth } = props
  const size = (terrain.bounds.x_max - terrain.bounds.x_min) / 1000
  return (
    <div className="relative h-full">
      {(sun || earth) && (
        <div className="pointer-events-none absolute top-3 left-3 z-10 space-y-1 rounded-md bg-space-950/85 px-2.5 py-1.5 text-xs text-slate-300 backdrop-blur">
          {sun && <BodyLegend color="bg-sun-300 shadow-sun-400" name="Sol" elevation={sun.elevation_deg} />}
          {earth && <BodyLegend color="bg-ice-400 shadow-ice-400" name="Terra" elevation={earth.elevation_deg} />}
          <div className="text-[10.5px] text-slate-500">vistos do polo · setas com elevação ampliada (×3) para visualização</div>
        </div>
      )}
      <Canvas camera={{ position: [-size * 0.1, size * 0.8, size * 0.95], fov: 42, near: 0.1, far: 1000 }} dpr={[1, 2]}>
        <color attach="background" args={['#07090e']} />
        <fog attach="fog" args={['#07090e', size * 1.6, size * 3]} />
        <ambientLight intensity={1.1} />
        <directionalLight position={[-size, size, size * 0.4]} intensity={1.4} />
        <Suspense fallback={null}>
          <TerrainMesh {...props} />
        </Suspense>
        {sun && <BodyIndicator body={sun} radiusKm={size * 0.55} color="#ffd68a" size={1.1} />}
        {/* a Terra parece ~4× maior que o Sol no céu lunar */}
        {earth && <BodyIndicator body={earth} radiusKm={size * 0.5} color="#40c8ff" size={2.2} />}
        {props.marker && <Marker {...props.marker} terrain={terrain} exaggeration={props.exaggeration} />}
        <OrbitControls makeDefault target={[0, 0, 0]} maxPolarAngle={Math.PI / 2.05} minDistance={8} maxDistance={size * 2.5} enableDamping />
      </Canvas>
    </div>
  )
}

function BodyLegend({ color, name, elevation }: { color: string; name: string; elevation: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`size-2.5 rounded-full shadow-[0_0_8px] ${color}`} />
      {name} a <b className="tabular">{signed(elevation)}</b>
      <span className="text-slate-500">{elevation > 0 ? 'acima' : 'abaixo'} do horizonte ideal</span>
    </div>
  )
}
