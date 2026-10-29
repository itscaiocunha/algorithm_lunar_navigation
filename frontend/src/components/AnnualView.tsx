import { Antenna, Box, Map as MapIcon, Mountain, Scale, Snowflake, Sparkles, Sun, Terminal } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import type { Annual, AnnualMetric, Basemap, Peak, Terrain, Weights } from '../lib/api'
import { fmt } from '../lib/geo'
import { cx, initialViewState, type ViewState } from '../lib/view'
import { MapView2D, type MapPoint } from './MapView2D'
import { Terrain3D } from './Terrain3D'
import { Card, KeyValue, Kpi, Segmented } from './ui'

const PEAK_COLOR: [number, number, number] = [125, 255, 122]

// mesmas escalas de cores do backend (matplotlib)
const GRADIENTS: Record<Annual['metric']['colormap'], string> = {
  viridis: 'linear-gradient(90deg, #440154, #3b528b, #21918c, #5ec962, #fde725)',
  inferno: 'linear-gradient(90deg, #000004, #420a68, #932667, #dd513a, #fca50a, #fcffa4)',
  cividis: 'linear-gradient(90deg, #00204d, #414d6b, #7c7b78, #bcaf6f, #ffea46)',
}

const METRICS: { value: AnnualMetric; label: ReactNode }[] = [
  { value: 'score', label: <><Scale className="size-3.5" /> Pontuação</> },
  { value: 'golden_window', label: <><Sparkles className="size-3.5" /> Janela</> },
  { value: 'golden_pct', label: <>Ouro %</> },
  { value: 'illumination_pct', label: <><Sun className="size-3.5" /> Sol %</> },
  { value: 'earth_pct', label: <><Antenna className="size-3.5" /> Terra %</> },
]

const days = (h: number) => fmt(h / 24, 1)
const signedScore = (v: number) => `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v), 3)}`

const PRESETS: { label: string; w: Weights; hint: string }[] = [
  { label: 'Equilibrado', w: { a: 1, b: 1, c: 1 }, hint: 'janela, ouro e apagão com o mesmo peso' },
  { label: 'Sobrevivência', w: { a: 1, b: 1, c: 2 }, hint: 'apagões (bateria, autonomia) pesam o dobro' },
  { label: 'Só janela', w: { a: 1, b: 0, c: 0 }, hint: 'reproduz o ranking antigo (satura em ~17 d)' },
]

export function AnnualView({ year, basemap, terrain, requestTerrain }: {
  year: number
  basemap: Basemap
  terrain: Terrain | null
  requestTerrain: () => void
}) {
  const [metric, setMetric] = useState<AnnualMetric>('score')
  const [weights, setWeights] = useState<Weights>({ a: 1, b: 1, c: 1 })
  const [annual, setAnnual] = useState<Annual | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'2d' | '3d'>('2d')
  const [selected, setSelected] = useState<number>(1)
  const [viewState, setViewState] = useState<ViewState>(() => initialViewState(basemap.bounds, window.innerHeight - 190))

  // re-ranqueamento no servidor (~0,2 s); debounce enquanto o usuário arrasta os pesos
  useEffect(() => {
    let alive = true
    const id = setTimeout(() => {
      api.annual(year, metric, weights)
        .then((a) => { if (alive) { setAnnual(a); setError(null) } })
        .catch((e) => alive && setError(e.message))
    }, 250)
    return () => { alive = false; clearTimeout(id) }
  }, [year, metric, weights])
  useEffect(() => { if (view === '3d') requestTerrain() }, [view, requestTerrain])

  if (error && !annual) return <MissingAnnual message={error} />
  if (!annual) return <div className="p-10 text-sm text-slate-500">Carregando análise anual…</div>

  // o resultado exibido ainda não corresponde aos pesos/métrica escolhidos
  const refreshing = annual.metric.id !== metric || annual.weights.a !== weights.a || annual.weights.b !== weights.b
    || annual.weights.c !== weights.c
  const peak = annual.peaks.find((p) => p.rank === selected) ?? annual.peaks[0]
  const points: MapPoint[] = annual.peaks.map((p) => ({
    id: String(p.rank), x_m: p.x_m, y_m: p.y_m, color: PEAK_COLOR, label: String(p.rank), selected: p.rank === selected,
  }))
  const m = annual.metric

  return (
    <div className="grid h-full grid-cols-[400px_1fr] gap-5">
      <aside className="space-y-4 overflow-y-auto pr-1 pb-4">
        <Card>
          <h2 className="text-lg font-semibold text-slate-100">Candidatos a pouso · {annual.year}</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-slate-400">
            Sozinha, a <b className="text-emerald-300">maior janela de ouro</b> satura em ~17 dias (teto da libração) e não separa os
            candidatos. A pontuação composta pondera também a <b>fração de ouro</b> e penaliza o <b>pior apagão contínuo</b> — noite
            (bateria) ou perda de sinal (autonomia), o que vier primeiro.
          </p>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Kpi value={<span className="text-emerald-300">{fmt(annual.stats.max_golden_window_d, 1)} d</span>} label="maior janela de ouro" />
            <Kpi value={fmt(annual.stats.golden_7d_km2, 1)} label="km² com janela ≥ 7 dias" />
            <Kpi value={fmt(annual.stats.psr_km2, 0)} label="km² sem Sol no ano" tone="ice" />
          </div>
          <p className="tabular mt-3 text-[11px] text-slate-500">
            {annual.meta.n_samples} instantes · {annual.meta.start_utc.slice(0, 10)} a {annual.meta.end_utc.slice(0, 10)} · a cada{' '}
            {annual.meta.step_hours} h (resolução das janelas)
          </p>
        </Card>

        <WeightsCard weights={weights} setWeights={setWeights} refreshing={refreshing} />

        <Card title="Melhores locais" icon={<Mountain className="size-4" />}>
          <table className="tabular w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-space-700 text-left text-[11px] text-slate-500">
                <th className="py-1.5 font-medium">#</th><th className="font-medium">Score</th><th className="font-medium">Janela</th>
                <th className="font-medium">Ouro</th><th className="font-medium">Apagão</th><th className="font-medium">PSR</th>
              </tr>
            </thead>
            <tbody>
              {annual.peaks.map((p) => (
                <tr key={p.rank} onClick={() => setSelected(p.rank)}
                    className={cx('cursor-pointer border-b border-space-800 transition',
                      p.rank === selected ? 'bg-peak-400/10 text-slate-100' : 'text-slate-300 hover:bg-space-800')}>
                  <td className="py-1.5 font-semibold text-peak-400">{p.rank}</td>
                  <td className="font-semibold text-emerald-300">{signedScore(p.score)}</td>
                  <td>{days(p.longest_golden_h)} d</td>
                  <td>{fmt(p.golden_pct, 0)}%</td>
                  <td>{days(p.worst_outage_h)} d</td>
                  <td>{fmt(p.distance_to_psr_km, 1)} km</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-slate-500">Ordenados pela pontuação composta. Apagão = max(maior noite, maior LOS). Clique para localizar.</p>
        </Card>

        {peak && <PeakDetail peak={peak} />}

        <Card title="Como ler">
          <div className="h-2.5 rounded-full" style={{ background: GRADIENTS[m.colormap] }} />
          <div className="mt-1 flex justify-between text-[11px] text-slate-500">
            <span>{fmt(m.vmin, m.id === 'score' ? 1 : 0)}</span><span>{m.label}</span><span>{fmt(m.vmax, m.id === 'score' ? 1 : 0)} {m.unit}</span>
          </div>
          <ul className="mt-3 space-y-1.5 text-[12.5px] leading-relaxed text-slate-300">
            <li><Snowflake className="mr-1 inline size-3.5 text-ice-400" /><b className="text-ice-400">Ciano</b> = sem Sol em todo o período:
              candidata a <b>sombra permanente</b> (armadilha fria de gelo).</li>
            <li><span className="mr-1 inline-block size-2.5 rounded-full border-2 border-peak-400" />Círculos verdes = melhores locais,
              separados ≥ 1,5 km.</li>
            <li><b>Maior noite</b> dimensiona baterias; <b>maior LOS</b> dimensiona a autonomia sem comando da Terra.</li>
          </ul>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            Um ano não é um ciclo completo: a geometria Sol–Terra–Lua se repete a cada ~18,6 anos.
          </p>
        </Card>
      </aside>

      <section className="flex min-h-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented value={view} onChange={setView} options={[
            { value: '2d', label: <><MapIcon className="size-3.5" /> Mapa</> },
            { value: '3d', label: <><Box className="size-3.5" /> Relevo 3D</> },
          ]} />
          <Segmented value={metric} onChange={setMetric} options={METRICS} />
          <span className="ml-auto text-xs text-slate-500">Clique num local para selecioná-lo</span>
        </div>
        <div className="relative min-h-0 flex-1">
          {view === '2d' ? (
            <MapView2D overlays={[{ id: `annual-${m.id}`, image: annual.image, bounds: annual.bounds }]} points={points}
                       viewState={viewState} onViewStateChange={setViewState}
                       onClickMap={(_x, _y, id) => id && setSelected(Number(id))}
                       caption={`${m.label} · ${annual.year} · ciano = sombra o ano todo`} />
          ) : (
            <div className="h-full overflow-hidden rounded-xl border border-space-700">
              {terrain ? (
                <Terrain3D terrain={terrain} baseUrl={basemap.image} layers={[{ url: annual.image, alpha: 0.85 }]} exaggeration={3}
                           marker={peak && { x_m: peak.x_m, y_m: peak.y_m }} />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-500">Carregando relevo…</div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function PeakDetail({ peak: p }: { peak: Peak }) {
  return (
    <Card title={`Local #${p.rank} · score ${signedScore(p.score)}`} icon={<Sparkles className="size-4" />}>
      <ScoreBreakdown terms={p.score_terms} />
      <KeyValue rows={[
        ['Lat / lon', `${fmt(p.lat, 4)}° / ${fmt(p.lon, 2)}°`],
        ['Altitude', `${fmt(p.height_m, 0)} m`],
        ['Maior janela Sol + Terra', `${days(p.longest_golden_h)} dias`],
        ['Tempo em Zona de Ouro', `${fmt(p.golden_pct, 1)}%`],
        ['Tempo com Sol (disco)', `${fmt(p.illumination_pct, 1)}%`],
        ['Tempo com Terra visível', `${fmt(p.any_earth_pct, 1)}%`],
        ['Maior noite contínua', `${days(p.longest_night_h)} dias`],
        ['Maior perda de sinal (LOS)', `${days(p.longest_los_h)} dias`],
        ['Sombra permanente mais próxima', `${fmt(p.distance_to_psr_km, 2)} km`],
      ]} />
    </Card>
  )
}

function MissingAnnual({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <Card className="max-w-lg" title="Análise anual não encontrada" icon={<Terminal className="size-4" />}>
        <p className="text-sm text-slate-400">{message}</p>
        <pre className="mt-3 rounded-lg bg-space-950 p-3 font-mono text-[13px] text-slate-200">python scripts\mapa_anual.py</pre>
      </Card>
    </div>
  )
}

function WeightsCard({ weights, setWeights, refreshing }: {
  weights: Weights; setWeights: (w: Weights) => void; refreshing: boolean
}) {
  const sliders: { key: keyof Weights; label: string; tone: string }[] = [
    { key: 'a', label: 'A · maior janela de ouro', tone: 'accent-emerald-400' },
    { key: 'b', label: 'B · fração anual de ouro', tone: 'accent-emerald-400' },
    { key: 'c', label: 'C · pior apagão (noite ou LOS)', tone: 'accent-rose-400' },
  ]
  return (
    <Card title={<>Pesos da pontuação {refreshing && <span className="ml-auto text-[11px] font-normal text-slate-500">re-ranqueando…</span>}</>}
          icon={<Scale className="size-4" />}>
      <div className="rounded-lg bg-space-950/70 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-slate-300">
        Score = <span className="text-emerald-300">A</span>·janela/T + <span className="text-emerald-300">B</span>·ouro
        − <span className="text-rose-300">C</span>·apagão/T
        <div className="text-[10.5px] text-slate-500">T = 29,53 d (mês sinódico): termos adimensionais, ~0..1</div>
      </div>
      <div className="mt-3 space-y-2.5">
        {sliders.map((s) => (
          <label key={s.key} className="block text-xs text-slate-400">
            <span className="flex justify-between">{s.label}<b className="tabular text-slate-200">{fmt(weights[s.key], 1)}</b></span>
            <input type="range" min={0} max={3} step={0.1} value={weights[s.key]}
                   onChange={(e) => setWeights({ ...weights, [s.key]: +e.target.value })} className={cx('w-full', s.tone)} />
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const on = p.w.a === weights.a && p.w.b === weights.b && p.w.c === weights.c
          return (
            <button key={p.label} title={p.hint} onClick={() => setWeights(p.w)}
                    className={cx('rounded-md border px-2 py-1 text-[11.5px] transition',
                      on ? 'border-emerald-400/60 bg-emerald-400/10 text-emerald-300' : 'border-space-700 text-slate-400 hover:text-slate-200')}>
              {p.label}
            </button>
          )
        })}
      </div>
    </Card>
  )
}

/** Barras dos três termos ponderados (positivos à direita, penalidade à esquerda). */
function ScoreBreakdown({ terms }: { terms: Peak['score_terms'] }) {
  const rows: [string, number, string][] = [
    ['Janela de ouro', terms.window, 'bg-emerald-400'],
    ['Fração de ouro', terms.golden, 'bg-emerald-300/70'],
    ['Pior apagão', terms.outage, 'bg-rose-400'],
  ]
  const scale = Math.max(1, ...rows.map(([, v]) => Math.abs(v)))
  return (
    <div className="mb-3 space-y-1">
      {rows.map(([label, v, color]) => (
        <div key={label} className="grid grid-cols-[96px_1fr_52px] items-center gap-2 text-[11.5px]">
          <span className="text-slate-400">{label}</span>
          <div className="relative h-2 rounded-full bg-space-800">
            <div className="absolute top-0 left-1/2 h-full w-px bg-slate-600" />
            <div className={cx('absolute top-0 h-full rounded-full', color)}
                 style={{ width: `${(Math.abs(v) / scale) * 50}%`, left: v >= 0 ? '50%' : `${50 - (Math.abs(v) / scale) * 50}%` }} />
          </div>
          <span className="tabular text-right text-slate-300">{signedScore(v)}</span>
        </div>
      ))}
    </div>
  )
}
