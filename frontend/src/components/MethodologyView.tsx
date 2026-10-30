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
  ['Elevação/azimute da Terra vs. rotina azlcpo do CSPICE', 'diferença < 10⁻⁹°'],
  ['Horizontes com teto da Terra vs. motor direto (Terra a até 7,5°)', '≥ 98% dos pixels com |Δfração| < 0,05'],
  ['Janela de ouro: 60% de Sol coincidente vence 80% desencontrado', 'teste automatizado'],
  ['Eventos da contagem regressiva vs. ray-casting direto (±2 min)', 'troca de estado confirmada'],
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

      <Section title="Comunicação direta com a Terra (DTE)">
        <p>
          A Lua tem rotação sincronizada: a Terra não nasce nem se põe, ela paira quase fixa no céu, perto do meridiano 0°. O que a
          esconde é a <b>libração</b> — a Lua “balança” ±8° em longitude e ±7° em latitude ao longo do mês. No polo sul, medimos com
          o SPICE (2026–2035) a Terra variando entre <b>−7,1° e +6,6°</b> de elevação: ela sobe, raspa o horizonte e afunda atrás do
          relevo. O disco da Terra mede <b>1,8° a 2,05°</b> — quase 4× o Sol — e o sinal de rádio leva <b>1,19 a 1,36 s</b> (correção
          LT+S, a mesma do Sol).
        </p>
        <p className="mt-3">
          O mapa de horizontes é reaproveitado: para cada instante, compara-se a elevação da Terra com o horizonte na direção dela.
          Mas o cache precisou ser refeito <b>uma vez</b>: para acelerar o Sol, os horizontes eram cortados em ~1,9° acima da
          colatitude, e uma montanha de 5° ficaria guardada como ~2° — a Terra a 4° pareceria visível. O novo teto é de 8,5°.
        </p>
        <p className="mt-3">
          Três estados por pixel: <b className="text-sun-300">Sobrevivência</b> (Sol visível), <b className="text-ice-400">Operação</b>
          (Terra visível) e <b className="text-emerald-300">Zona de Ouro</b> (os dois). Na análise anual, a métrica de portfólio é a
          <b> maior janela contínua de Zona de Ouro</b>.
        </p>
        <p className="mt-3 text-[13px] text-slate-400">
          Os níveis de enlace por fração do disco (banda larga ≥ 99,9%, degradado ≥ 50%, emergência &gt; 0, LOS = 0) são
          <b> heurísticos</b>: o enlace real depende de qual estação da DSN está no disco visível e da difração na borda do relevo
          (ITU-R P.526). Um link budget completo é o próximo passo natural.
        </p>
      </Section>

      <Section title="Pontuação dos locais de pouso">
        <p>
          A maior janela contínua de Zona de Ouro, sozinha, satura em ~17 dias (o teto imposto pela libração) e não separa os
          candidatos. A pontuação composta pondera três grandezas, todas adimensionais — dias divididos pelo mês sinódico
          (29,53 d) —, para que os pesos expressem importância relativa e não conversão de unidades:
        </p>
        <pre className="my-3 rounded-lg bg-space-950 p-3 font-mono text-[13px] text-slate-200">
{`Score = A·(maior janela de ouro / T) + B·(fração anual de ouro) − C·(pior apagão / T)
pior apagão = max(maior noite contínua, maior LOS contínuo)`}
        </pre>
        <p>
          O pior apagão é o que limitar primeiro: bateria (sem Sol) ou autonomia sem comando (sem Terra). Com pesos iguais, o local
          com a maior janela (17,5 d, mas 19,5 d de escuridão) cai para +0,26; o líder passa a ser o pico de 83,8% de Sol com
          apenas 6 dias de noite (+0,59). Com A = 1 e B = C = 0, a pontuação reproduz exatamente o ranking só por janela. Os pesos
          podem ser ajustados ao vivo na aba Análise anual (re-ranqueamento de 562 500 pixels em ~0,2 s).
        </p>
      </Section>

      <Section title="Contagem regressiva (T-minus)">
        <p>
          Ao clicar num pixel, o servidor procura o próximo pôr ou nascer do Sol e o próximo LOS/AOS da Terra. Primeiro faz uma
          varredura de hora em hora (até 60 dias) com o perfil de horizonte do pixel; a primeira mudança de estado isola o evento
          numa janela de 1 h, e a bisseção do scipy encontra a raiz de f(t) = elevação − horizonte(azimute) ± raio do disco.
        </p>
        <p className="mt-3">
          A raiz é refinada pelo ray-casting exato, não pela interpolação do perfil: perto do polo o Sol quase não sobe (0,003°/h) — ele
          desliza de lado (0,5°/h) atrás de um relevo denteado, e a interpolação a cada 2° chegou a errar um nascer em 2,3 h. A
          incerteza física exibida (±6 min no Sol, ±45 min na Terra) vem do relevo de 80 m, não da bisseção.
        </p>
      </Section>

      <Section title="Relevo 3D com quadtree (Nível de Detalhe)">
        <p>
          O DEM inteiro (608 km a 80 m) teria 58 milhões de vértices — ~2 GiB de geometria, o bastante para travar a aba; a 10 m
          seriam 110 GiB. Por isso o relevo 3D é uma quadtree: o servidor fatia o GeoTIFF (um COG com overviews) em tiles de
          128 × 128 células lidos sob demanda em milissegundos, e o navegador só carrega os tiles cuja célula, projetada na tela, passa
          de 4 pixels. Longe, poucos tiles grosseiros; perto do alvo, tiles de 74 m. O que sai da vista é expurgado da GPU dentro de um
          orçamento de 128 MB — é o princípio do Google Earth e do Flight Simulator. O painel “Quadtree LOD” mostra os números ao vivo.
        </p>
        <p>
          A curvatura é feita na GPU: um vertex shader leva cada vértice do plano polar estereográfico à esfera de 1.737,4 km (a
          superfície cai 25,7 km a 300 km do polo) e gira as normais para a vertical local. O exagero vertical vale só para o
          relevo, não para a esfera. Como o three.js descarta e clica contra a geometria plana, o descarte fica com a quadtree
          (caixas que incluem a curvatura) e o clique usa uma cópia curvada do tile.
        </p>
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
          <li>A visibilidade da Terra usa o disco inteiro como alvo; a estação terrestre específica e a difração não são modeladas.</li>
          <li>Janelas contínuas têm a resolução do passo de tempo da análise anual (12 h).</li>
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
