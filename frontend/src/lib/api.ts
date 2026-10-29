// Cliente tipado da API FastAPI (src/lunar_navigator/api.py).
import type { TileMeta } from './quadtree'

export interface Bounds {
  x_min: number
  x_max: number
  y_min: number
  y_max: number
}

export interface Info {
  dem: string
  dem_shape: [number, number]
  pixel_m: number
  area_bounds: Bounds
  area_shape: [number, number]
  horizon_cache: boolean
  n_azimuths: number
  annual_years: number[]
  kernels_loaded: number
  horizon_limit_deg: number
  annual_metrics: Record<AnnualMetric, string>
}

export interface Basemap {
  bounds: Bounds
  pixel_m: number
  shape: [number, number]
  height_min_m: number
  height_max_m: number
  image: string
}

export type MapMode = 'completo' | 'rapido'

export interface IlluminationMap {
  utc: string
  mode: MapMode
  elapsed_s: number
  steps: number | null
  pixels: number
  shape: [number, number]
  pixel_m: number
  bounds: Bounds
  image: string // fração do Sol em PNG (inferno)
  sun_fraction_b64: string // uint8 0..255, linha a linha
  earth_fraction_b64: string
  sun: BodyDirection
  earth: BodyDirection & { light_time_s: number }
  stats: {
    lit_pct: number
    full_disk_pct: number
    shadow_pct: number
    sun_elevation_min_deg: number
    sun_elevation_max_deg: number
    earth_visible_pct: number
    earth_full_pct: number
    earth_elevation_min_deg: number
    earth_elevation_max_deg: number
    golden_pct: number
    power_only_pct: number
    comms_only_pct: number
    none_pct: number
  }
}

export interface BodyDirection {
  map_dir: [number, number] // direção no plano do mapa, vista do centro da área
  elevation_deg: number
}

export interface AnnualAtPoint {
  year: number
  illumination_pct: number
  any_sun_pct: number
  longest_night_h: number
  psr: boolean
  any_earth_pct: number
  longest_los_h: number
  golden_pct: number
  longest_golden_h: number
}

export interface BodyAtPoint {
  fraction: number
  elevation_deg: number
  azimuth_deg: number
  horizon_deg: number
  angular_radius_deg: number
  level: string
  label: string
}

export interface PointIllumination {
  utc: string
  lat: number
  lon: number
  x_m: number
  y_m: number
  height_m: number
  sun: BodyAtPoint & { level: 'nominal' | 'parcial' | 'sem_energia' }
  earth: BodyAtPoint & { level: 'banda_larga' | 'degradado' | 'emergencia' | 'los'; light_time_s: number }
  golden: boolean
  status: string
  elapsed_ms: number
  annual?: AnnualAtPoint | null
}

export type CountdownEventName = 'sunset' | 'sunrise' | 'los' | 'aos' | 'degradation' | 'full_signal'

export interface CountdownEvent {
  event: CountdownEventName
  seconds: number // a partir do instante simulado
  utc: string
  exact: boolean // raiz confirmada pelo ray-casting exato
}

export interface BodyCountdown {
  state: 'full' | 'partial' | 'hidden'
  margin_deg: number
  event: CountdownEventName | null // evento principal (para a Terra visível: LOS)
  seconds: number | null
  utc: string | null
  events: CountdownEvent[]
  searched_days: number
  uncertainty_min: number
}

export interface Countdown {
  utc: string
  lat: number
  lon: number
  sun: BodyCountdown
  earth: BodyCountdown
  golden: boolean
  golden_ends_seconds?: number | null
  elapsed_ms: number
}

export interface Peak {
  rank: number
  score: number
  score_terms: { window: number; golden: number; outage: number } // já ponderados; somam o score
  worst_outage_h: number
  lat: number
  lon: number
  x_m: number
  y_m: number
  height_m: number
  longest_golden_h: number
  golden_pct: number
  illumination_pct: number
  any_sun_pct: number
  earth_pct: number
  any_earth_pct: number
  longest_night_h: number
  longest_los_h: number
  distance_to_psr_km: number
}

export type AnnualMetric = 'score' | 'golden_window' | 'golden_pct' | 'illumination_pct' | 'earth_pct'

export interface Weights {
  a: number // maior janela de ouro
  b: number // fração anual de ouro
  c: number // pior apagão contínuo (noite ou LOS)
}

export interface Annual {
  year: number
  meta: { n_samples: number; step_hours: number; start_utc: string; end_utc: string; pixel: number }
  bounds: Bounds
  metric: { id: AnnualMetric; label: string; colormap: 'viridis' | 'inferno' | 'cividis'; unit: string; vmin: number; vmax: number }
  weights: Weights
  image: string
  peaks: Peak[]
  stats: {
    psr_km2: number
    earth_never_km2: number
    golden_any_km2: number
    golden_7d_km2: number
    max_golden_window_d: number
    max_illumination_pct: number
  }
}

export interface Terrain {
  shape: [number, number]
  bounds: Bounds
  min_m: number
  max_m: number
  heights_b64: string
}

/** Erro de rede (servidor fora do ar) — distinto de erro de validação da API. */
export class ServerUnavailableError extends Error {}

async function get<T>(path: string, params?: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
  const query = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) : ''
  let res: Response
  try {
    res = await fetch(path + query, { signal })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ServerUnavailableError('O servidor não respondeu')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`)
  return body as T
}

export const api = {
  info: () => get<Info>('/api/info'),
  basemap: () => get<Basemap>('/api/basemap'),
  terrain: (step = 3) => get<Terrain>('/api/terrain', { step }),
  map: (utc: string, modo: MapMode) => get<IlluminationMap>('/api/map', { utc, modo }),
  point: (utc: string, lat: number, lon: number, signal?: AbortSignal) =>
    get<PointIllumination>('/api/illumination', { utc, lat, lon }, signal),
  countdown: (utc: string, lat: number, lon: number, signal?: AbortSignal) =>
    get<Countdown>('/api/countdown', { utc, lat, lon }, signal),
  annual: (year: number, metric: AnnualMetric, w: Weights) => get<Annual>('/api/annual', { year, metric, ...w }),
}

export function decodeHeights(t: Terrain): Float32Array {
  const bin = atob(t.heights_b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}

export const tilesApi = {
  meta: () => get<TileMeta>('/api/tiles/meta'),
}
