# Lunar Navigator

Projeto algorítmico de navegação lunar em Python, usando **NumPy**,
**SpiceyPy** (NASA/NAIF SPICE) e **FastAPI**.

## Estrutura

```
alg_lunar_navigator/
├── src/lunar_navigator/   # código-fonte
│   ├── api.py             #   app FastAPI
│   ├── solar.py           #   SPICE: elevação/azimute do Sol num ponto
│   ├── terrain.py         #   DEM LOLA (GeoTIFF) como matriz NumPy
│   ├── illumination.py    #   ray-casting vetorizado de luz/sombra
│   ├── horizon.py         #   horizontes pré-calculados (iluminação instantânea)
│   ├── annual.py          #   estatísticas anuais e Picos da Luz Eterna
│   ├── service.py         #   estado da API (kernels, DEM, caches, locks)
│   └── render.py          #   matrizes NumPy -> PNG/base64
├── frontend/              # dashboard React + TypeScript (deck.gl, React Three Fiber, Tailwind)
├── tests/                 # testes de cada biblioteca + algoritmos
├── scripts/               # check_env, elevacao_solar, mapa_iluminacao, ...
├── kernels/               # kernels SPICE (não versionados, exceto lunar.tm)
├── data/dem/              # DEMs LOLA (não versionados)
├── output/                # mapas gerados (não versionados)
├── docs/                  # BIBLIOTECAS.md, ILUMINACAO.md
├── requirements.txt       # dependências de execução
├── requirements-dev.txt   # + dependências de teste
└── pyproject.toml         # metadados e config do pytest
```

## Configuração (Windows / PowerShell)

Requer Python 3.12+.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
```

## Verificar o ambiente

```powershell
python scripts/check_env.py   # importa e mostra versões
pytest                        # roda os testes de NumPy, SpiceyPy e FastAPI
```

## Executar a API

```powershell
uvicorn lunar_navigator.api:app --reload --app-dir src
```

Documentação interativa em <http://127.0.0.1:8000/docs>.

## Mapa de iluminação do polo sul

```powershell
python scripts/elevacao_solar.py      # elevação do Sol num ponto (esfera lisa)
python scripts/mapa_iluminacao.py     # luz/sombra com relevo LOLA -> output/
python scripts/mapa_anual.py          # % do tempo iluminado em 2027 + Picos da Luz Eterna
```

## Dashboard web

Requer Node.js 20+ para compilar o frontend (uma vez, e a cada mudança nele):

```powershell
cd frontend; npm install; npm run build; cd ..
python scripts\servidor.py     # sobe a API e abre http://127.0.0.1:8000 no navegador
```

- **Iluminação num instante:** mapa 2D (deck.gl), comparação lado a lado e relevo 3D
  (React Three Fiber); clique em qualquer ponto para traçar o raio até o Sol.
- **Análise anual:** % do tempo iluminado, sombras permanentes e Picos da Luz Eterna.
- **Metodologia:** pipeline, validação e limitações.

O modo rápido e a aba anual exigem rodar `scripts/mapa_anual.py` uma vez (gera os caches).
Para desenvolver o frontend com recarga automática, veja [frontend/README.md](frontend/README.md).

## Documentação

- [docs/BIBLIOTECAS.md](docs/BIBLIOTECAS.md): cada biblioteca, conceitos e exemplos.
- [docs/ILUMINACAO.md](docs/ILUMINACAO.md): dados, algoritmo, desempenho e limitações do mapa de iluminação.
- [docs/REFERENCIAS.md](docs/REFERENCIAS.md): fontes dos dados, artigos científicos e software, com DOIs.
