# Iluminação solar do polo sul lunar

Pipeline que combina a geometria precisa do SPICE com o relevo do LOLA para
gerar mapas de luz/sombra em segundos.

```
SPICE (kernels)  ──►  posição aparente do Sol em MOON_ME  ─┐
                                                            ├──► ray-casting vetorizado ──► fração do disco solar visível
DEM LOLA (GeoTIFF) ──► matriz NumPy de alturas (m)  ───────┘                                (PNG + GeoTIFF)
```

## Dados

| Arquivo | Fonte | Conteúdo |
|---|---|---|
| `data/dem/LDEM_80S_80MPP_ADJ.TIF` (181 MB) | [PGDA/GSFC — LOLA South Pole](https://pgda.gsfc.nasa.gov/products/90), Barker et al. (2023) — ver [REFERENCIAS.md](REFERENCIAS.md) | Alturas em metros sobre esfera de 1737,4 km; 80°S–90°S; 7600×7600 px de 80 m |

- Projeção polar estereográfica sul (`+proj=stere +lat_0=-90 +R=1737400`), no frame MOON_ME.
- O mapa é quadrado (608 × 608 km): os cantos chegam a ~75,9°S e também têm dados de altitude.
- Há versões de 40, 20 e 10 m/px no mesmo site (685 MB a 4,8 GB). Para usar
  uma delas, passe `--dem caminho.tif` (o código lê a resolução do arquivo).

Download:
```powershell
curl.exe -o data/dem/LDEM_80S_80MPP_ADJ.TIF https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ.TIF
```

## Módulos

| Módulo | Responsabilidade |
|---|---|
| `terrain.py` | Lê o GeoTIFF com **rasterio** e converte mapa (x, y) ↔ vetor 3D em MOON_ME |
| `illumination.py` | Ray-casting vetorizado: horizonte na direção do Sol e fração do disco visível |
| `ephemeris.py` | SPICE: tempo, observador, vetores do Sol e da Terra, elevação/azimute |
| `link.py` | Estados por pixel: energia, enlace DTE (níveis heurísticos) e Zona de Ouro |

## O algoritmo

Para cada pixel `P` um raio sai em direção ao centro do Sol. Em vez de um
laço por pixel, o laço é sobre a **distância `t`** ao longo do raio, e cada
passo processa **todos os pixels de uma vez** com NumPy:

1. `Q = P + t·ŝ` — ponto do raio em 3D.
2. `(x, y) = projeção(Q)` — fórmula estereográfica fechada, sem trigonometria.
3. `h = DEM[x, y]` — altura do terreno sob o raio.
4. `T = Q̂·(R + h)` — ponto do terreno sob o raio; calcula-se a elevação de
   `T` vista de `P` e guarda-se o máximo (= **horizonte** na direção do Sol).
5. O passo cresce com a distância (`Δt = max(80 m, 1%·t)`): fino perto,
   largo longe, onde o relevo ocupa ângulos menores.
6. Um pixel sai do laço quando o raio deixa o mapa, quando a borda inferior
   do disco solar passa acima do pico mais alto do DEM, ou quando o Sol já
   está totalmente encoberto.

**Por que 3D e não um plano?** Com o Sol a ~1,5°, o raio sobe 2,6 km em
100 km, mas a curvatura lunar "derruba" a superfície 2,9 km nessa mesma
distância. Um modelo plano erraria grosseiramente no polo.

**Fração do disco:** o Sol tem ~0,27° de raio aparente e, no polo, vive
raspando o horizonte. O resultado é a fração (0–1) do disco acima do
horizonte topográfico, e não apenas luz/sombra.

## Uso

```powershell
python scripts/mapa_iluminacao.py                                   # ±30 km em torno do polo
python scripts/mapa_iluminacao.py --utc "2026-11-20 00:00 UTC"
python scripts/mapa_iluminacao.py --center-lat -89.67 --center-lon 129.8 --half-size-km 15
python scripts/mapa_iluminacao.py --half-size-km 150 --downsample 4  # área grande, 320 m/px
python scripts/benchmark_iluminacao.py                              # validação + velocidade
```

Saídas em `output/`: PNG (topografia + iluminação) e GeoTIFF georreferenciado
(abre direto no QGIS).

## Desempenho medido (562 500 px, 80 m, ±30 km)

| Método | Tempo |
|---|---|
| Vetorizado (NumPy), blocos de 65 536 px | ~10 s |
| Vetorizado, toda a malha de uma vez (versão inicial) | ~14 s |
| Mesmo código, um pixel por vez | ~33 h (extrapolado de 300 px) |

Os três produzem resultados idênticos. Processar em blocos mantém os arrays
temporários no cache da CPU (a operação é limitada por banda de memória).
A elevação do Sol calculada pelo motor vetorizado coincide com a do
`ephemeris.py`/SPICE até 10⁻⁶ grau.

## Validação (`tests/test_illumination.py`)

- Projeção conferida contra a biblioteca PROJ (via rasterio) e ida-e-volta.
- Esfera lisa: Sol a +1° → luz, −1° → sombra, 0° → meio disco.
- Parede sintética de 1 km a 8 km: horizonte calculado dentro da célula da
  parede (incluindo curvatura); sombra/luz corretas de cada lado.
- Resultado independente do tamanho do bloco (`chunk_size`).

## Limitações

- Resolução de 80 m: crateras menores que ~2 pixels não aparecem.
- Terreno além da borda do mapa (80°S) é ignorado. Para o polo isso é seguro
  (o raio passa acima do relevo bem antes), mas não para pontos perto da borda.
- O DEM usa MOON_ME da DE421; os kernels usam DE440. A diferença é de
  dezenas de metros na superfície, abaixo do pixel de 80 m.
- Amostragem por vizinho mais próximo; picos estreitos muito distantes podem
  ser pulados pelo passo crescente (ajuste com `--growth`).
- Não considera luz refletida pela Terra ou pelo próprio terreno.

---

# Análise de longo prazo (`scripts/mapa_anual.py`)

## Método de horizontes

Iterar o motor direto a cada 12 h em 2027 custaria 730 × ~10 s ≈ 2 h, sem
reaproveitamento. Como o relevo não muda, `horizon.py` calcula **uma vez** o
horizonte de cada pixel em 180 azimutes (passo de 2°), com o mesmo
ray-marching vetorizado em raios horizontais, e guarda em
`data/cache/horizon_*.npz` (~200 MB, float16). Depois, qualquer instante é:

```
fração = disco_visível(elevação_do_Sol − horizonte_interpolado(azimute_do_Sol))
```

em ~0,1 s para os 562 500 pixels (Mazarico et al., 2011).

- **Corte de faixa:** perto do polo o Sol nunca passa de colatitude + ~1,6°
  de elevação; horizontes fora de ±(colatitude + 1,9°) são cortados, o que
  permite encerrar os raios cedo sem alterar o resultado.
- **Paralelismo:** azimutes independentes → `ProcessPoolExecutor` (6 processos).
- **Custo medido:** pré-cálculo 869 s (uma vez); 730 instantes em 85 s.

### Validação contra o motor direto

| Instante (aleatório, 2027) | Luz/sombra iguais | \|Δ fração\| médio |
|---|---|---|
| 2027-02-02 13:00 | 99,84% | 0,0017 |
| 2027-06-10 04:00 | 99,91% | 0,0009 |
| 2027-08-27 21:00 | 99,82% | 0,0018 |
| 2027-10-10 10:00 | 99,86% | 0,0015 |

As divergências (~0,15%) ficam em bordas de sombra, pela interpolação entre
azimutes a cada 2°. Reproduza com `python scripts/mapa_anual.py --validar 4`.

## Métricas por pixel

| Métrica | Significado |
|---|---|
| `illumination_pct` | Média da fração do disco visível (% do tempo com Sol, ponderado pelo disco) |
| `any_sun_pct` | % dos instantes com qualquer parte do Sol visível |
| `longest_night_h` | Maior sequência contínua sem Sol — dimensiona baterias |
| `psr` | Nenhum Sol em todo o período: candidata a sombra permanente / armadilha fria |

## Resultado 2027 (±30 km do polo, a cada 12 h)

- Sem Sol o ano inteiro: **595,6 km²** (16,5% da área), incluindo o fundo da Shackleton.
- Pixel mais iluminado: **83,8%** (−89,451°, −137,14°E, 1957 m), crista a sudoeste da
  Shackleton, a 2,6 km de uma região de sombra permanente; maior noite de 6 dias.
- Tabela completa: `output/anual_2027_picos.json`.

**Comparação com a literatura:** Bussey et al. (2010) indicam como ponto mais
iluminado do polo sul 88,74°S, 124,5°E (86% em 2020). Ele está a ~38 km do
polo, **fora** do recorte de ±30 km usado aqui; nosso pico nº 10 está na borda
do recorte nessa direção. Para incluí-lo, rode com `--half-size-km 45` (novo
cache de horizontes, ~2,5× mais pixels).

**Atenção:** um ano não é um ciclo completo. A geometria Sol–Lua se repete em
~18,6 anos; "sombra permanente" aqui significa "sem Sol em 2027".

---

# Comunicação direta com a Terra (DTE) e Zona de Ouro

## A física: libração, não rotação

A Lua tem rotação sincronizada, então a Terra não nasce nem se põe: ela paira
quase fixa no céu, perto do meridiano 0° (+Y do mapa). O que a esconde é a
**libração**. Medido com SPICE no polo sul, de 2026 a 2035, a cada 6 h:

| Grandeza | Valor |
|---|---|
| Elevação da Terra no polo | −7,10° a +6,62° |
| Direção (longitude no MOON_ME) | −8,0° a +8,1° |
| Diâmetro aparente do disco | 1,80° a 2,05° (≈ 4× o Sol) |
| Atraso do sinal (LT+S) | 1,189 a 1,357 s |
| Terra acima do horizonte liso, no polo | 49,1% do tempo |

Para um ponto da superfície, a paralaxe da Terra chega a 0,27° (raio lunar /
distância Terra-Lua), por isso a direção é calculada pixel a pixel (`spkcpo`
e `HorizonMap.target_angles`), não a partir do centro da Lua.

## Reaproveitamento do mapa de horizontes, com uma ressalva

O mesmo cache de horizontes serve ao Sol e à Terra: em cada instante,
compara-se a elevação de cada corpo com o horizonte na direção dele, sem
traçar raios novos. **Porém o cache original não servia:** para acelerar o
Sol, os horizontes eram cortados em colatitude + 1,9° (o Sol nunca sobe mais
que isso). Uma montanha de 5° ficava guardada como ~2°, e a Terra a 4° pareceria
visível. O teto agora é colatitude + 8,5° (`horizon.EARTH_LIMIT_DEG`), e a chave do
cache inclui o teto, para que um cache antigo nunca seja reutilizado por
engano. O teste `test_sun_only_cache_would_hide_earth_occlusion` reproduz o erro.

## Estados lógicos por pixel (`link.py`)

| Estado | Condição | Cor no mapa |
|---|---|---|
| Sobrevivência | fração do Sol > 0 | amarelo/laranja (escala inferno) |
| Operação | fração da Terra > 0 | hachura diagonal ciano |
| **Zona de Ouro** | as duas | verde (emerald) |
| Nenhum | — | preto |

Níveis de enlace por fração visível do disco da Terra: banda larga (≥ 99,9%),
RF degradada (≥ 50%), telemetria de emergência (> 0) e LOS (= 0). **Esses limiares
são heurísticos.** O enlace real depende de qual estação da DSN está na parte
visível do disco e da difração na borda do relevo (ITU-R P.526); um link budget
completo é o próximo passo.

## Métricas anuais adicionais

| Métrica | Significado |
|---|---|
| `earth_pct` / `any_earth_pct` | Média da fração da Terra / % dos instantes com alguma Terra visível |
| `longest_los_h` | Maior sequência contínua sem Terra (autonomia sem comando) |
| `golden_pct` | % dos instantes com Sol E Terra |
| `longest_golden_h` | **Maior janela contínua de Zona de Ouro**: a métrica de portfólio que ordena os candidatos a pouso |

Um local com 60% de Sol cujas janelas coincidem com as da Terra vence um com
80% de Sol e a Terra oculta nos picos de energia (`tests/test_annual.py`).

## Resultado 2027 com Sol + Terra (±30 km do polo, a cada 12 h)

Validação dos horizontes contra o motor direto (3 instantes aleatórios):
visível/oculto iguais em 99,68–99,87% dos pixels para o Sol e **99,86–100%
para a Terra**. Tempo: 730 instantes × 2 corpos em 178 s (cache já pronto); o
cache com teto da Terra levou 2038 s, uma única vez (6 processos).

| Grandeza | Valor |
|---|---|
| Sem Sol o ano todo (PSR) | 595,8 km² (16,6% da área) |
| Terra nunca visível | 1291 km² |
| Alguma Zona de Ouro no ano | 2024 km² |
| Janela de ouro contínua ≥ 7 dias | 1299 km² |
| Maior janela de ouro | 17,5 dias (88,84°S, 121,6°E; 1524 m) |

**A janela de ouro sozinha satura.** Os dez melhores por janela ficavam entre
16,5 e 17,5 dias, porque o teto vem da libração: a Terra só fica visível em parte
de cada ciclo de ~27 dias. Em vez de refinar o passo de tempo, o que seria força
bruta para um problema analítico, os candidatos são ordenados por uma
**pontuação composta** (`link.site_score`):

```
Score = A·(maior janela de ouro / T) + B·(fração anual de ouro) − C·(pior apagão / T)
T = 29,53 d (mês sinódico)       pior apagão = max(maior noite, maior LOS)
```

- **Normalização:** dividir os dias por T deixa os três termos adimensionais (~0..1),
  então A, B e C expressam importância relativa, e não conversão de unidades.
- **Penalidade:** o pior apagão é o que limitar primeiro, seja a bateria (sem Sol)
  ou a autonomia sem comando (sem Terra).
- **Consistência:** com pesos (1, 0, 0), a pontuação reproduz exatamente o ranking
  só por janela.

Resultado com pesos (1, 1, 1):

| # | Score | Lat / lon | Janela | Ouro | Sol | Noite | LOS |
|---|---|---|---|---|---|---|---|
| 1 | +0,587 | −89,451°, −137,1° | 15,5 d | 48,5% | 83,8% | 6,0 d | 12,5 d |
| 2 | +0,566 | −89,274°, −113,4° | 16,5 d | 41,4% | 67,2% | 9,5 d | 12,0 d |
| 3 | +0,561 | −89,299°, 131,3° | 16,5 d | 42,6% | 63,8% | 9,0 d | 12,5 d |
| antigo nº 1 (só janela) | +0,257 | −88,840°, 121,6° | 17,5 d | 32,5% | 44,1% | 19,5 d | 11,0 d |

O antigo nº 1 não tinha meses de LOS (só 11 d, como os demais). O que o
derrubou foi a **escuridão de 19,5 d**, que exige uma bateria 35% maior que a do
antigo nº 2. Ainda assim, 31% da área tem ≥ 182 dias seguidos de LOS, e a
penalidade torna esses pixels negativos.

**Robustez:** o líder (o mesmo "Pico da Luz Eterna" de 83,8% de Sol da análise só
com o Sol) fica em 1º com pesos (1,1,1), (1,2,1) e (1,1,2), e em 3º com (2,1,1).
Os pesos podem ser ajustados ao vivo: `GET /api/annual?a=1&b=1&c=2` re-ranqueia os
562 500 pixels em ~0,2 s, sem recalcular a física.

Vários dos melhores locais ficam perto de 88,8°S, 120–124°E, a mesma região
do ponto mais iluminado apontado por Bussey et al. (2010), 88,74°S, 124,5°E.

# Contagem regressiva (`countdown.py`, `GET /api/countdown`)

Para um pixel e um instante t0, calcula o tempo até o próximo pôr ou nascer do
Sol e até o próximo LOS/AOS da Terra, além do início ou fim da degradação de RF
(disco da Terra parcialmente oculto).

**Função de margem** (graus, contínua no tempo):
`f(t) = elevação(t) − horizonte(azimute(t)) ± raio do disco`, com `+` para "alguma
parte visível" (nascer/pôr, AOS/LOS) e `−` para "disco inteiro" (degradação de RF).

**Algoritmo:**

1. **Varredura grossa** a cada 1 h, por até 60 dias, com o perfil de horizonte do
   pixel: 180 azimutes calculados sob demanda em ~0,2 s e guardados em cache,
   então funciona em qualquer ponto do DEM.
2. A **primeira troca de sinal** isola o evento numa janela de 1 h.
3. **Refinamento exato:** o ray-casting na direção real do alvo confirma a troca. Se
   ela caiu fora da janela, a janela se expande hora a hora, até ±6 h. Depois disso,
   `scipy.optimize.bisect` encontra a raiz com tolerância de 5 s.

**Por que o passo 3 existe.** Perto do polo o Sol quase não muda de elevação
(0,003°/h, medido); o pôr acontece porque ele **desliza** lateralmente (0,51°/h)
atrás do relevo. O perfil interpola o horizonte a cada 2° e "apara" entalhes e
picos estreitos: num teste em −89,9°, 0°, o nascer do Sol saía em 13,7 h, contra
16 h do ray-casting direto. Com o refinamento exato, o resultado é 15,94 h.

**Precisão.** A raiz vale para o modelo com tolerância de 5 s, mas o modelo tem
incerteza física. Um erro de 0,05° no horizonte (relevo de 80 m) equivale a ~6 min
no Sol e a ~45 min na Terra, que se move só ~0,07°/h. A API devolve essa incerteza
em `uncertainty_min`. Bisectar até milissegundos seria precisão falsa.

**Validação** (`tests/test_countdown.py`): para cada evento, o ray-casting direto
confirma a troca de estado entre −2 min e +2 min. O perfil sob demanda reproduz o
cache de horizontes (|Δ| < 0,01°). Raízes sintéticas e o caso de janela expandida
também são testados.

**Custo:** ~0,7–1,5 s por clique, quase todo nos ray-castings exatos do refinamento.

# Catálogo de alvos de missão (`frontend/src/lib/presets.ts`)

O seletor "Alvo de missão" leva a telemetria, a contagem regressiva e as câmeras
2D e 3D até um alvo. A NASA não publicou coordenadas centrais nem limites das 13
regiões candidatas do Artemis III; o anúncio de 2022 descreve áreas de 15×15 km.
Por isso, os alvos **Peak Optimized** usam o ponto de melhor pontuação composta
que o modelo encontra junto ao acidente geográfico nomeado. Afirmar que o ponto
fica *dentro* da região oficial não seria verificável.

| Alvo | Coordenada | Validação no modelo LOLA (80 m) |
|---|---|---|
| Connecting Ridge (Peak Optimized) | −89,451°, −137,1° | Candidato nº 1: 1957 m, 83,8% de Sol, janela de ouro de 15,5 d, noite máx. 6 d |
| Peak Near Shackleton (Peak Optimized) | −89,78°, −156,4° | Candidato nº 5: pico de 1737 m **sobre a borda** da Shackleton (10,4 km do centro ≈ raio), 76,7% de Sol |
| Malapert Massif | −85,99°, 2,93° | 5128 m, coerente com um maciço; 122 km do polo, fora da malha |
| VIPER / Mons Mouton (Nobile oeste) | −85,33°, 31,69° | Planalto de 6164 m (acima de 89% do terreno num raio de 24 km), não o centro afundado da Nobile (917 m) |

**Coordenadas descartadas, e o motivo:**

| Coordenada | O que o modelo mostrou |
|---|---|
| Peak Near Shackleton −89,78°, **+129,54°** | Fundo da Shackleton, −2502 m, sem Sol o ano todo |
| Connecting Ridge com **+137,1°** | Dentro da Shackleton, em sombra permanente |
| Faustini Rim A −87,3°, 77,0° | −2772 m, interior da cratera; retirado do catálogo por falta de coordenada validada |
| Nobile −85,28°, 53,27° | Centro da cratera, e não a borda oeste que o VIPER mirava |

**Fontes externas:** cume de Mons Mouton em ~84,6°S, 31°E e local de pouso da IM-2
em 84,79°S, 29,20°E (Wikipedia, Mons Mouton); alvo do VIPER descrito como a borda
oeste da Nobile (NASA SVS 4937, USGS). A coordenada exata do VIPER não foi
encontrada publicada.

**Alvos fora da malha de ±30 km:** telemetria e contagem regressiva funcionam,
porque o DEM vai até 80°S. O 2D afasta o zoom para mostrar o alvo, e o 3D volta à
visão geral.

# API e dashboard

```powershell
uvicorn lunar_navigator.api:app --app-dir src     # http://127.0.0.1:8000
```

| Endpoint | Retorno | Tempo medido |
|---|---|---|
| `GET /` | Dashboard web (build de `frontend/`) | — |
| `GET /api/illumination?utc=2026-11-20T00:00:00Z&lat=-89.9&lon=0` | Telemetria do pixel: Sol e Terra (fração, elevação, azimute, horizonte, nível de energia/enlace, atraso de sinal), status e estatística anual | ~0,3 s |
| `GET /api/countdown?utc=...&lat=...&lon=...` | Tempo até o próximo pôr/nascer do Sol, LOS/AOS e degradação de RF da Terra (segundos, UTC, incerteza) e fim da Zona de Ouro | ~0,7–1,5 s |
| `GET /api/map?utc=...&modo=completo` | PNG do Sol + frações cruas do Sol e da Terra (uint8 base64) + direções + estatísticas dos 4 estados | ~30 s (2 ray-castings) |
| `GET /api/map?utc=...&modo=rapido` | Idem, via horizontes | ~0,5 s |
| `GET /api/map?utc=...&formato=geotiff` | GeoTIFF de 3 bandas: `sun_fraction`, `earth_fraction`, `golden_zone` | — |
| `GET /api/annual?year=2027&metric=score&a=1&b=1&c=1` | Mapa anual (`score`, `golden_window`, `golden_pct`, `illumination_pct` ou `earth_pct`) + sombras permanentes + candidatos re-ranqueados com os pesos A, B, C | ~0,5–1 s |
| `GET /api/basemap` | Relevo sombreado da área | ~0,7 s |
| `GET /api/terrain?step=3` | Altitudes 250×250 (Float32 base64) para a vista 3D | — |
| `GET /api/info` | DEM, área, caches disponíveis | — |

Documentação interativa em `/docs`. O CSPICE não é thread-safe: toda chamada
SPICE passa por um lock em `service.py`, e cálculos de malha rodam um por vez.
