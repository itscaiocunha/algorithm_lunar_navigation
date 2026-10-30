import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, type RefObject } from 'react'
import * as THREE from 'three'
import type { PlaybackClock } from '../hooks/usePlayback'
import type { EphemerisSeries, SkyTrack } from '../lib/api'
import { curvedPoint, localUp } from '../lib/curvature'
import { sampleAngleDeg, sampleLinear, stateAt, type PointTimeline } from '../lib/timeline'

// Sol e Terra animados a 60 fps: a cada quadro do three.js lê o relógio (ref, sem React) e interpola a
// série de efemérides. Com um ponto selecionado, as setas saem DELE, na vertical local (curvatura),
// e a visibilidade vem da linha do tempo do pixel: a Terra apaga e a visada fica vermelha no LOS.

const BODY = {
  sun: { color: '#ffd68a', size: 1.1, radius: 33 },
  earth: { color: '#40c8ff', size: 2.2, radius: 30 },
} as const
const BLOCKED = new THREE.Color('#f43f5e')
const Y = new THREE.Vector3(0, 1, 0)

function useBody(kind: keyof typeof BODY) {
  const b = BODY[kind]
  return useMemo(() => {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(b.size, 24, 24), new THREE.MeshBasicMaterial({ color: b.color, transparent: true }))
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: b.color, dashSize: 1.2, gapSize: 0.8, transparent: true }))
    return { sphere, line, color: new THREE.Color(b.color), radius: b.radius }
  }, [b])
}

export function AnimatedSky({ series, timeline, clock, tick, anchor, exaggeration, curvature }: {
  series: EphemerisSeries
  timeline: PointTimeline | null
  clock: RefObject<PlaybackClock>
  tick: number // muda ao pausar/arrastar o scrubber: pede um quadro (render sob demanda)
  anchor: { x_m: number; y_m: number; h_m: number } | null
  exaggeration: number
  curvature: number
}) {
  const sun = useBody('sun')
  const earth = useBody('earth')
  const light = useMemo(() => new THREE.DirectionalLight('#fff4e0', 1.4), [])
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => { invalidate() }, [tick, anchor, exaggeration, curvature, invalidate])
  useEffect(() => () => {
    for (const b of [sun, earth]) {
      b.sphere.geometry.dispose(); (b.sphere.material as THREE.Material).dispose()
      b.line.geometry.dispose(); (b.line.material as THREE.Material).dispose()
    }
  }, [sun, earth])

  const tmp = useMemo(() => ({ origin: new THREE.Vector3(), up: new THREE.Vector3(), dir: new THREE.Vector3(),
                                tip: new THREE.Vector3(), q: new THREE.Quaternion() }), [])

  useFrame(() => {
    const t = clock.current.tS
    const step = series.step_s
    const p = anchor && series.point ? series.point : null
    const { origin, up, dir, tip, q } = tmp
    if (p) {
      origin.set(...curvedPoint(p.x_m / 1000, p.y_m / 1000, p.height_m / 1000, exaggeration, curvature))
      up.set(...localUp(p.x_m / 1000, p.y_m / 1000, curvature))
    } else {
      origin.set(0, 0.3, 0)
      up.copy(Y)
    }
    q.setFromUnitVectors(Y, up)

    for (const [key, b] of [['sun', sun], ['earth', earth]] as const) {
      const track: SkyTrack = p ? p[key] : series.center[key]
      const el = sampleLinear(track.elevation_deg, step, t)
      const az = THREE.MathUtils.degToRad(sampleAngleDeg(track.map_az_deg, step, t))
      // azimute do mapa (horário a partir de +y) -> cena (x, 0, −y), girado para a vertical local
      dir.set(Math.sin(az), 0, -Math.cos(az)).applyQuaternion(q)
      const above = el > 0
      const height = above ? b.radius * Math.tan(THREE.MathUtils.degToRad(Math.min(el * 3, 40))) + 1.5 : 0.6
      tip.copy(origin).addScaledVector(dir, b.radius).addScaledVector(up, height)
      b.sphere.position.copy(tip)
      b.line.geometry.setFromPoints([origin, tip])
      b.line.computeLineDistances()

      // visível? no ponto: linha do tempo (bisseção); sem ponto: acima do horizonte ideal
      let visible = above, partial = false
      if (p && timeline) {
        visible = stateAt(timeline[key].initial, timeline[key].events, t)
        partial = key === 'earth' && visible && !stateAt(timeline.earthFull.initial, timeline.earthFull.events, t)
      }
      const sm = b.sphere.material as THREE.MeshBasicMaterial
      const lm = b.line.material as THREE.LineDashedMaterial
      sm.opacity = visible ? (partial ? 0.55 : 1) : 0.12
      lm.color.copy(visible ? b.color : BLOCKED)
      lm.opacity = visible ? 1 : 0.9

      if (key === 'sun') {
        // a luz da cena acompanha o Sol (elevação ampliada como a seta, para o relevo continuar legível)
        const lightEl = THREE.MathUtils.degToRad(Math.max(4, Math.min(el * 3, 40)))
        light.position.copy(origin).addScaledVector(dir, 300 * Math.cos(lightEl)).addScaledVector(up, 300 * Math.sin(lightEl))
        light.target.position.copy(origin)
        light.target.updateMatrixWorld()
      }
    }
    if (clock.current.playing) invalidate() // tocando: um quadro por vsync; parado: nada
  })

  return (
    <>
      <primitive object={light} />
      <primitive object={light.target} />
      <primitive object={sun.sphere} />
      <primitive object={sun.line} />
      <primitive object={earth.sphere} />
      <primitive object={earth.line} />
    </>
  )
}
