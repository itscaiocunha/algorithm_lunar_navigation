// Projeção polar estereográfica sul do DEM LOLA (+proj=stere +lat_0=-90 +R=1737400).
// Mesmas fórmulas de src/lunar_navigator/terrain.py: x = ρ·sen λ, y = ρ·cos λ.

export const MOON_RADIUS_M = 1_737_400

/** Coordenadas do mapa (metros) -> latitude/longitude (graus). */
export function mapToLatLon(x: number, y: number): { lat: number; lon: number } {
  const R = MOON_RADIUS_M
  const rho2 = x * x + y * y
  const d = rho2 + 4 * R * R
  const ux = (4 * R * y) / d
  const uy = (4 * R * x) / d
  const uz = (rho2 - 4 * R * R) / d
  return { lat: (Math.asin(uz) * 180) / Math.PI, lon: (Math.atan2(uy, ux) * 180) / Math.PI }
}

/** Latitude/longitude (graus) -> coordenadas do mapa (metros). */
export function latLonToMap(lat: number, lon: number): { x: number; y: number } {
  const la = (lat * Math.PI) / 180
  const lo = (lon * Math.PI) / 180
  const rho = 2 * MOON_RADIUS_M * Math.tan(Math.PI / 4 + la / 2)
  return { x: rho * Math.sin(lo), y: rho * Math.cos(lo) }
}

/** Formata número em pt-BR com casas decimais fixas. */
export function fmt(value: number, digits = 1): string {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/** "2026-11-20T00:00:00" (input datetime-local, interpretado como UTC) -> ISO com Z. */
export function toUtcIso(local: string): string {
  const v = local.length === 16 ? `${local}:00` : local
  return `${v}Z`
}

/** Soma horas a um valor de datetime-local tratado como UTC. */
export function addHours(local: string, hours: number): string {
  const d = new Date(toUtcIso(local))
  d.setUTCHours(d.getUTCHours() + hours)
  return d.toISOString().slice(0, 19)
}
