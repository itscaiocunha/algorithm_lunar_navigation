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
| Vetorizado (NumPy) | ~14 s |
| Mesmo código, um pixel por vez | ~33 h (extrapolado de 300 px) |

Os dois produzem resultados idênticos. A elevação do Sol calculada pelo
motor vetorizado coincide com a do `solar.py`/SPICE até 10⁻⁶ grau.

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
