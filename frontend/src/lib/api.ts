// Cliente tipado da API FastAPI (src/lunar_navigator/api.py).

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
  image: string
  sun: { map_dir: [number, number]; elevation_deg: number }
  stats: {
    lit_pct: number
    full_disk_pct: number
    shadow_pct: number
    sun_elevation_min_deg: number
    sun_elevation_max_deg: number
  }
}

export interface AnnualAtPoint {
  year: number
  illumination_pct: number
  any_sun_pct: number
  longest_night_h: number
  psr: boolean
}

export interface PointIllumination {
  utc: string
  lat: number
  lon: number
  x_m: number
  y_m: number
  height_m: number
  fraction: number
  status: 'iluminado' | 'penumbra' | 'sombra'
  sun_elevation_deg: number
  sun_azimuth_deg: number
  horizon_deg: number
  elapsed_ms: number
  annual?: AnnualAtPoint | null
}

export interface Peak {
  rank: number
  lat: number
  lon: number
  x_m: number
  y_m: number
  height_m: number
  illumination_pct: number
  any_sun_pct: number
  longest_night_h: number
  distance_to_psr_km: number
}

export interface Annual {
  year: number
  meta: { n_samples: number; step_hours: number; start_utc: string; end_utc: string; pixel: number }
  bounds: Bounds
  image: string
  peaks: Peak[]
  stats: {
    psr_km2: number
    psr_pct: number
    over_80pct_km2: number
    over_50pct_km2: number
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

async function get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const query = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) : ''
  let res: Response
  try {
    res = await fetch(path + query)
  } catch {
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
  point: (utc: string, lat: number, lon: number) => get<PointIllumination>('/api/illumination', { utc, lat, lon }),
  annual: (year: number) => get<Annual>('/api/annual', { year }),
}

export function decodeHeights(t: Terrain): Float32Array {
  const bin = atob(t.heights_b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}
