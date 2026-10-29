import DeckGL from '@deck.gl/react'
import { BitmapLayer, LineLayer, OrthographicView, PathLayer, ScatterplotLayer, TextLayer } from 'deck.gl'
import type { Layer, PickingInfo } from 'deck.gl'
import { useMemo, useState, type ReactNode } from 'react'
import type { Bounds } from '../lib/api'
import { fmt, latLonToMap, mapToLatLon } from '../lib/geo'
import type { ViewState } from '../lib/view'

// Coordenadas do mundo deck.gl = km no plano polar estereográfico (Y para cima = meridiano 0°).

export interface Overlay {
  id: string
  image: string
  bounds: Bounds
  opacity?: number
  smooth?: boolean // filtro linear (hachura); padrão: pixels nítidos (dados de 80 m)
}

export interface HoverEvent {
  x_m: number
  y_m: number
  screenX: number // px relativos ao canto do mapa
  screenY: number
}

export interface MapPoint {
  id: string
  x_m: number
  y_m: number
  color: [number, number, number]
  label?: string
  selected?: boolean
}

const VIEW = new OrthographicView({ id: 'map', flipY: false, controller: true })
const LAT_RINGS = [-89.75, -89.5, -89.25, -89.0]
const MERIDIANS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]

function graticule(showGrid: boolean): Layer[] {
  if (!showGrid) return []
  const rings = LAT_RINGS.map((lat) => ({
    lat,
    path: Array.from({ length: 181 }, (_, i) => {
      const p = latLonToMap(lat, i * 2)
      return [p.x / 1000, p.y / 1000] as [number, number]
    }),
  }))
  const meridians = MERIDIANS.map((lon) => {
    const p = latLonToMap(-88.9, lon)
    return { lon, from: [0, 0] as [number, number], to: [p.x / 1000, p.y / 1000] as [number, number] }
  })
  return [
    new PathLayer({
      id: 'lat-rings', data: rings, getPath: (d) => d.path, getColor: [255, 255, 255, 38],
      getWidth: 1, widthUnits: 'pixels',
    }),
    new LineLayer({
      id: 'meridians', data: meridians, getSourcePosition: (d) => d.from, getTargetPosition: (d) => d.to,
      getColor: [255, 255, 255, 28], getWidth: 1,
    }),
    new TextLayer({
      id: 'lat-labels', data: rings, getPosition: (d) => { const p = latLonToMap(d.lat, 45); return [p.x / 1000, p.y / 1000] },
      getText: (d) => `${fmt(-d.lat, 2)}°S`, getSize: 10, getColor: [200, 210, 230, 150], fontFamily: 'Inter, Segoe UI, sans-serif', characterSet: 'auto',
      background: true, getBackgroundColor: [7, 9, 14, 170], backgroundPadding: [3, 1],
    }),
    new TextLayer({
      id: 'lon-labels', data: meridians.filter((m) => m.lon % 90 === 0),
      getPosition: (d) => [d.to[0] * 0.96, d.to[1] * 0.96], getText: (d) => (d.lon === 0 ? '0°' : d.lon === 180 ? '180°' : d.lon === 90 ? '90°E' : '90°W'),
      getSize: 11, getColor: [200, 210, 230, 170], fontFamily: 'Inter, Segoe UI, sans-serif', characterSet: 'auto',
      background: true, getBackgroundColor: [7, 9, 14, 170], backgroundPadding: [3, 1],
    }),
  ]
}

function niceScale(kmPerPx: number): { km: number; px: number } {
  const target = kmPerPx * 110
  const pow = 10 ** Math.floor(Math.log10(target))
  const km = [1, 2, 5, 10].map((m) => m * pow).reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best))
  return { km, px: km / kmPerPx }
}

export function MapView2D({
  overlays, points = [], viewState, onViewStateChange, onClickMap, onHoverMap, showGrid = true, caption, children,
}: {
  overlays: Overlay[]
  points?: MapPoint[]
  viewState: ViewState
  onViewStateChange: (v: ViewState) => void
  onClickMap?: (x_m: number, y_m: number, pointId?: string) => void
  onHoverMap?: (e: HoverEvent | null) => void
  showGrid?: boolean
  caption?: string
  children?: ReactNode
}) {
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)

  const layers = useMemo(() => {
    const bitmaps = overlays.map((o) => new BitmapLayer({
      id: `bmp-${o.id}`,
      image: o.image,
      bounds: [o.bounds.x_min / 1000, o.bounds.y_min / 1000, o.bounds.x_max / 1000, o.bounds.y_max / 1000],
      opacity: o.opacity ?? 1,
      textureParameters: o.smooth ? { minFilter: 'linear', magFilter: 'linear' } : { minFilter: 'nearest', magFilter: 'nearest' },
    }))
    const pts = new ScatterplotLayer<MapPoint>({
      id: 'points', data: points, pickable: true, stroked: true, filled: true,
      getPosition: (d) => [d.x_m / 1000, d.y_m / 1000],
      getRadius: (d) => (d.selected ? 11 : 8), radiusUnits: 'pixels',
      getFillColor: (d) => [...d.color, d.selected ? 110 : 30],
      getLineColor: (d) => [...d.color, 255], lineWidthUnits: 'pixels', getLineWidth: 2,
      updateTriggers: { getRadius: points, getFillColor: points },
    })
    const labels = new TextLayer<MapPoint>({
      id: 'point-labels', data: points.filter((p) => p.label), getPosition: (d) => [d.x_m / 1000, d.y_m / 1000],
      getText: (d) => d.label ?? '', getSize: 11, getColor: (d) => [...d.color, 255], getPixelOffset: [13, -11],
      fontFamily: 'Inter, Segoe UI, sans-serif', characterSet: 'auto', fontWeight: 700, outlineWidth: 3, outlineColor: [7, 9, 14, 255],
      fontSettings: { sdf: true },
    })
    const pole = new ScatterplotLayer({
      id: 'pole', data: [[0, 0]], getPosition: (d: number[]) => [d[0], d[1]], getRadius: 5, radiusUnits: 'pixels',
      stroked: true, filled: false, getLineColor: [64, 200, 255, 230], lineWidthUnits: 'pixels', getLineWidth: 2,
    })
    return [...bitmaps, ...graticule(showGrid), pole, pts, labels]
  }, [overlays, points, showGrid])

  const onClick = (info: PickingInfo) => {
    if (!onClickMap || !info.coordinate) return
    const picked = info.layer?.id === 'points' ? (info.object as MapPoint) : undefined
    if (picked) onClickMap(picked.x_m, picked.y_m, picked.id)
    else onClickMap(info.coordinate[0] * 1000, info.coordinate[1] * 1000)
  }

  const scale = niceScale(1 / 2 ** viewState.zoom)
  const ll = hover && mapToLatLon(hover.x * 1000, hover.y * 1000)

  return (
    <div className="relative h-full min-h-[420px] overflow-hidden rounded-xl border border-space-700 bg-space-950">
      <DeckGL
        views={VIEW}
        viewState={viewState}
        onViewStateChange={({ viewState: v }) => onViewStateChange({ target: v.target as ViewState['target'], zoom: v.zoom as number })}
        layers={layers}
        onClick={onClick}
        onHover={(info) => {
          const c = info.coordinate
          setHover(c ? { x: c[0], y: c[1] } : null)
          onHoverMap?.(c ? { x_m: c[0] * 1000, y_m: c[1] * 1000, screenX: info.x, screenY: info.y } : null)
        }}
        getCursor={({ isDragging, isHovering }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'crosshair')}
      />
      {caption && (
        <div className="pointer-events-none absolute top-3 left-3 rounded-md bg-space-950/80 px-2.5 py-1 text-xs text-slate-300 backdrop-blur">
          {caption}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 left-3 flex items-end gap-3">
        <div className="rounded-md bg-space-950/80 px-2.5 py-1.5 backdrop-blur">
          <div className="h-1.5 border-x-2 border-b-2 border-slate-300" style={{ width: scale.px }} />
          <div className="tabular mt-0.5 text-[11px] text-slate-300">{fmt(scale.km, scale.km < 1 ? 1 : 0)} km</div>
        </div>
      </div>
      <div className="tabular pointer-events-none absolute right-3 bottom-3 rounded-md bg-space-950/80 px-2.5 py-1 text-[11px] text-slate-400 backdrop-blur">
        {ll ? `x ${fmt(hover!.x, 2)} km · y ${fmt(hover!.y, 2)} km · ${fmt(ll.lat, 3)}° · ${fmt(ll.lon, 2)}°` : 'arraste para mover · role para zoom · clique para consultar'}
      </div>
      {children}
    </div>
  )
}
