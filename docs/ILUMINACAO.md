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
- O mapa é quadrado: os cantos (até ~75,9°S) não têm dados e nunca bloqueiam a luz.
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
| `solar.py` | SPICE: tempo, observador, vetor do Sol, elevação/azimute (já existente) |

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
`solar.py`/SPICE até 10⁻⁶ grau.

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

# API e dashboard

```powershell
uvicorn lunar_navigator.api:app --app-dir src     # http://127.0.0.1:8000
```

| Endpoint | Retorno | Tempo medido |
|---|---|---|
| `GET /` | Dashboard web (`web/`) | — |
| `GET /api/illumination?utc=2026-11-20T00:00:00Z&lat=-89.9&lon=0` | Fração, status, elevação/azimute do Sol, horizonte, altitude e estatística anual do pixel | ~0,15 s |
| `GET /api/map?utc=...&modo=completo` | PNG base64 + limites + estatísticas | ~10,5 s |
| `GET /api/map?utc=...&modo=rapido` | Idem, via horizontes | ~0,3 s |
| `GET /api/map?utc=...&formato=geotiff` | GeoTIFF para download | — |
| `GET /api/annual?year=2027` | Mapa de calor anual + sombras permanentes + picos | ~0,8 s |
| `GET /api/basemap` | Relevo sombreado da área | ~0,7 s |
| `GET /api/info` | DEM, área, caches disponíveis | — |

Documentação interativa em `/docs`. O CSPICE não é thread-safe: toda chamada
SPICE passa por um lock em `service.py`, e cálculos de malha rodam um por vez.
