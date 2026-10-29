import { Box, Map as MapIcon, Mountain, Snowflake, Sun, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Annual, Basemap, Peak, Terrain } from '../lib/api'
import { fmt } from '../lib/geo'
import { initialViewState, type ViewState, cx } from '../lib/view'
import { MapView2D, type MapPoint } from './MapView2D'
import { Terrain3D } from './Terrain3D'
import { Card, InfernoLegend, KeyValue, Kpi, Segmented } from './ui'

const PEAK_COLOR: [number, number, number] = [125, 255, 122]

export function AnnualView({ annual, error, basemap, terrain, requestTerrain }: {
  annual: Annual | null
  error: string | null
  basemap: Basemap
  terrain: Terrain | null
  requestTerrain: () => void
}) {
  const [view, setView] = useState<'2d' | '3d'>('2d')
  const [selected, setSelected] = useState<number>(1)
  const [viewState, setViewState] = useState<ViewState>(() => initialViewState(basemap.bounds, window.innerHeight - 190))

  useEffect(() => { if (view === '3d') requestTerrain() }, [view, requestTerrain])

  if (error) return <MissingAnnual message={error} />
  if (!annual) return <div className="p-10 text-sm text-slate-500">Carregando análise anual…</div>

  const peak = annual.peaks.find((p) => p.rank === selected) ?? annual.peaks[0]
  const points: MapPoint[] = annual.peaks.map((p) => ({
    id: String(p.rank), x_m: p.x_m, y_m: p.y_m, color: PEAK_COLOR, label: String(p.rank), selected: p.rank === selected,
  }))

  return (
    <div className="grid h-full grid-cols-[380px_1fr] gap-5">
      <aside className="space-y-4 overflow-y-auto pr-1 pb-4">
        <Card>
          <h2 className="text-lg font-semibold text-slate-100">Picos da Luz Eterna · {annual.year}</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-slate-400">
            Um local de pouso Artemis ideal tem <b className="text-sun-300">Sol quase contínuo</b> (energia e temperatura estável)
            e fica <b className="text-ice-400">perto de sombra permanente</b>, onde o gelo de água pode estar preso.
          </p>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Kpi value={`${fmt(annual.stats.max_illumination_pct, 1)}%`} label="melhor pixel" />
            <Kpi value={fmt(annual.stats.over_50pct_km2, 1)} label="km² com Sol > 50%" />
            <Kpi value={fmt(annual.stats.psr_km2, 0)} label="km² sem Sol no ano" tone="ice" />
          </div>
          <p className="tabular mt-3 text-[11px] text-slate-500">
            {annual.meta.n_samples} instantes · {annual.meta.start_utc.slice(0, 10)} a {annual.meta.end_utc.slice(0, 10)} ·
            a cada {annual.meta.step_hours} h
          </p>
        </Card>

        <Card title="Melhores pontos" icon={<Mountain className="size-4" />}>
          <table className="tabular w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-space-700 text-left text-[11px] text-slate-500">
                <th className="py-1.5 font-medium">#</th><th className="font-medium">Luz</th>
                <th className="font-medium">Maior noite</th><th className="font-medium">Até a sombra</th>
              </tr>
            </thead>
            <tbody>
              {annual.peaks.map((p) => (
                <tr key={p.rank} onClick={() => setSelected(p.rank)}
                    className={cx('cursor-pointer border-b border-space-800 transition',
                      p.rank === selected ? 'bg-peak-400/10 text-slate-100' : 'text-slate-300 hover:bg-space-800')}>
                  <td className="py-1.5 font-semibold text-peak-400">{p.rank}</td>
                  <td>{fmt(p.illumination_pct, 1)}%</td>
                  <td>{fmt(p.longest_night_h / 24, 1)} d</td>
                  <td>{fmt(p.distance_to_psr_km, 1)} km</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {peak && <PeakDetail peak={peak} />}

        <Card title="Como ler">
          <InfernoLegend left="0%" middle="50%" right="100% do tempo com Sol" />
          <ul className="mt-3 space-y-1.5 text-[12.5px] leading-relaxed text-slate-300">
            <li><Sun className="mr-1 inline size-3.5 text-sun-400" />Cor = % do tempo com Sol (média do disco visível).</li>
            <li><Snowflake className="mr-1 inline size-3.5 text-ice-400" /><b className="text-ice-400">Ciano</b> = sem Sol em todo o
              período: candidata a <b>sombra permanente</b> (armadilha fria).</li>
            <li><span className="mr-1 inline-block size-2.5 rounded-full border-2 border-peak-400" />Círculos verdes = máximos locais
              de iluminação, separados ≥ 1,5 km.</li>
            <li><b>Maior noite</b>: maior intervalo contínuo sem Sol — dimensiona baterias.</li>
          </ul>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            Um ano não é um ciclo completo: a geometria Sol–Lua se repete a cada ~18,6 anos.
          </p>
        </Card>
      </aside>

      <section className="flex min-h-0 flex-col gap-3">
        <div className="flex items-center gap-3">
          <Segmented value={view} onChange={setView} options={[
            { value: '2d', label: <><MapIcon className="size-3.5" /> Mapa</> },
            { value: '3d', label: <><Box className="size-3.5" /> Relevo 3D</> },
          ]} />
          <span className="ml-auto text-xs text-slate-500">Clique num pico para selecioná-lo</span>
        </div>
        <div className="relative min-h-0 flex-1">
          {view === '2d' ? (
            <MapView2D overlays={[{ id: 'annual', image: annual.image, bounds: annual.bounds }]} points={points}
                       viewState={viewState} onViewStateChange={setViewState}
                       onClickMap={(_x, _y, id) => id && setSelected(Number(id))}
                       caption={`Iluminação solar ${annual.year} · ciano = sombra o ano todo`} />
          ) : (
            <div className="h-full overflow-hidden rounded-xl border border-space-700">
              {terrain ? (
                <Terrain3D terrain={terrain} baseUrl={basemap.image} textureUrl={annual.image} exaggeration={3} marker={peak && { x_m: peak.x_m, y_m: peak.y_m }} />
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
    <Card title={`Pico #${p.rank}`} icon={<Sun className="size-4" />}>
      <KeyValue rows={[
        ['Lat / lon', `${fmt(p.lat, 4)}° / ${fmt(p.lon, 2)}°`],
        ['Altitude', `${fmt(p.height_m, 0)} m`],
        ['Tempo com Sol (disco)', `${fmt(p.illumination_pct, 1)}%`],
        ['Algum Sol visível', `${fmt(p.any_sun_pct, 1)}%`],
        ['Maior noite contínua', `${fmt(p.longest_night_h / 24, 1)} dias`],
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
