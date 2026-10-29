import { Cpu, Database, Orbit, Sun } from 'lucide-react'
import type { ReactNode } from 'react'

const PIPELINE: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <Orbit className="size-5" />, title: 'SPICE · NASA/NAIF',
    text: 'Converte a data em tempo de efeméride e calcula a posição aparente do Sol no referencial lunar MOON_ME (efemérides DE440, correção de tempo-luz e aberração).' },
  { icon: <Database className="size-5" />, title: 'Topografia LOLA',
    text: 'O mapa de altitudes do Lunar Reconnaissance Orbiter (80 m/pixel, 80°S–90°S) vira uma matriz NumPy de 7600 × 7600 células.' },
  { icon: <Cpu className="size-5" />, title: 'Ray-casting 3D vetorizado',
    text: 'Um raio por pixel em direção ao Sol. Todos avançam juntos; em cada passo a altitude do relevo sob o raio é comparada com o raio — com a curvatura da Lua.' },
  { icon: <Sun className="size-5" />, title: 'Disco solar',
    text: 'O Sol mede 0,5°. O resultado é a fração do disco acima do horizonte topográfico (0 a 1), o que gera a penumbra.' },
]

const VALIDATION: [string, string][] = [
  ['Elevação do Sol vs. rotina azlcpo do CSPICE', 'diferença < 10⁻⁹°'],
  ['Motor vetorizado vs. mesmo cálculo pixel a pixel', 'resultados idênticos'],
  ['Projeção do mapa vs. biblioteca PROJ', 'diferença < 10⁻⁹°'],
  ['Mapa de horizontes vs. ray-casting completo (4 datas de 2027)', '99,8–99,9% dos pixels iguais'],
  ['Testes automatizados (Python + TypeScript)', 'pytest + vitest'],
]

export function MethodologyView() {
  return (
    <div className="mx-auto h-full max-w-4xl space-y-8 overflow-y-auto pr-2 pb-10">
      <header>
        <h2 className="text-2xl font-semibold text-slate-100">Como o Lunar Navigator calcula luz e sombra</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-slate-400">
          No polo sul da Lua o Sol nunca sobe mais que ~1,6° acima do horizonte. Qualquer montanha ou borda de cratera
          projeta sombras de dezenas de quilômetros — e o fundo de algumas crateras nunca vê o Sol.
        </p>
      </header>

      <ol className="grid gap-3 sm:grid-cols-2">
        {PIPELINE.map((s, i) => (
          <li key={s.title} className="rounded-xl border border-space-700 bg-space-850/80 p-4">
            <div className="flex items-center gap-2.5 text-sun-400">
              {s.icon}
              <span className="text-xs font-semibold tracking-wider text-slate-500">ETAPA {i + 1}</span>
            </div>
            <h3 className="mt-2 font-semibold text-slate-100">{s.title}</h3>
            <p className="mt-1 text-[13.5px] leading-relaxed text-slate-400">{s.text}</p>
          </li>
        ))}
      </ol>

      <Section title="Por que o cálculo completo leva ~10 segundos?">
        O mapa tem <b>562 500 pixels</b>. Para cada um, o programa responde: <i>“existe alguma montanha entre este ponto e o
        Sol?”</i>. O raio avança em passos — 80 m perto, crescendo 1% a cada passo — por até <b>~400 passos</b>: centenas de
        milhões de consultas ao relevo. Tratando um pixel por vez em Python, o mesmo cálculo levaria <b>~33 horas</b>. Com
        NumPy, todos os raios avançam juntos, e o processamento em blocos de 65 536 pixels mantém os dados no cache da CPU.
      </Section>

      <Section title="O modo rápido e a análise anual">
        O relevo não muda; só o Sol se move. Por isso calculamos <b>uma vez</b> o horizonte de cada pixel em 180 direções
        (o mesmo ray-casting, ~15 min em 6 processos) e guardamos. Depois, qualquer instante é só comparar a elevação do Sol com
        o horizonte na direção dele: <b>&lt; 1 s</b>. O ano de 2027, a cada 12 h, sai em ~1,5 minuto em vez de ~2 horas
        (método de Mazarico et al., 2011).
      </Section>

      <section>
        <h3 className="mb-3 text-lg font-semibold text-sun-400">Validação</h3>
        <div className="overflow-hidden rounded-xl border border-space-700">
          {VALIDATION.map(([what, result]) => (
            <div key={what} className="flex justify-between gap-4 border-b border-space-800 bg-space-850/60 px-4 py-2.5 text-[13.5px] last:border-0">
              <span className="text-slate-300">{what}</span>
              <span className="tabular shrink-0 font-medium text-emerald-300">{result}</span>
            </div>
          ))}
        </div>
      </section>

      <Section title="Limitações">
        <ul className="list-disc space-y-1 pl-5">
          <li>Pixel de 80 m: crateras menores que ~160 m não aparecem.</li>
          <li>Área de ±30 km do polo. O ponto mais iluminado da literatura (88,74°S, 124,5°E; Bussey et al., 2010) fica a ~38 km, fora do recorte.</li>
          <li>Um ano não é um ciclo completo (~18,6 anos): “sombra permanente” significa “sem Sol no período analisado”.</li>
          <li>Luz refletida pela Terra e pelo relevo não é considerada.</li>
        </ul>
      </Section>

      <Section title="Fontes">
        Kernels SPICE da NASA/NAIF (DE440, pck00011, moon_pa_de440, moon_de440), DEM LOLA de Barker et al. (2023, PSJ 4:183),
        método de Mazarico et al. (2011, Icarus 211). Lista completa com DOIs em <code className="rounded bg-space-800 px-1.5 py-0.5 text-[12px]">docs/REFERENCIAS.md</code>.
        API documentada em <a href="/docs" className="text-sun-300 hover:underline">/docs</a>.
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-lg font-semibold text-sun-400">{title}</h3>
      <div className="text-[14.5px] leading-relaxed text-slate-300">{children}</div>
    </section>
  )
}
