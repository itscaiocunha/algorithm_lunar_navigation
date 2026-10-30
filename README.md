# Lunar Navigator

[![CI](https://github.com/itscaiocunha/algorithm_lunar_navigation/actions/workflows/ci.yml/badge.svg)](https://github.com/itscaiocunha/algorithm_lunar_navigation/actions/workflows/ci.yml)

Projeto algorítmico de navegação lunar em Python, usando **NumPy**,
**SpiceyPy** (NASA/NAIF SPICE) e **FastAPI**.

**Deep dive:** [De 54 minutos a 106 milissegundos](docs/DEEP_DIVE.md), como o cálculo de oclusão
topográfica de 562 500 pixels foi vetorizado e reduzido a uma consulta por instante.

## Estrutura

```
alg_lunar_navigator/
├── src/lunar_navigator/   # código-fonte
│   ├── api.py             #   app FastAPI
│   ├── ephemeris.py       #   SPICE: posição, elevação e azimute do Sol e da Terra
│   ├── link.py            #   estados por pixel: energia, enlace DTE, Zona de Ouro
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
├── docs/                  # BIBLIOTECAS, ILUMINACAO, DEEP_DIVE, DEPLOY, REFERENCIAS
├── .github/               # CI (ci.yml), dados derivados (dados.yml), release (release.yml)
├── Dockerfile             # multi-estágio: runtime e bundle
├── compose.yaml           # execução local em contêiner + pré-cálculo
├── requirements.txt       # dependências de execução
├── requirements-dev.txt   # + dependências de teste e lint (pytest, ruff)
└── pyproject.toml         # metadados e config do pytest e do ruff
```

## Configuração (Windows / PowerShell)

Requer Python 3.12+.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
```

Baixe os dados de entrada (kernels SPICE + DEM LOLA, ~322 MB, com verificação SHA-256):

```powershell
python scripts/baixar_dados.py
```

## Verificar o ambiente

```powershell
python scripts/check_env.py   # importa e mostra versões
pytest                        # 138 testes (os do modo rápido exigem scripts/mapa_anual.py)
ruff check src tests scripts  # lint
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
python scripts/mapa_anual.py          # 2027: Sol, Terra (DTE) e Zona de Ouro + candidatos a pouso
```

## Dashboard web

Requer Node.js 20+ para compilar o frontend (uma vez, e a cada mudança nele):

```powershell
cd frontend; npm install; npm run build; cd ..
python scripts\servidor.py     # sobe a API e abre http://127.0.0.1:8000 no navegador
```

- **Iluminação num instante:** Sol (energia), Terra (rádio, hachura) e Zona de Ouro em 2D (deck.gl),
  Energia × Rádio lado a lado e relevo 3D (React Three Fiber); tooltip com a telemetria do pixel.
  Clique num pixel (ou escolha um alvo Artemis III/CLPS no catálogo) para a telemetria e a contagem
  regressiva T− até o próximo pôr do Sol e a próxima perda de sinal (LOS).
- **Análise anual:** Sol, visada para a Terra, Zona de Ouro e candidatos a pouso por pontuação composta
  (janela de ouro, fração de ouro e pior apagão), com pesos ajustáveis ao vivo.
- **Metodologia:** pipeline, validação e limitações.

O modo rápido e a aba anual exigem rodar `scripts/mapa_anual.py` uma vez (gera os caches).
Para desenvolver o frontend com recarga automática, veja [frontend/README.md](frontend/README.md).

## Contêiner

```powershell
docker compose up --build              # http://localhost:8000
docker compose run --rm precalculo     # horizontes + análise anual (uma vez)
```

Imagem multi-estágio com dados verificados por hash, usuário sem privilégios e healthcheck. O CI
(GitHub Actions) roda lint, tipos e testes do frontend e do backend, e faz o build e o smoke test
do contêiner a cada push. Detalhes, medições e deploy em nuvem em [docs/DEPLOY.md](docs/DEPLOY.md).

## Documentação

- [docs/BIBLIOTECAS.md](docs/BIBLIOTECAS.md): cada biblioteca, conceitos e exemplos.
- [docs/ILUMINACAO.md](docs/ILUMINACAO.md): dados, algoritmo, desempenho e limitações do mapa de iluminação.
- [docs/REFERENCIAS.md](docs/REFERENCIAS.md): fontes dos dados, artigos científicos e software, com DOIs.
- [docs/DEEP_DIVE.md](docs/DEEP_DIVE.md): a escada de otimizações, medida degrau a degrau.
- [docs/DEPLOY.md](docs/DEPLOY.md): Docker, CI/CD e deploy em nuvem.
