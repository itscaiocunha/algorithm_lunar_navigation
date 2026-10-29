import { ServerCrash } from 'lucide-react'

export function ServerOffline({ reason }: { reason: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-space-950/92 p-6 backdrop-blur">
      <div className="max-w-xl rounded-2xl border border-sun-400/50 bg-space-850 p-7 shadow-2xl">
        <div className="flex items-center gap-3 text-sun-400">
          <ServerCrash className="size-6" />
          <h2 className="text-lg font-semibold">O servidor do Lunar Navigator não está acessível</h2>
        </div>
        <p className="mt-3 text-sm text-slate-300">{reason}</p>
        <p className="mt-3 text-sm text-slate-400">
          Os cálculos (SPICE + ray-casting) rodam no servidor Python. No terminal, na pasta do projeto:
        </p>
        <pre className="mt-3 rounded-lg bg-space-950 p-3 font-mono text-[13px] text-slate-200">
{`.\\.venv\\Scripts\\Activate.ps1
python scripts\\servidor.py`}
        </pre>
        <button onClick={() => location.reload()}
                className="mt-5 w-full rounded-lg bg-gradient-to-r from-sun-400 to-sun-500 py-2.5 font-semibold text-space-950 hover:brightness-110">
          Tentar novamente
        </button>
      </div>
    </div>
  )
}
