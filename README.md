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
│   └── illumination.py    #   ray-casting vetorizado de luz/sombra
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
```

## Documentação

- [docs/BIBLIOTECAS.md](docs/BIBLIOTECAS.md): cada biblioteca, conceitos e exemplos.
- [docs/ILUMINACAO.md](docs/ILUMINACAO.md): dados, algoritmo, desempenho e limitações do mapa de iluminação.
- [docs/REFERENCIAS.md](docs/REFERENCIAS.md): fontes dos dados, artigos científicos e software, com DOIs.
