import { BookOpen, CalendarRange, Satellite } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnnualView } from './components/AnnualView'
import { InstantView } from './components/InstantView'
import { MethodologyView } from './components/MethodologyView'
import { ServerOffline } from './components/ServerOffline'
import { cx } from './lib/view'
import { api, ServerUnavailableError } from './lib/api'
import type { Basemap, Info, Terrain } from './lib/api'

type Tab = 'instant' | 'annual' | 'method'

const TABS: { id: Tab; label: string; icon: typeof Satellite }[] = [
  { id: 'instant', label: 'Iluminação num instante', icon: Satellite },
  { id: 'annual', label: 'Análise anual', icon: CalendarRange },
  { id: 'method', label: 'Metodologia', icon: BookOpen },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('instant')
  const [info, setInfo] = useState<Info | null>(null)
  const [basemap, setBasemap] = useState<Basemap | null>(null)
  const [terrain, setTerrain] = useState<Terrain | null>(null)
  const [offline, setOffline] = useState<string | null>(
    location.protocol === 'file:' ? 'Esta página foi aberta direto do disco (file://), então não há servidor para responder.' : null,
  )
  const terrainRequested = useRef(false)

  useEffect(() => {
    if (offline) return
    Promise.all([api.info(), api.basemap()])
      .then(([i, b]) => { setInfo(i); setBasemap(b) })
      .catch((e) => setOffline(e instanceof ServerUnavailableError ? 'O servidor não respondeu.' : `Erro do servidor: ${e.message}`))
  }, [offline])

  const requestTerrain = useCallback(() => {
    if (terrainRequested.current) return
    terrainRequested.current = true
    api.terrain().then(setTerrain).catch(() => { terrainRequested.current = false })
  }, [])


  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-30 flex items-center gap-6 border-b border-space-700/70 bg-space-950/75 px-6 py-3 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-8" />
          <div>
            <h1 className="text-[17px] leading-tight font-semibold tracking-tight text-slate-50">Lunar Navigator</h1>
            <p className="text-[11.5px] text-slate-500">Luz e sombra no polo sul da Lua · SPICE (NASA/NAIF) + topografia LOLA</p>
          </div>
        </div>
        <nav className="ml-auto flex rounded-xl border border-space-700 bg-space-900/80 p-1">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
                    className={cx('flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition',
                      tab === t.id ? 'bg-space-700 text-slate-50 shadow' : 'text-slate-400 hover:text-slate-200')}>
              <t.icon className={cx('size-4', tab === t.id && 'text-sun-400')} /> {t.label}
            </button>
          ))}
        </nav>
        {info && (
          <div className="hidden items-center gap-2 text-[11px] text-slate-500 xl:flex">
            <span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60" />
            {info.kernels_loaded} kernels · DEM {info.pixel_m} m · {info.horizon_cache ? 'horizontes em cache' : 'sem cache'}
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1 p-5">
        {!basemap || !info ? (
          !offline && <div className="flex h-full items-center justify-center text-sm text-slate-500">Conectando ao servidor…</div>
        ) : (
          <>
            <div className={cx('h-full', tab !== 'instant' && 'hidden')}>
              <InstantView info={info} basemap={basemap} terrain={terrain} requestTerrain={requestTerrain} onServerDown={setOffline} />
            </div>
            {tab === 'annual' && (
              <AnnualView year={info.annual_years.at(-1) ?? 2027} basemap={basemap} terrain={terrain} requestTerrain={requestTerrain} />
            )}
            {tab === 'method' && <MethodologyView />}
          </>
        )}
      </main>

      {offline && <ServerOffline reason={offline} />}
    </div>
  )
}
