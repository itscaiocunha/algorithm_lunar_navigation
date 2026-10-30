import { Line, OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { BodyDirection } from '../lib/api'
import { curvedPoint } from '../lib/curvature'
import type { TileMeta } from '../lib/quadtree'
import { QuadtreeTerrain, type AnalyticSpec, type LodStats } from './QuadtreeTerrain'
import { BodyIndicator, BodyLegend } from './Terrain3D'

// Vista 3D do DEM inteiro (80°S–90°S, 608 km) com quadtree LOD. Cena em km; o vertex shader aplica o
// exagero vertical e leva o plano polar estereográfico à esfera lunar (curvatura).

export interface LodFocus {
  x_m: number
  y_m: number
  h_m: number
  key: number
}

const HOME = { target: new THREE.Vector3(0, 0, 0), position: new THREE.Vector3(-6, 48, 57) } // ±30 km do polo

function FocusController({ focus, exaggeration, curvature }: { focus: LodFocus; exaggeration: number; curvature: number }) {
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; update: () => void } | null
  const camera = useThree((s) => s.camera)
  const goal = useRef<{ target: THREE.Vector3; position: THREE.Vector3; frames: number } | null>(null)
  useEffect(() => {
    // o alvo fica na superfície curvada (no Malapert ela está ~4 km abaixo do plano)
    const target = new THREE.Vector3(...curvedPoint(focus.x_m / 1000, focus.y_m / 1000, focus.h_m / 1000, exaggeration, curvature))
    goal.current = { target, position: target.clone().add(new THREE.Vector3(-6, 12, 16)), frames: 70 }
  }, [focus.key, focus.x_m, focus.y_m, focus.h_m, exaggeration, curvature])
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => { invalidate() }, [focus.key, invalidate]) // dispara o primeiro quadro do voo
  useFrame(() => {
    const g = goal.current
    if (!g || !controls) return
    controls.target.lerp(g.target, 0.1)
    camera.position.lerp(g.position, 0.1)
    controls.update()
    if (--g.frames <= 0) goal.current = null
    else invalidate() // render sob demanda: pede o próximo quadro enquanto o voo dura
  })
  return null
}

export function TerrainLOD3D({ meta, exaggeration, curvature, analytic, sun, earth, marker, focus, debugLevels, onStats, onClickMap }: {
  meta: TileMeta
  exaggeration: number
  curvature: number
  analytic: AnalyticSpec | null
  sun?: BodyDirection
  earth?: BodyDirection
  marker?: { x_m: number; y_m: number; h_m: number } | null
  focus?: LodFocus | null
  debugLevels: boolean
  onStats?: (s: LodStats) => void
  onClickMap?: (x_m: number, y_m: number) => void
}) {
  return (
    <div className="relative h-full">
      {(sun || earth) && (
        <div className="pointer-events-none absolute top-3 left-3 z-10 space-y-1 rounded-md bg-space-950/85 px-2.5 py-1.5 text-xs text-slate-300 backdrop-blur">
          {sun && <BodyLegend color="bg-sun-300 shadow-sun-400" name="Sol" elevation={sun.elevation_deg} />}
          {earth && <BodyLegend color="bg-ice-400 shadow-ice-400" name="Terra" elevation={earth.elevation_deg} />}
          <div className="text-[10.5px] text-slate-500">vistos do polo · setas com elevação ampliada (×3) para visualização</div>
        </div>
      )}
      {/* frameloop="demand": só redesenha quando câmera, tiles ou voo mudam — parada, a cena não gasta CPU/GPU */}
      <Canvas frameloop="demand" camera={{ position: HOME.position.toArray(), fov: 42, near: 0.05, far: 6000 }} dpr={[1, 2]}>
        <color attach="background" args={['#07090e']} />
        <fog attach="fog" args={['#07090e', 900, 2600]} />
        <ambientLight intensity={1.1} />
        <directionalLight position={[-300, 300, 120]} intensity={1.4} />
        <QuadtreeTerrain meta={meta} exaggeration={exaggeration} curvature={curvature} analytic={analytic} debugLevels={debugLevels}
                         onStats={onStats} onClickMap={onClickMap} />
        {sun && <BodyIndicator body={sun} radiusKm={33} color="#ffd68a" size={1.1} />}
        {earth && <BodyIndicator body={earth} radiusKm={30} color="#40c8ff" size={2.2} />}
        {marker && (
          // haste radial: de 1 km abaixo a 5 km acima do ponto, ao longo da vertical local (curvada)
          <Line points={[curvedPoint(marker.x_m / 1000, marker.y_m / 1000, marker.h_m / 1000 - 1 / exaggeration, exaggeration, curvature),
                         curvedPoint(marker.x_m / 1000, marker.y_m / 1000, marker.h_m / 1000 + 5 / exaggeration, exaggeration, curvature)]}
                color="#7dff7a" lineWidth={2} />
        )}
        {focus && <FocusController focus={focus} exaggeration={exaggeration} curvature={curvature} />}
        <OrbitControls makeDefault target={HOME.target.toArray()} maxPolarAngle={Math.PI / 2.05} minDistance={0.3}
                       maxDistance={1400} enableDamping />
      </Canvas>
    </div>
  )
}
