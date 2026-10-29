import { Box, Clock, Columns2, Download, Gauge, Grid3x3, Info as InfoIcon, Map as MapIcon, Play, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ServerUnavailableError } from '../lib/api'
import type { Basemap, IlluminationMap, Info, MapMode, PointIllumination, Terrain } from '../lib/api'
import { addHours, fmt, mapToLatLon, toUtcIso } from '../lib/geo'
import { LoadingNarrative } from './LoadingNarrative'
import { initialViewState, type ViewState, cx } from '../lib/view'
import { MapView2D, type Overlay } from './MapView2D'
import { PointCard } from './PointCard'
import { Terrain3D } from './Terrain3D'
import { Card, InfernoLegend, Kpi, Segmented, SectionLabel } from './ui'

type ViewMode = '2d' | 'compare' | '3d'

export function InstantView({ info, basemap, terrain, requestTerrain, onServerDown }: {
  info: Info
  basemap: Basemap
  terrain: Terrain | null
  requestTerrain: () => void
  onServerDown: (reason: string) => void
}) {
  const [utc, setUtc] = useState('2026-11-20T00:00:00')
  const [mode, setMode] = useState<MapMode>('completo')
  const [map, setMap] = useState<IlluminationMap | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFullSeconds, setLastFullSeconds] = useState(10)
  const [view, setView] = useState<ViewMode>('2d')
  const [opacity, setOpacity] = useState(0.85)
  const [grid, setGrid] = useState(true)
  const [exaggeration, setExaggeration] = useState(3)
  const [viewState, setViewState] = useState<ViewState>(() => initialViewState(basemap.bounds, window.innerHeight - 190))
  const [pointXY, setPointXY] = useState<{ x_m: number; y_m: number } | null>(null)
  const [point, setPoint] = useState<PointIllumination | null>(null)
  const [pointLoading, setPointLoading] = useState(false)
  const [pointError, setPointError] = useState<string | null>(null)
  const utcRef = useRef(utc)
  useEffect(() => { utcRef.current = utc }, [utc])

  const handleError = useCallback((e: unknown, set: (m: string) => void) => {
    if (e instanceof ServerUnavailableError) onServerDown('O servidor parou de responder (ele foi encerrado?).')
    else set(e instanceof Error ? e.message : String(e))
  }, [onServerDown])

  const queryPoint = useCallback(async (x_m: number, y_m: number) => {
    setPointXY({ x_m, y_m })
    setPointLoading(true)
    setPointError(null)
    const { lat, lon } = mapToLatLon(x_m, y_m)
    try {
      setPoint(await api.point(toUtcIso(utcRef.current), lat, lon))
    } catch (e) {
      setPoint(null)
      handleError(e, setPointError)
    } finally {
      setPointLoading(false)
    }
  }, [handleError])

  const run = useCallback(async (when = utcRef.current) => {
    setLoading(true)
    setError(null)
    try {
      const m = await api.map(toUtcIso(when), mode)
      setMap(m)
      if (m.mode === 'completo') setLastFullSeconds(m.elapsed_s)
      if (pointXY) void queryPoint(pointXY.x_m, pointXY.y_m)
    } catch (e) {
      handleError(e, setError)
    } finally {
      setLoading(false)
    }
  }, [mode, pointXY, queryPoint, handleError])

  const step = (hours: number) => {
    const next = addHours(utc, hours)
    setUtc(next)
    if (map && !loading) void run(next)
  }

  useEffect(() => { if (view === '3d') requestTerrain() }, [view, requestTerrain])

  const baseOverlay: Overlay = { id: 'base', image: basemap.image, bounds: basemap.bounds }
  const lightOverlay: Overlay | null = map && { id: 'light', image: map.image, bounds: map.bounds, opacity }
  const marker = pointXY ? [{ id: 'sel', ...pointXY, color: [125, 255, 122] as [number, number, number], selected: true }] : []
  const expected = mode === 'rapido' ? 0.6 : lastFullSeconds
  const geotiffUrl = map && `/api/map?${new URLSearchParams({ utc: map.utc, modo: map.mode, formato: 'geotiff' })}`

  return (
    <div className="grid h-full grid-cols-[360px_1fr] gap-5">
      <aside className="space-y-4 overflow-y-auto pr-1 pb-4">
        <Card>
          <SectionLabel>1 · Instante (UTC)</SectionLabel>
          <input type="datetime-local" step={1} value={utc} onChange={(e) => setUtc(e.target.value)}
                 className="tabular w-full rounded-lg border border-space-700 bg-space-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sun-400" />
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {[[-24, '−1 dia'], [-6, '−6 h'], [6, '+6 h'], [24, '+1 dia']].map(([h, label]) => (
              <button key={label} onClick={() => step(h as number)} disabled={loading}
                      className="rounded-md border border-space-700 bg-space-900 py-1.5 text-xs text-slate-300 transition hover:border-sun-400 hover:text-sun-300 disabled:opacity-40">
                {label}
              </button>
            ))}
          </div>

          <SectionLabel><span className="mt-5 block">2 · Método</span></SectionLabel>
          <div className="space-y-2">
            <ModeOption active={mode === 'completo'} onClick={() => setMode('completo')} icon={<Gauge className="size-4" />}
                        title="Ray-casting completo" badge={`~${fmt(lastFullSeconds, 0)} s`}
                        text="Traça um raio de cada um dos 562 500 pixels até o Sol." />
            <ModeOption active={mode === 'rapido'} disabled={!info.horizon_cache} onClick={() => setMode('rapido')}
                        icon={<Zap className="size-4" />} title="Mapa de horizontes" badge="< 1 s"
                        text={info.horizon_cache ? `Horizontes pré-calculados em ${info.n_azimuths} direções (validado: 99,8% igual).`
                          : 'Indisponível: rode scripts/mapa_anual.py para gerar o cache.'} />
          </div>

          <button onClick={() => void run()} disabled={loading}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-sun-400 to-sun-500 py-2.5 text-[15px] font-semibold text-space-950 shadow-lg shadow-sun-500/20 transition hover:brightness-110 disabled:cursor-progress disabled:opacity-60">
            <Play className="size-4 fill-current" /> {loading ? 'Calculando…' : 'Calcular iluminação'}
          </button>
          {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
        </Card>

        {map && (
          <Card title="Resultado" icon={<Clock className="size-4" />}>
            <div className="grid grid-cols-3 gap-2">
              <Kpi value={`${fmt(map.stats.lit_pct, 1)}%`} label="com Sol visível" />
              <Kpi value={`${fmt(map.stats.shadow_pct, 1)}%`} label="em sombra" tone="slate" />
              <Kpi value={`${fmt(map.stats.sun_elevation_min_deg, 1)}–${fmt(map.stats.sun_elevation_max_deg, 1)}°`} label="elevação do Sol" />
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-slate-300">
              {map.mode === 'completo' ? (
                <>Calculado em <b className="text-sun-300">{fmt(map.elapsed_s, 1)} s</b>: {map.pixels.toLocaleString('pt-BR')} raios
                  avançaram juntos por até <b>{map.steps} passos</b> — centenas de milhões de consultas ao relevo.</>
              ) : (
                <>Calculado em <b className="text-sun-300">{fmt(map.elapsed_s * 1000, 0)} ms</b>: elevação do Sol comparada com o
                  horizonte pré-calculado de cada pixel.</>
              )}
              {map.stats.sun_elevation_max_deg < 0.3 && ' O Sol está quase no horizonte: quase tudo fica escuro.'}
            </p>
            {geotiffUrl && (
              <a href={geotiffUrl} className="mt-3 inline-flex items-center gap-1.5 text-xs text-sun-300 hover:underline">
                <Download className="size-3.5" /> Baixar GeoTIFF (abre no QGIS)
              </a>
            )}
          </Card>
        )}

        {pointXY && <PointCard point={point} loading={pointLoading} error={pointError} />}

        <Card title="Como ler o mapa" icon={<InfoIcon className="size-4" />}>
          <InfernoLegend left="0 · sombra" middle="penumbra" right="1 · Sol inteiro" />
          <ul className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-slate-300">
            <li><b className="text-slate-100">Preto</b>: o relevo esconde o Sol. Perto do polo o Sol fica a ~1,5° do horizonte, então
              uma cratera ou montanha projeta sombras de <b>dezenas de km</b>.</li>
            <li><b className="text-sun-500">Laranja</b>: penumbra — só parte do disco solar (0,5°) aparece acima do relevo.</li>
            <li><b className="text-sun-300">Amarelo claro</b>: o disco solar inteiro está visível.</li>
            <li>O <b className="text-slate-100">fundo da cratera Shackleton</b> (o grande círculo ao lado do polo <span className="text-ice-400">○</span>)
              fica sempre escuro: é uma região de sombra permanente onde pode haver gelo de água.</li>
            <li><b className="text-slate-100">Clique no mapa</b> para traçar o raio de um único ponto.</li>
          </ul>
        </Card>
      </aside>

      <section className="flex min-h-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented value={view} onChange={setView} options={[
            { value: '2d', label: <><MapIcon className="size-3.5" /> Mapa</> },
            { value: 'compare', label: <><Columns2 className="size-3.5" /> Comparar</> },
            { value: '3d', label: <><Box className="size-3.5" /> Relevo 3D</> },
          ]} />
          {view !== '3d' && (
            <label className="flex items-center gap-2 text-xs text-slate-400">
              Opacidade da iluminação
              <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)} className="accent-sun-400" />
            </label>
          )}
          {view !== '3d' && (
            <button onClick={() => setGrid(!grid)}
                    className={cx('flex items-center gap-1.5 rounded-md px-2 py-1 text-xs', grid ? 'text-sun-300' : 'text-slate-500')}>
              <Grid3x3 className="size-3.5" /> Grade lat/lon
            </button>
          )}
          {view === '3d' && (
            <label className="flex items-center gap-2 text-xs text-slate-400">
              Exagero vertical {exaggeration}×
              <input type="range" min={1} max={6} step={0.5} value={exaggeration} onChange={(e) => setExaggeration(+e.target.value)} className="accent-sun-400" />
            </label>
          )}
          <span className="ml-auto text-xs text-slate-500">
            {map ? `Iluminação · ${map.utc.replace('T', ' ').replace('Z', ' UTC')}` : 'Escolha uma data e clique em Calcular'}
          </span>
        </div>

        <div className="relative min-h-0 flex-1">
          {view === '2d' && (
            <MapView2D overlays={lightOverlay ? [baseOverlay, lightOverlay] : [baseOverlay]} points={marker}
                       viewState={viewState} onViewStateChange={setViewState} onClickMap={queryPoint} showGrid={grid}
                       caption={map ? 'Relevo LOLA + iluminação' : 'Relevo LOLA (80 m/pixel)'} />
          )}
          {view === 'compare' && (
            <div className="grid h-full grid-cols-2 gap-3">
              <MapView2D overlays={[baseOverlay]} points={marker} viewState={viewState} onViewStateChange={setViewState}
                         onClickMap={queryPoint} showGrid={grid} caption="Relevo LOLA" />
              <MapView2D overlays={lightOverlay ? [{ ...lightOverlay, opacity: 1 }] : []} points={marker} viewState={viewState}
                         onViewStateChange={setViewState} onClickMap={queryPoint} showGrid={grid}
                         caption={map ? 'Iluminação' : 'Iluminação — calcule primeiro'} />
            </div>
          )}
          {view === '3d' && (
            <div className="h-full overflow-hidden rounded-xl border border-space-700">
              {terrain ? (
                <Terrain3D terrain={terrain} baseUrl={basemap.image} textureUrl={map?.image ?? basemap.image} exaggeration={exaggeration}
                           sun={map?.sun} marker={pointXY} onClickMap={queryPoint} />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-500">Carregando relevo…</div>
              )}
              <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-space-950/80 px-2.5 py-1 text-[11px] text-slate-400">
                Arraste para girar · role para zoom · botão direito para mover · relevo exagerado {exaggeration}×
              </div>
            </div>
          )}
          {loading && <LoadingNarrative mode={mode} expectedSeconds={expected} />}
        </div>
      </section>
    </div>
  )
}

function ModeOption({ active, disabled, onClick, icon, title, badge, text }: {
  active: boolean; disabled?: boolean; onClick: () => void; icon: ReactNode; title: string; badge: string; text: string
}) {
  return (
    <button onClick={onClick} disabled={disabled}
            className={cx('w-full rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-40',
              active ? 'border-sun-400/70 bg-sun-400/[0.07]' : 'border-space-700 hover:border-space-600')}>
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
        <span className={active ? 'text-sun-400' : 'text-slate-500'}>{icon}</span>
        {title}
        <span className="tabular ml-auto rounded bg-space-700 px-1.5 py-0.5 text-[11px] font-medium text-slate-300">{badge}</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">{text}</p>
    </button>
  )
}
