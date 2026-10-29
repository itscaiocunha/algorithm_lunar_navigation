import { CheckCircle2, Info, LocateFixed, Mountain } from 'lucide-react'
import { useState } from 'react'
import { fmt } from '../lib/geo'
import { CUSTOM_ID, findPreset, LANDING_PRESETS, OPTIMIZED_SUBTITLE, type PresetStatus } from '../lib/presets'
import { cx } from '../lib/view'

const STATUS: Record<PresetStatus, { icon: typeof Info; tone: string; label: string }> = {
  otimizado: { icon: Mountain, tone: 'border-emerald-400/50 bg-emerald-400/[0.07] text-emerald-100', label: 'Peak Optimized · validado pelo modelo LOLA' },
  confirmado: { icon: CheckCircle2, tone: 'border-emerald-400/30 bg-emerald-400/[0.04] text-emerald-200', label: 'Coerente com o modelo' },
  informativo: { icon: Info, tone: 'border-sky-400/30 bg-sky-400/[0.05] text-sky-100', label: 'Observação' },
}

const inputCls = 'tabular w-full rounded-lg border border-space-700 bg-space-950 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-sun-400'

/**
 * Catálogo de alvos. `selectedId` e as coordenadas vêm do pai: um clique no mapa volta o seletor para
 * "personalizada" com as coordenadas clicadas.
 */
export function MissionPresetPicker({ selectedId, lat, lon, onGo }: {
  selectedId: string
  lat: number | null
  lon: number | null
  onGo: (presetId: string, lat: number, lon: number) => void
}) {
  const preset = findPreset(selectedId)
  const [draft, setDraft] = useState<{ lat: string; lon: string } | null>(null)
  const shown = draft ?? { lat: lat === null ? '' : fmt(lat, 4).replace(',', '.'), lon: lon === null ? '' : fmt(lon, 3).replace(',', '.') }
  const latNum = Number(shown.lat), lonNum = Number(shown.lon)
  const valid = shown.lat !== '' && shown.lon !== '' && latNum >= -90 && latNum <= -80.5 && Math.abs(lonNum) <= 360
  const status = preset.status && STATUS[preset.status]

  return (
    <div className="space-y-2">
      <select value={selectedId} aria-label="Alvo de missão"
              onChange={(e) => {
                const p = findPreset(e.target.value)
                setDraft(null)
                if (p.lat !== null && p.lon !== null) onGo(p.id, p.lat, p.lon)
                else onGo(CUSTOM_ID, lat ?? -89.5, lon ?? 0)
              }}
              className="w-full rounded-lg border border-space-700 bg-space-950 px-2.5 py-2 text-sm text-slate-100 outline-none focus:border-sun-400">
        {(['Artemis III', 'CLPS'] as const).map((program) => (
          <optgroup key={program} label={program === 'CLPS' ? 'CLPS (Commercial Lunar Payload Services)' : 'Artemis III — regiões 15×15 km'}>
            {LANDING_PRESETS.filter((p) => p.program === program).map((p) => (
              <option key={p.id} value={p.id}>{p.name.replace(`${program}: `, '')}</option>
            ))}
          </optgroup>
        ))}
        <option value={CUSTOM_ID}>Coordenada personalizada</option>
      </select>

      <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
        <input className={inputCls} inputMode="decimal" placeholder="lat (−90 a −80,5)" value={shown.lat}
               onChange={(e) => setDraft({ ...shown, lat: e.target.value })} aria-label="Latitude" />
        <input className={inputCls} inputMode="decimal" placeholder="lon" value={shown.lon}
               onChange={(e) => setDraft({ ...shown, lon: e.target.value })} aria-label="Longitude" />
        <button disabled={!valid} title="Consultar e centralizar"
                onClick={() => { setDraft(null); onGo(draft ? CUSTOM_ID : selectedId, latNum, lonNum) }}
                className="flex items-center gap-1 rounded-lg border border-sun-400/50 px-2.5 text-xs font-medium text-sun-300 transition hover:bg-sun-400/10 disabled:opacity-35">
          <LocateFixed className="size-3.5" /> Ir
        </button>
      </div>

      {status && (
        <div className={cx('rounded-lg border px-2.5 py-2 text-[11.5px] leading-relaxed', status.tone)}>
          <div className="mb-0.5 flex items-center gap-1.5 font-semibold"><status.icon className="size-3.5" /> {status.label}</div>
          {preset.status === 'otimizado' && <p className="mb-1.5 text-[11px] text-emerald-200/80 italic">{OPTIMIZED_SUBTITLE}</p>}
          {preset.note}
          <div className="mt-1 text-[10.5px] opacity-70">Origem: {preset.source}</div>
        </div>
      )}
    </div>
  )
}
