import { Antenna, Box, Clock, Columns2, Download, Gauge, Grid3x3, Info as InfoIcon, Layers, Map as MapIcon, Play, Sparkles, Sun, Zap } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { api, ServerUnavailableError, tilesApi } from '../lib/api'
import type { Basemap, Countdown, IlluminationMap, Info, MapMode, PointIllumination } from '../lib/api'
import type { TileMeta } from '../lib/quadtree'
import { addHours, fmt, latLonToMap, mapToLatLon, signed, toUtcIso } from '../lib/geo'
import { CUSTOM_ID, findPreset } from '../lib/presets'
import { COLORS, decodeUint8, fillLayer, hatchLayer, stateMasks } from '../lib/layers'
import { cx, initialViewState, type ViewState } from '../lib/view'
import { LoadingNarrative } from './LoadingNarrative'
import { MissionPresetPicker } from './MissionPresetPicker'
import { MapView2D, type HoverEvent, type Overlay } from './MapView2D'
import { PointCard } from './PointCard'
import { EngineeringTooltip } from './Telemetry'
import type { LodStats } from './QuadtreeTerrain'
import { TerrainLOD3D, type LodFocus } from './TerrainLOD3D'
import { Card, Kpi, Segmented, SectionLabel } from './ui'

type ViewMode = '2d' | 'compare' | '3d'
type XY = { x_m: number; y_m: number }

interface Layers {
  hatch: string // Terra visível (hachura ciano)
  golden: string // Sol E Terra (verde)
}

function useAnalyticLayers(map: IlluminationMap | null, showGolden: boolean): Layers | null {
  return useMemo(() => {
    if (!map) return null
    const [rows, cols] = map.shape
    const masks = stateMasks(decodeUint8(map.sun_fraction_b64), decodeUint8(map.earth_fraction_b64), showGolden)
    return { hatch: hatchLayer(masks.comms, cols, rows), golden: fillLayer(masks.golden, cols, rows, COLORS.golden) }
  }, [map, showGolden])
}

/** Telemetria do pixel sob o cursor: requisição com debounce e cancelamento da anterior. */
function useHoverTelemetry(utcRef: RefObject<string>, onServerDown: (r: string) => void) {
  const [hover, setHover] = useState<HoverEvent | null>(null)
  const [data, setData] = useState<PointIllumination | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!hover) return
    const ctrl = new AbortController()
    const id = setTimeout(async () => {
      setLoading(true)
      const { lat, lon } = mapToLatLon(hover.x_m, hover.y_m)
      try {
        setData(await api.point(toUtcIso(utcRef.current), lat, lon, ctrl.signal))
      } catch (e) {
        if (e instanceof ServerUnavailableError) onServerDown('O servidor parou de responder (ele foi encerrado?).')
        else if (!(e instanceof DOMException)) setData(null)
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    }, 140)
    return () => { clearTimeout(id); ctrl.abort() }
  }, [hover, utcRef, onServerDown])
  return { hover, setHover, data, loading }
}

export function InstantView({ info, basemap, onServerDown }: {
  info: Info
  basemap: Basemap
  onServerDown: (reason: string) => void
}) {
  const [utc, setUtc] = useState('2026-11-20T00:00:00')
  const [mode, setMode] = useState<MapMode>('completo')
  const [map, setMap] = useState<IlluminationMap | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastFullSeconds, setLastFullSeconds] = useState(30)
  const [view, setView] = useState<ViewMode>('2d')
  const [sunOpacity, setSunOpacity] = useState(0.85)
  const [showSun, setShowSun] = useState(true)
  const [showEarth, setShowEarth] = useState(true)
  const [showGolden, setShowGolden] = useState(true)
  const [grid, setGrid] = useState(true)
  const [exaggeration, setExaggeration] = useState(3)
  const [viewState, setViewState] = useState<ViewState>(() => initialViewState(basemap.bounds, window.innerHeight - 190))
  const [pointXY, setPointXY] = useState<XY | null>(null)
  const [point, setPoint] = useState<PointIllumination | null>(null)
  const [pointLoading, setPointLoading] = useState(false)
  const [pointError, setPointError] = useState<string | null>(null)
  const [countdown, setCountdown] = useState<Countdown | null>(null)
  const [countdownLoading, setCountdownLoading] = useState(false)
  const countdownCtrl = useRef<AbortController | null>(null)
  const [presetId, setPresetId] = useState(CUSTOM_ID)
  const [focus3d, setFocus3d] = useState<LodFocus | null>(null)
  const [tileMeta, setTileMeta] = useState<TileMeta | null>(null)
  const [lodStats, setLodStats] = useState<LodStats | null>(null)
  const [debugLevels, setDebugLevels] = useState(false)
  const utcRef = useRef(utc)
  useEffect(() => { utcRef.current = utc }, [utc])
  const tooltip = useHoverTelemetry(utcRef, onServerDown)
  const layers = useAnalyticLayers(map, showGolden)

  const handleError = useCallback((e: unknown, set: (m: string) => void) => {
    if (e instanceof ServerUnavailableError) onServerDown('O servidor parou de responder (ele foi encerrado?).')
    else set(e instanceof Error ? e.message : String(e))
  }, [onServerDown])

  const queryCountdown = useCallback(async (lat: number, lon: number) => {
    countdownCtrl.current?.abort() // clique em outro ponto cancela a busca anterior
    const ctrl = new AbortController()
    countdownCtrl.current = ctrl
    setCountdown(null)
    setCountdownLoading(true)
    try {
      setCountdown(await api.countdown(toUtcIso(utcRef.current), lat, lon, ctrl.signal))
    } catch (e) {
      if (!(e instanceof DOMException)) handleError(e, setPointError)
    } finally {
      if (!ctrl.signal.aborted) setCountdownLoading(false)
    }
  }, [handleError])

  const queryPoint = useCallback(async (x_m: number, y_m: number) => {
    setPointXY({ x_m, y_m })
    setPointLoading(true)
    setPointError(null)
    const { lat, lon } = mapToLatLon(x_m, y_m)
    void queryCountdown(lat, lon)
    try {
      const p = await api.point(toUtcIso(utcRef.current), lat, lon)
      setPoint(p)
      return p
    } catch (e) {
      setPoint(null)
      handleError(e, setPointError)
      return null
    } finally {
      setPointLoading(false)
    }
  }, [handleError, queryCountdown])

  /** Clique manual no mapa: a coordenada passa a ser "personalizada". */
  const clickMap = useCallback((x_m: number, y_m: number) => {
    setPresetId(CUSTOM_ID)
    void queryPoint(x_m, y_m)
  }, [queryPoint])

  /** Alvo do catálogo (ou coordenada digitada): consulta a API e centraliza as câmeras 2D e 3D. */
  const goTo = useCallback(async (id: string, lat: number, lon: number) => {
    setPresetId(id)
    const { x, y } = latLonToMap(lat, lon)
    const pointPromise = queryPoint(x, y)
    const b = basemap.bounds
    const inside = x >= b.x_min && x <= b.x_max && y >= b.y_min && y <= b.y_max
    const heightPx = window.innerHeight - 190
    if (inside) {
      setViewState({ target: [x / 1000, y / 1000, 0], zoom: Math.log2((heightPx * 0.9) / 16) }) // ~16 km de campo
    } else {
      // fora da malha renderizada: enquadra a malha e o ponto juntos
      const span = 2 * Math.max(Math.abs(x), Math.abs(y), b.x_max) / 1000 + 20
      setViewState({ target: [x / 2000, y / 2000, 0], zoom: Math.log2((heightPx * 0.9) / span) })
    }
    // o voo 3D usa a altitude real do ponto (telemetria), válida em qualquer lugar do DEM
    const p = await pointPromise
    setFocus3d((f) => ({ x_m: x, y_m: y, h_m: p?.height_m ?? 0, key: (f?.key ?? 0) + 1 }))
  }, [queryPoint, basemap.bounds])

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

  useEffect(() => {
    if (view === '3d' && !tileMeta) tilesApi.meta().then(setTileMeta).catch((e) => handleError(e, setError))
  }, [view, tileMeta, handleError])

  const b = map?.bounds ?? basemap.bounds
  const pointLatLon = pointXY ? mapToLatLon(pointXY.x_m, pointXY.y_m) : null
  const preset = findPreset(presetId)
  const base: Overlay = { id: 'base', image: basemap.image, bounds: basemap.bounds }
  const sunLayer: Overlay[] = map && showSun ? [{ id: 'sun', image: map.image, bounds: b, opacity: sunOpacity }] : []
  const hatchLayer2d: Overlay[] = layers && showEarth ? [{ id: 'hatch', image: layers.hatch, bounds: b, smooth: true }] : []
  const goldenLayer: Overlay[] = layers && showGolden ? [{ id: 'golden', image: layers.golden, bounds: b }] : []
  const marker = pointXY ? [{ id: 'sel', ...pointXY, color: [125, 255, 122] as [number, number, number], selected: true,
                               label: preset.id !== CUSTOM_ID ? preset.name.replace(/^(Artemis III|CLPS): /, '') : undefined }] : []
  const expected = mode === 'rapido' ? 0.8 : lastFullSeconds
  const geotiffUrl = map && `/api/map?${new URLSearchParams({ utc: map.utc, modo: map.mode, formato: 'geotiff' })}`

  const analyticSpec = map && (showSun || showEarth || showGolden)
    ? { utc: map.utc, sun: showSun, earth: showEarth, golden: showGolden } : null
  const marker3d = pointXY && point ? { ...pointXY, h_m: point.height_m } : null

  const tip = tooltip.hover && (
    <EngineeringTooltip point={tooltip.data} loading={tooltip.loading} x={tooltip.hover.screenX} y={tooltip.hover.screenY} />
  )
  const mapProps = { viewState, onViewStateChange: setViewState, onClickMap: clickMap, onHoverMap: tooltip.setHover,
                     showGrid: grid, points: marker }

  return (
    <div className="grid h-full grid-cols-[360px_1fr] gap-5">
      <aside className="space-y-4 overflow-y-auto pr-1 pb-4">
        <Card>
          <SectionLabel>1 · Instante (UTC)</SectionLabel>
          <input type="datetime-local" step={1} value={utc} onChange={(e) => setUtc(e.target.value)}
                 className="tabular w-full rounded-lg border border-space-700 bg-space-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sun-400" />
          <div className="mt-2 grid grid-cols-5 gap-1.5">
            <button onClick={() => setUtc(new Date().toISOString().slice(0, 19))} disabled={loading} title="Usar o instante atual (UTC)"
                    className="rounded-md border border-sun-400/40 bg-space-900 py-1.5 text-xs text-sun-300 transition hover:border-sun-400 disabled:opacity-40">
              Agora
            </button>
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
                        text="Dois raios por pixel — um até o Sol, outro até a Terra — nos 562 500 pixels." />
            <ModeOption active={mode === 'rapido'} disabled={!info.horizon_cache} onClick={() => setMode('rapido')}
                        icon={<Zap className="size-4" />} title="Mapa de horizontes" badge="< 1 s"
                        text={info.horizon_cache ? `Horizontes pré-calculados em ${info.n_azimuths} direções, com teto de ${fmt(info.horizon_limit_deg, 1)}° (cobre a Terra).`
                          : 'Indisponível: rode scripts/mapa_anual.py para gerar o cache.'} />
          </div>

          <button onClick={() => void run()} disabled={loading}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-sun-400 to-sun-500 py-2.5 text-[15px] font-semibold text-space-950 shadow-lg shadow-sun-500/20 transition hover:brightness-110 disabled:cursor-progress disabled:opacity-60">
            <Play className="size-4 fill-current" /> {loading ? 'Calculando…' : 'Calcular Sol + Terra'}
          </button>
          {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
        </Card>

        <Card>
          <SectionLabel>3 · Alvo de missão</SectionLabel>
          <MissionPresetPicker key={pointXY ? `${pointXY.x_m},${pointXY.y_m}` : 'none'} selectedId={presetId}
                               lat={pointLatLon?.lat ?? null} lon={pointLatLon?.lon ?? null} onGo={goTo} />
        </Card>

        {map && (
          <Card title="Resultado" icon={<Clock className="size-4" />}>
            <div className="grid grid-cols-3 gap-2">
              <Kpi value={`${fmt(map.stats.lit_pct, 1)}%`} label="com Sol (energia)" />
              <Kpi value={`${fmt(map.stats.earth_visible_pct, 1)}%`} label="com Terra (rádio)" tone="ice" />
              <Kpi value={<span className="text-emerald-300">{fmt(map.stats.golden_pct, 1)}%</span>} label="Zona de Ouro" />
            </div>
            <div className="tabular mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-slate-400">
              <span>Sol no polo</span><span className="text-right text-sun-300">{signed(map.sun.elevation_deg)}</span>
              <span>Terra no polo</span><span className="text-right text-ice-400">{signed(map.earth.elevation_deg)}</span>
              <span>Terra na área</span>
              <span className="text-right">{signed(map.stats.earth_elevation_min_deg, 1)} a {signed(map.stats.earth_elevation_max_deg, 1)}</span>
              <span>Atraso do sinal</span><span className="text-right">{fmt(map.earth.light_time_s, 3)} s</span>
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-slate-300">
              {map.mode === 'completo' ? (
                <>Calculado em <b className="text-sun-300">{fmt(map.elapsed_s, 1)} s</b>: {(2 * map.pixels).toLocaleString('pt-BR')} raios
                  (Sol + Terra) por até <b>{map.steps} passos</b> cada.</>
              ) : (
                <>Calculado em <b className="text-sun-300">{fmt(map.elapsed_s * 1000, 0)} ms</b>: elevações do Sol e da Terra comparadas
                  com o horizonte pré-calculado de cada pixel — nenhum raio novo.</>
              )}
            </p>
            {geotiffUrl && (
              <a href={geotiffUrl} className="mt-3 inline-flex items-center gap-1.5 text-xs text-sun-300 hover:underline">
                <Download className="size-3.5" /> GeoTIFF com 3 bandas: Sol, Terra, Zona de Ouro
              </a>
            )}
          </Card>
        )}

        {pointXY && <PointCard point={point} loading={pointLoading} error={pointError} countdown={countdown}
                               countdownLoading={countdownLoading} simulatedUtc={utc} />}

        <Card title="Como ler o mapa" icon={<InfoIcon className="size-4" />}>
          <ul className="space-y-2.5 text-[12.5px] leading-relaxed text-slate-300">
            <LegendItem swatch={<span className="bg-inferno block h-3 w-full rounded-sm" />}>
              <b className="text-sun-300">Sol</b> — preto = sombra, laranja = penumbra, amarelo = disco inteiro. Gera energia.
            </LegendItem>
            <LegendItem swatch={<span className="block h-3 w-full rounded-sm border border-ice-400/40"
                                      style={{ background: 'repeating-linear-gradient(-45deg, #40c8ff 0 1.5px, transparent 1.5px 5px)' }} />}>
              <b className="text-ice-400">Terra</b> — hachura = cobertura de rádio direta (DTE). Linhas mais fracas = disco
              parcialmente oculto, enlace degradado.
            </LegendItem>
            <LegendItem swatch={<span className="block h-3 w-full rounded-sm bg-emerald-400/85" />}>
              <b className="text-emerald-300">Zona de Ouro</b> — Sol E Terra ao mesmo tempo: energia e comunicação, os dois
              requisitos primários de pouso.
            </LegendItem>
          </ul>
          <p className="mt-3 text-[11.5px] leading-relaxed text-slate-500">
            A Terra não nasce nem se põe: a rotação sincronizada a mantém quase fixa no céu, perto do meridiano 0°. Quem a esconde é a
            libração (±7°), que a faz subir e afundar atrás do relevo ao longo do mês. Passe o mouse no mapa para ver a telemetria.
          </p>
        </Card>
      </aside>

      <section className="flex min-h-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Segmented value={view} onChange={setView} options={[
            { value: '2d', label: <><MapIcon className="size-3.5" /> Mapa</> },
            { value: 'compare', label: <><Columns2 className="size-3.5" /> Energia × Rádio</> },
            { value: '3d', label: <><Box className="size-3.5" /> Relevo 3D</> },
          ]} />
          <div className="flex items-center gap-1">
            <LayerToggle on={showSun} set={setShowSun} icon={<Sun className="size-3.5" />} label="Sol" tone="text-sun-300" />
            <LayerToggle on={showEarth} set={setShowEarth} icon={<Antenna className="size-3.5" />} label="Terra" tone="text-ice-400" />
            <LayerToggle on={showGolden} set={setShowGolden} icon={<Sparkles className="size-3.5" />} label="Zona de Ouro" tone="text-emerald-300" />
          </div>
          {view !== '3d' && (
            <>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                Opacidade do Sol
                <input type="range" min={0} max={1} step={0.05} value={sunOpacity} onChange={(e) => setSunOpacity(+e.target.value)} className="w-24 accent-sun-400" />
              </label>
              <LayerToggle on={grid} set={setGrid} icon={<Grid3x3 className="size-3.5" />} label="Grade" tone="text-slate-200" />
            </>
          )}
          {view === '3d' && (
            <label className="flex items-center gap-2 text-xs text-slate-400">
              Exagero vertical {exaggeration}×
              <input type="range" min={1} max={6} step={0.5} value={exaggeration} onChange={(e) => setExaggeration(+e.target.value)} className="accent-sun-400" />
            </label>
          )}
          <span className="ml-auto text-xs text-slate-500">
            {map ? `${map.utc.replace('T', ' ').replace('Z', ' UTC')}` : 'Escolha uma data e clique em Calcular'}
          </span>
        </div>

        <div className="relative min-h-0 flex-1">
          {view === '2d' && (
            <MapView2D {...mapProps} overlays={[base, ...sunLayer, ...hatchLayer2d, ...goldenLayer]}
                       caption={map ? 'Relevo LOLA · Sol · Terra · Zona de Ouro' : 'Relevo LOLA (80 m/pixel)'}>
              {tip}
            </MapView2D>
          )}
          {view === 'compare' && (
            <div className="grid h-full grid-cols-2 gap-3">
              <MapView2D {...mapProps} overlays={[base, ...(map ? [{ id: 'sun', image: map.image, bounds: b }] : [])]}
                         caption="Energia — visibilidade do Sol">
                {tip}
              </MapView2D>
              <MapView2D {...mapProps}
                         overlays={[{ ...base, opacity: 0.4 }, ...(map ? radioOnly(map, b) : [])]}
                         caption="Rádio — visada direta para a Terra">
                {tip}
              </MapView2D>
            </div>
          )}
          {view === '3d' && (
            <div className="h-full overflow-hidden rounded-xl border border-space-700">
              {tileMeta ? (
                <TerrainLOD3D meta={tileMeta} exaggeration={exaggeration} analytic={analyticSpec} sun={map?.sun} earth={map?.earth}
                              marker={marker3d} focus={focus3d} debugLevels={debugLevels} onStats={setLodStats} onClickMap={clickMap} />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-500">Carregando a quadtree…</div>
              )}
              {lodStats && tileMeta && <LodHud stats={lodStats} meta={tileMeta} debug={debugLevels} setDebug={setDebugLevels} />}
              <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-space-950/80 px-2.5 py-1 text-[11px] text-slate-400">
                Arraste para girar · role para zoom (do polo inteiro a ~74 m) · botão direito para mover · relevo exagerado {exaggeration}×
              </div>
            </div>
          )}
          {loading && <LoadingNarrative mode={mode} expectedSeconds={expected} />}
        </div>
      </section>
    </div>
  )
}

/** Cobertura de rádio sem considerar o Sol (vista "Energia × Rádio"): preenchimento translúcido + hachura. */
const radioCache = new WeakMap<IlluminationMap, { fill: string; hatch: string }>()
function radioOnly(map: IlluminationMap, bounds: IlluminationMap['bounds']): Overlay[] {
  let r = radioCache.get(map)
  if (!r) {
    const [rows, cols] = map.shape
    const masks = stateMasks(decodeUint8(map.sun_fraction_b64), decodeUint8(map.earth_fraction_b64), false)
    r = { fill: fillLayer(masks.comms, cols, rows, COLORS.comms, 0.35), hatch: hatchLayer(masks.comms, cols, rows) }
    radioCache.set(map, r)
  }
  return [{ id: 'radio-fill', image: r.fill, bounds }, { id: 'radio-hatch', image: r.hatch, bounds, smooth: true }]
}

function LayerToggle({ on, set, icon, label, tone }: { on: boolean; set: (v: boolean) => void; icon: ReactNode; label: string; tone: string }) {
  return (
    <button onClick={() => set(!on)} aria-pressed={on}
            className={cx('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition',
              on ? cx('border-space-600 bg-space-800', tone) : 'border-transparent text-slate-500 line-through decoration-slate-600')}>
      {icon} {label}
    </button>
  )
}

function LegendItem({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[34px_1fr] items-start gap-2.5">
      <span className="mt-1">{swatch}</span>
      <span>{children}</span>
    </li>
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

/** Painel de telemetria da quadtree: prova de que a memória fica limitada enquanto o detalhe acompanha a câmera. */
function LodHud({ stats: s, meta, debug, setDebug }: { stats: LodStats; meta: TileMeta; debug: boolean; setDebug: (v: boolean) => void }) {
  const fullGiB = ((meta.size_m / meta.leaf_cell_m) ** 2 * 32) / 2 ** 30 // malha inteira na resolução máxima
  const cell = meta.size_m / 2 ** s.maxZoom / meta.tile_cells
  return (
    <div className="absolute top-3 right-3 z-10 w-[268px] rounded-lg border border-space-600 bg-space-950/88 px-3 py-2.5 text-[11.5px] text-slate-300 backdrop-blur">
      <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-slate-100"><Layers className="size-3.5 text-sun-400" /> Quadtree LOD</div>
      <div className="tabular grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5">
        <span className="text-slate-500">Tiles na tela / em memória</span><span>{s.rendered} / {s.loaded}</span>
        <span className="text-slate-500">Vértices desenhados</span><span>{(s.vertices / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} M</span>
        <span className="text-slate-500">Nível mais fino na tela</span><span>z{s.maxZoom} · {fmt(cell, 0)} m</span>
        <span className="text-slate-500">Memória de GPU (estimada)</span><span className="text-emerald-300">{fmt(s.gpuMB, 0)} / 128 MB</span>
        <span className="text-slate-500">Sem LOD (malha inteira)</span><span className="text-rose-300">{fmt(fullGiB, 1)} GiB</span>
        <span className="text-slate-500">Carregando</span><span>{s.pending} tiles</span>
        {s.analyticWanted > 0 && (<><span className="text-slate-500">Sol + Terra por tile</span><span>{s.analyticReady}/{s.analyticWanted}</span></>)}
      </div>
      <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
        <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} className="accent-sun-400" />
        Colorir tiles por nível (debug)
      </label>
    </div>
  )
}
