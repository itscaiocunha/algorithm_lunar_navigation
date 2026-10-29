import { Line, OrbitControls, useTexture } from '@react-three/drei'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { Suspense, useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { Terrain } from '../lib/api'
import { decodeHeights } from '../lib/api'
import { fmt } from '../lib/geo'

// Plano em km: X = x do mapa, -Z = y do mapa (meridiano 0° para "dentro" da cena), Y = altitude.

interface Props {
  terrain: Terrain
  baseUrl: string // relevo sombreado
  textureUrl: string // iluminação (ou mapa anual) aplicada sobre o relevo
  exaggeration: number
  sun?: { map_dir: [number, number]; elevation_deg: number }
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

/** Iluminação (80%) sobre o relevo sombreado (20%): as sombras ficam escuras, mas o relevo continua legível. */
function useBlendedTexture(baseUrl: string, overlayUrl: string, overlayWeight = 0.8) {
  const [base, overlay] = useTexture([baseUrl, overlayUrl])
  const texture = useMemo(() => {
    const img = overlay.image as HTMLImageElement
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(base.image as HTMLImageElement, 0, 0, canvas.width, canvas.height)
    ctx.globalAlpha = baseUrl === overlayUrl ? 1 : overlayWeight
    ctx.drawImage(img, 0, 0)
    const t = new THREE.CanvasTexture(canvas)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    return t
  }, [base, overlay, baseUrl, overlayUrl, overlayWeight])
  useEffect(() => () => texture.dispose(), [texture])
  return texture
}

function TerrainMesh({ terrain, baseUrl, textureUrl, exaggeration, onClickMap }: Props) {
  const geometry = useTerrainGeometry(terrain, exaggeration)
  const texture = useBlendedTexture(baseUrl, textureUrl)

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

function SunIndicator({ sun, radiusKm }: { sun: NonNullable<Props['sun']>; radiusKm: number }) {
  const [dx, dy] = sun.map_dir
  const dir = new THREE.Vector3(dx, 0, -dy).normalize()
  // a elevação real (~1,5°) seria invisível; o raio é desenhado com elevação ampliada só para orientação
  const tip = dir.clone().multiplyScalar(radiusKm).setY(radiusKm * Math.tan(THREE.MathUtils.degToRad(Math.max(sun.elevation_deg, 0) * 4 + 2)))
  return (
    <group>
      <Line points={[[0, 0.3, 0], tip.toArray()]} color="#f5b04c" lineWidth={2} dashed dashSize={1.2} gapSize={0.8} />
      <mesh position={tip}>
        <sphereGeometry args={[1.1, 24, 24]} />
        <meshBasicMaterial color="#ffd68a" />
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
  const { terrain, sun, marker } = props
  const size = (terrain.bounds.x_max - terrain.bounds.x_min) / 1000
  return (
    <div className="relative h-full">
      {sun && (
        <div className="pointer-events-none absolute top-3 left-3 z-10 flex items-center gap-2 rounded-md bg-space-950/85 px-2.5 py-1.5 text-xs text-slate-300 backdrop-blur">
          <span className="size-2.5 rounded-full bg-sun-300 shadow-[0_0_8px] shadow-sun-400" />
          Sol a <b className="tabular text-sun-300">{fmt(sun.elevation_deg, 2)}°</b> sobre o horizonte do polo
          <span className="text-slate-500">· seta com elevação ampliada para visualização</span>
        </div>
      )}
      <TerrainCanvas {...props} size={size} sun={sun} marker={marker} />
    </div>
  )
}

function TerrainCanvas(props: Props & { size: number }) {
  const { terrain, sun, marker, size } = props
  return (
    <Canvas camera={{ position: [-size * 0.1, size * 0.8, size * 0.95], fov: 42, near: 0.1, far: 1000 }} dpr={[1, 2]}>
      <color attach="background" args={['#07090e']} />
      <fog attach="fog" args={['#07090e', size * 1.6, size * 3]} />
      <ambientLight intensity={1.1} />
      <directionalLight position={[-size, size, size * 0.4]} intensity={1.4} />
      <Suspense fallback={null}>
        <TerrainMesh {...props} />
      </Suspense>
      {sun && <SunIndicator sun={sun} radiusKm={size * 0.55} />}
      {marker && <Marker {...marker} terrain={terrain} exaggeration={props.exaggeration} />}
      <OrbitControls makeDefault target={[0, 0, 0]} maxPolarAngle={Math.PI / 2.05} minDistance={8} maxDistance={size * 2.5} enableDamping />
    </Canvas>
  )
}
