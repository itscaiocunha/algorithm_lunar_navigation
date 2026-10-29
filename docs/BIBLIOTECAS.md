# Bibliotecas do projeto

Este documento explica o papel de cada biblioteca no Lunar Navigator, os
conceitos essenciais para usá-la e como ela é testada.

| Biblioteca | Versão | Papel no projeto | Teste |
|---|---|---|---|
| venv | (stdlib) | Isolamento do ambiente Python | `scripts/check_env.py` |
| NumPy | 2.5.4 | Cálculo numérico e álgebra linear | `tests/test_numpy.py` |
| SpiceyPy | 8.3.0 | Geometria espacial, tempo e efemérides (NASA/NAIF) | `tests/test_spiceypy.py` |
| FastAPI | 0.162.0 | API HTTP para expor os algoritmos | `tests/test_fastapi.py` |
| Uvicorn | 0.54.0 | Servidor ASGI que executa a API | execução manual |
| pytest / httpx | 9.2.0 / 0.28.1 | Execução dos testes / cliente HTTP do TestClient | — |
| rasterio | 1.5.2 | Leitura/escrita de GeoTIFF (DEM LOLA, mapas exportados) | `tests/test_illumination.py` |
| SciPy | 1.18.1 | Regiões de sombra contíguas e distância até elas (`ndimage`) | `tests/test_api_illumination.py` |
| Matplotlib | 3.11.2 | Colormaps e PNGs dos scripts | saídas em `output/` |

Frontend (`frontend/`, Node.js 20+): veja a [seção 10](#10-frontend--react-typescript-deckgl-react-three-fiber-tailwind).

---

## 1. venv — ambiente virtual

**O que é:** módulo da biblioteca padrão do Python que cria um diretório
(`.venv/`) com um interpretador e um `site-packages` próprios. Tudo que for
instalado com `pip` fica restrito ao projeto, sem afetar o Python do sistema
nem outros projetos.

**Por que usar:** garante versões reprodutíveis (fixadas em
`requirements.txt`) e evita conflitos entre projetos.

**Uso:**

```powershell
py -3.12 -m venv .venv                 # criar (uma vez)
.\.venv\Scripts\Activate.ps1           # ativar (PowerShell)
pip install -r requirements-dev.txt    # instalar dependências
deactivate                             # sair do venv
```

> Se o PowerShell bloquear o `Activate.ps1`, rode uma vez:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
> Alternativa sem ativar: chamar `.\.venv\Scripts\python.exe` diretamente.

**Teste:** `python scripts/check_env.py` informa se o venv está ativo e
se todas as bibliotecas importam corretamente.

---

## 2. NumPy — computação numérica

**O que é:** a base do ecossistema científico em Python. Fornece o
`ndarray` (array N-dimensional homogêneo e contíguo em memória) e operações
vetorizadas implementadas em C, muito mais rápidas que laços Python.

**Conceitos principais para o projeto:**

- **Vetores e matrizes:** posições/velocidades como `np.array([x, y, z])`,
  matrizes de rotação 3×3.
- **Álgebra linear (`np.linalg`):** `norm`, `solve`, `inv`, `det`, `eig` —
  essenciais para estimação de estado e filtros (ex.: Kalman).
- **Operador `@`:** multiplicação matricial (`R @ v`).
- **Vetorização e broadcasting:** operar sobre milhares de vetores de uma vez
  (`np.linalg.norm(vetores, axis=1)`).
- **`np.random.default_rng(seed)`:** gerador moderno e reprodutível, útil
  para simular ruído de sensores.
- **`np.testing.assert_allclose`:** comparação de ponto flutuante com
  tolerância — use sempre isso em vez de `==` nos testes.

```python
import numpy as np

r = np.array([384_400.0, 0.0, 0.0])      # km
v = np.array([0.0, 1.022, 0.0])          # km/s
h = np.cross(r, v)                       # momento angular específico
print(np.linalg.norm(h))
```

**O que o teste verifica:** versão ≥ 2, produto vetorial/escalar,
ortonormalidade de matriz de rotação, solução de sistema linear e normas
vetorizadas.

---

## 3. SpiceyPy — geometria espacial (NASA/NAIF SPICE)

**O que é:** wrapper Python do **CSPICE**, o toolkit da NASA/NAIF usado em
missões reais para calcular posições de corpos celestes e espaçonaves,
conversões de tempo, sistemas de referência e orientação. As funções têm os
mesmos nomes do CSPICE (`spkpos`, `str2et`, `pxform`…), então a
documentação oficial da NAIF vale diretamente.

**Conceito central — kernels:** o SPICE não traz dados embutidos; ele
carrega arquivos chamados *kernels*:

| Tipo | Extensão | Conteúdo | Exemplo |
|---|---|---|---|
| LSK | `.tls` | Segundos intercalares (conversão UTC ↔ TDB) | `naif0012.tls` |
| SPK | `.bsp` | Efemérides (posições/velocidades) | `de440s.bsp` |
| PCK | `.tpc` / `.bpc` | Constantes e orientação de corpos | `pck00011.tpc`, `moon_pa_de440_200625.bpc` |
| FK | `.tf` | Definição de referenciais | `moon_de440_250416.tf` |
| MK | `.tm` | *Meta-kernel*: lista de kernels a carregar | `lunar.tm` |

Os kernels genéricos ficam em
<https://naif.jpl.nasa.gov/pub/naif/generic_kernels/>. Neste projeto eles
devem ser colocados na pasta `kernels/` (ignorada pelo git por serem
grandes).

**Conjunto usado no projeto** (carregado pelo meta-kernel `kernels/lunar.tm`):

| Necessidade | Arquivo | Origem (generic_kernels/) |
|---|---|---|
| Conversão de tempo (UTC ↔ TDB) | `latest_leapseconds.tls` (= `naif0012.tls`) | `lsk/` |
| Efemérides Sol/Terra/Lua | `de440.bsp` (1550–2650) | `spk/planets/` |
| Raios e rotação IAU dos corpos | `pck00011.tpc` | `pck/` |
| Orientação precisa da Lua | `moon_pa_de440_200625.bpc` | `pck/` |
| Frames `MOON_PA` / `MOON_ME` | `moon_de440_250416.tf` | `fk/satellites/` |

O PCK binário e o FK da Lua são **casados com a DE440**: não misture com
outra efeméride (ex.: DE430). Use `MOON_ME` (Mean Earth/polar axis) para
coordenadas de superfície/cartografia e `MOON_PA` (Principal Axis) para
dinâmica. Para inspecionar qualquer kernel:
`python scripts/inspect_kernels.py kernels/<arquivo>`.

**Conceitos principais:**

- **Tempo ET (Ephemeris Time / TDB):** segundos desde J2000.
  `spice.str2et("2026-10-29T12:00:00")` exige um LSK carregado.
- **`spice.furnsh(caminho)`:** carrega um kernel; `spice.kclear()` descarrega todos.
- **`spice.spkpos(alvo, et, ref, aberração, observador)`:** posição de um
  corpo em relação a outro.
- **`spice.pxform(de, para, et)`:** matriz de rotação entre referenciais
  (ex.: `"J2000"` → `"MOON_ME"`).
- **Rotinas matemáticas sem kernel:** `vnorm`, `vhat`, `vcrss`, `mxv`,
  `rotate`, `reclat`/`latrec`, `recsph`; constantes `pi`, `rpd`, `dpr`,
  `j2000`, `spd`, `clight`.
- **Erros:** falhas do CSPICE viram exceções Python (`SpiceyError`).

```python
import spiceypy as spice

spice.furnsh("kernels/lunar.tm")   # carrega todos os kernels (rodar da raiz)

et = spice.str2et("2026-10-29T12:00:00")
pos, lt = spice.spkpos("MOON", et, "J2000", "LT+S", "EARTH")
print(pos, "km  | tempo-luz:", lt, "s")

rot = spice.pxform("J2000", "MOON_ME", et)   # inercial -> fixo na Lua
radii = spice.bodvrd("MOON", "RADII", 3)[1]  # [1737.4, 1737.4, 1737.4] km
spice.kclear()
```

**O que o teste verifica (sem precisar de kernels):** versão do CSPICE,
constantes, rotinas vetoriais, rotação comparada ao resultado esperado,
conversão retangular↔latitudinal ida-e-volta, e que a ausência de LSK gera
`SpiceyError` (prova que o tratamento de erros está ativo).

---

## 4. FastAPI — API HTTP

**O que é:** framework web moderno, baseado em *type hints*, que gera
validação automática de dados (via **Pydantic**) e documentação interativa
OpenAPI. Roda sobre **Starlette** (ASGI).

**Conceitos principais:**

- **Rotas:** decoradores `@app.get`, `@app.post`, etc.
- **Modelos Pydantic (`BaseModel`):** definem o formato de entrada/saída;
  dados inválidos retornam **HTTP 422** automaticamente.
- **`response_model`:** valida e documenta a resposta.
- **Docs automáticas:** `/docs` (Swagger UI) e `/redoc`.
- **`TestClient`:** testa a API em memória, sem subir servidor.

**API inicial (`src/lunar_navigator/api.py`):**

| Método | Rota | Descrição |
|---|---|---|
| GET | `/` | Redireciona para `/docs` |
| GET | `/health` | Verificação de vida |
| GET | `/versions` | Versões de Python, NumPy, SpiceyPy e CSPICE |
| POST | `/convert/rect-to-spherical` | Converte `{x, y, z}` em coordenadas esféricas usando `spice.recsph` |

**Executar:**

```powershell
uvicorn lunar_navigator.api:app --reload --app-dir src
# abrir http://127.0.0.1:8000/docs
```

**O que o teste verifica:** `/health`, `/versions`, a conversão de
coordenadas (integração FastAPI + NumPy + SpiceyPy) e o erro 422 para
entrada inválida.

---

## 5. Uvicorn

Servidor **ASGI** de alto desempenho que executa a aplicação FastAPI. O
extra `[standard]` instala `uvloop`/`httptools`/`watchfiles` (este último
habilita o `--reload`, que reinicia o servidor ao salvar arquivos).

## 6. pytest e httpx

- **pytest:** executor de testes. Descobre arquivos `tests/test_*.py` e
  funções `test_*`. Configurado em `pyproject.toml` (inclui `src/` no
  `PYTHONPATH`).
- **httpx:** cliente HTTP usado internamente pelo `TestClient` do FastAPI.

```powershell
pytest                          # todos os testes
pytest tests/test_spiceypy.py   # só uma biblioteca
pytest -k rotation              # filtra por nome
```

---

## 7. rasterio — GeoTIFF

**O que é:** interface Python do GDAL para dados raster georreferenciados.

**Uso no projeto:** `terrain.load_dem` lê o DEM LOLA (`LDEM_80S_80MPP_ADJ.TIF`)
como matriz NumPy, junto com a projeção (CRS) e a transformação pixel → metros;
os scripts e a API gravam os mapas calculados como GeoTIFF, que abrem no QGIS.

```python
import rasterio
with rasterio.open("data/dem/LDEM_80S_80MPP_ADJ.TIF") as src:
    alturas = src.read(1)          # matriz NumPy (m)
    print(src.crs, src.transform)  # polar estereográfica, 80 m/pixel
```

**Teste:** a projeção do código é conferida contra o PROJ (via rasterio).

## 8. SciPy — análise espacial

**Uso no projeto:** em `annual.py`, `ndimage.label` agrupa pixels de sombra
permanente em regiões contíguas e `ndimage.distance_transform_edt` mede a
distância de cada pixel até a sombra mais próxima (coluna "Até a sombra" dos
Picos da Luz Eterna).

## 9. Matplotlib — colormaps e figuras

**Uso no projeto:** fornece a escala de cores *inferno* usada nos mapas
(`render.py`) e gera os PNGs dos scripts (`mapa_iluminacao.py`, `mapa_anual.py`).

---

## 10. Frontend — React, TypeScript, deck.gl, React Three Fiber, Tailwind

Fica em `frontend/` e é compilado para `frontend/dist`, que o FastAPI serve em `/`.
Detalhes e comandos em [frontend/README.md](../frontend/README.md).

| Biblioteca | Papel |
|---|---|
| React 19 + TypeScript (strict) | Componentes da interface, com tipos que espelham as respostas da API (`src/lib/api.ts`) |
| Vite | Servidor de desenvolvimento (com proxy para a API) e build |
| deck.gl | Mapa 2D: camadas raster, grade lat/lon, picos e clique, no plano polar estereográfico (`OrthographicView`) |
| React Three Fiber + drei (three.js) | Vista 3D do relevo com a iluminação como textura |
| Tailwind CSS v4 | Estilo e tema (`src/index.css`) |
| vitest / oxlint | Testes da geometria (`src/lib/geo.test.ts`) e lint |

```powershell
cd frontend
npm install
npm run build      # gera dist/
npx vitest run     # testes
```
