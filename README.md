# Lunar Navigator

Projeto algorítmico de navegação lunar em Python, usando **NumPy**,
**SpiceyPy** (NASA/NAIF SPICE) e **FastAPI**.

## Estrutura

```
alg_lunar_navigator/
├── src/lunar_navigator/   # código-fonte (api.py = app FastAPI)
├── tests/                 # testes de cada biblioteca + API
├── scripts/check_env.py   # verificação rápida do ambiente
├── kernels/               # kernels SPICE (não versionados)
├── docs/BIBLIOTECAS.md    # documentação das bibliotecas
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

## Documentação

Veja [docs/BIBLIOTECAS.md](docs/BIBLIOTECAS.md) para a explicação de cada
biblioteca, conceitos principais e exemplos.
