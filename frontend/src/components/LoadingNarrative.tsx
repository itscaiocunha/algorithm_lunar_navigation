import { CheckCircle2, Circle, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MapMode } from '../lib/api'
import { fmt } from '../lib/geo'
import { cx } from '../lib/view'

// Etapas do pipeline, com a fração aproximada do tempo total em que cada uma termina.
const STEPS: [string, string, number][] = [
  ['SPICE', 'Posições aparentes do Sol e da Terra no referencial MOON_ME (DE440, LT+S)', 0.02],
  ['Raios', '2 × 562 500 raios — um por pixel até o Sol e outro até a Terra', 0.06],
  ['Marcha', 'Todos os raios avançam juntos, até ~400 passos sobre o relevo LOLA', 0.72],
  ['Oclusão', 'Cada passo compara o raio com a altitude, incluindo a curvatura lunar', 0.93],
  ['Discos', 'Fração visível do Sol (0,5°) e da Terra (~1,9°) → Zona de Ouro', 1],
]

export function LoadingNarrative({ mode, expectedSeconds }: { mode: MapMode; expectedSeconds: number }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const t0 = performance.now()
    const id = setInterval(() => setElapsed((performance.now() - t0) / 1000), 100)
    return () => clearInterval(id)
  }, [])
  const progress = Math.min(elapsed / expectedSeconds, 0.97)

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-space-950/88 p-6 backdrop-blur-sm">
      <div className="w-full max-w-lg">
        <div className="flex items-baseline justify-between">
          <div className="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase">
            {mode === 'completo' ? 'Ray-casting completo' : 'Mapa de horizontes'}
          </div>
          <div className="tabular text-4xl font-bold text-sun-400">{fmt(elapsed, 1)} s</div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-space-700">
          <div className="h-full rounded-full bg-gradient-to-r from-sun-400 to-sun-500 transition-[width] duration-200"
               style={{ width: `${progress * 100}%` }} />
        </div>
        <ol className="mt-5 space-y-2.5">
          {STEPS.map(([title, text, end], i) => {
            const start = i === 0 ? 0 : STEPS[i - 1][2]
            const state = progress >= end ? 'done' : progress >= start ? 'active' : 'todo'
            return (
              <li key={title} className={cx('flex gap-3 text-sm transition-colors', state === 'todo' ? 'text-slate-600' : 'text-slate-200')}>
                {state === 'done' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                  : state === 'active' ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-sun-400" />
                  : <Circle className="mt-0.5 size-4 shrink-0" />}
                <span><b className="font-semibold">{title}.</b> {text}</span>
              </li>
            )
          })}
        </ol>
        <p className="mt-5 text-xs leading-relaxed text-slate-500">
          Pixel a pixel, este cálculo levaria ~33 horas em Python. Vetorizado com NumPy, cada passo é uma única
          operação sobre meio milhão de raios.
        </p>
      </div>
    </div>
  )
}
