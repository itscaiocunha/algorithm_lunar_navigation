# Contêiner, CI/CD e deploy

## Imagem Docker

`Dockerfile` multi-estágio, com dois alvos:

| Alvo | Conteúdo | Tamanho | Para quê |
|---|---|---|---|
| `runtime` | API + dashboard + kernels SPICE + DEM LOLA | 1,49 GB | CI, desenvolvimento, base do `bundle` |
| `bundle` (padrão) | `runtime` + mapa de horizontes + análise anual 2027 | 1,83 GB | deploy ao vivo (todas as funções) |

```
frontend (node 24, pnpm --frozen-lockfile) ──► dist ─────────────┐
data (python slim) ── scripts/baixar_dados.py, SHA-256 ──► kernels + DEM ──┤
deps (python slim) ── venv com wheels ───────────────────────────┤
                                                                  ▼
runtime (python 3.12 slim, usuário sem privilégios, healthcheck) ──► bundle (+ data/cache, output/anual_*.npz)
```

- **Dados públicos baixados no build, com hash fixo.** Os kernels (NAIF) e o DEM (PGDA/GSFC) vêm
  das fontes oficiais, e `scripts/baixar_dados.py` confere o SHA-256 de cada arquivo. Se a NASA
  trocar um arquivo, o build falha em vez de mudar os resultados em silêncio. Essas camadas ficam
  antes do código, então só são refeitas quando o próprio script muda.
- **Caches derivados (34 min de pré-cálculo) não são recalculados no build.** O alvo `bundle`
  copia `data/cache/` e `output/anual_*.npz` do contexto. No CI, eles vêm do cache do GitHub (veja
  abaixo).
- **Imagem final enxuta:** sem compilador, sem Node e sem pnpm, usuário `lunar` (uid 10001),
  `HEALTHCHECK` em `/health`. Um `RUN python -c "import rasterio, ..."` faz o build falhar se faltar
  uma biblioteca nativa. Foi assim que apareceu a `libexpat1`: o GDAL embutido no wheel do rasterio
  precisa dela, e a imagem slim não a traz.
- **Um processo, um worker.** O serviço mantém DEM, horizontes e caches em memória e serializa o
  SPICE (que não é thread-safe) com locks. Para escalar, use mais réplicas do contêiner, não mais
  workers.
- **gzip** para JSON e binários: um quadro da animação cai de 549 KB para ~65 KB no fio. PNG e
  GeoTIFF, que já vêm comprimidos, ficam de fora.

### Medido (Docker Desktop, WSL2)

| | `runtime` | `bundle` |
|---|---|---|
| Pronto para responder (reinício, cache de disco quente) | 3 s | — |
| Primeira partida (camadas frias no disco) | ~50 s | — |
| RAM após a partida | 377 MiB | 696 MiB |
| RAM de pico sob carga mista (252 requisições: quadros, mapas, tiles, countdowns) | — | **1,37 GB** |
| Quadro da animação (`/api/map/frame`, gzip) | 422 (sem cache) | 0,16–0,22 s, ~65 KB |

**Dimensionamento:** 2 GB de RAM e 1–2 vCPU por réplica. Com 1 GB, o processo é derrubado no pico.

## Executar localmente

```bash
docker compose up --build                # http://localhost:8000 (alvo runtime + caches do host montados)
docker compose run --rm precalculo       # gera horizontes + análise anual em ./data/cache e ./output (uma vez)

docker build -t lunar-navigator .        # imagem completa (exige data/cache e output/anual_*.npz)
docker run -p 8000:8000 lunar-navigator
```

O contêiner respeita `PORT` (padrão 8000), como a maioria das plataformas espera.

## CI/CD (GitHub Actions)

| Workflow | Quando | O que faz |
|---|---|---|
| `ci.yml` | push em `main`, PR, manual | **frontend:** pnpm `--frozen-lockfile`, `tsc`, `oxlint --deny-warnings`, `vitest`, `vite build` → **backend:** `ruff`, kernels + DEM (cache, SHA-256), `pytest` com o `dist` do job anterior → **docker:** build do `runtime` (cache de camadas `gha`) e smoke test do contêiner (`/health`, SPICE com 6 kernels, DEM 750×750, telemetria, countdown, dashboard) |
| `dados.yml` | manual e semanal | gera os caches derivados **só se** não existirem para a versão atual do algoritmo e os guarda no cache do GitHub |
| `release.yml` | tag `v*` | restaura os caches derivados, constrói o `bundle` e publica em `ghcr.io/<dono>/<repo>` (tags semver + sha) |

A lógica de dados fica numa ação composta (`.github/actions/dados`) usada pelos três workflows.
A chave dos caches derivados é o hash do código que os produz (`horizon.py`, `illumination.py`,
`terrain.py`, `annual.py`, …): mudou o algoritmo, o cache antigo deixa de valer.

**O que roda no CI:**

| Situação | Python | Frontend |
|---|---|---|
| Sem os caches derivados (primeiro push) | 119 passam, 19 pulam com motivo explícito | 49 |
| Depois de rodar **Dados derivados** uma vez | suíte completa (138) | 49 |

Os testes pulados dependem do mapa de horizontes ou da análise anual (modo rápido, animação, aba
anual). O resumo do job diz qual dos dois casos rodou.

### Primeiro uso no GitHub

1. Faça push para `main`: o **CI** roda com os dados públicos.
2. Em *Actions → Dados derivados → Run workflow*: gera horizontes + análise anual. Leva 1–2 h num
   runner de 4 vCPU, uma vez por versão do algoritmo.
3. A partir daí, o CI roda a suíte completa. Para publicar: `git tag v1.0.0 && git push --tags`.

> Em repositório **privado**, os minutos do Actions são cobrados: a geração dos caches derivados
> consome ~60–120 min de runner por versão do algoritmo.

## Deploy em nuvem

A imagem `bundle` é autossuficiente (sem banco, sem volume obrigatório) e serve em qualquer
plataforma de contêineres que aceite 2 GB por instância, por exemplo Google Cloud Run, Fly.io,
Render, Railway ou Azure Container Apps:

```bash
# exemplo: Cloud Run a partir da imagem publicada pelo release
gcloud run deploy lunar-navigator --image ghcr.io/<dono>/<repo>:1.0.0 \
  --memory 2Gi --cpu 2 --port 8000 --min-instances 0 --max-instances 3
```

Pontos de atenção:

- **Partida a frio:** a imagem tem 1,8 GB, e a API carrega DEM e horizontes na partida (~5 s com o
  disco quente). Com escala a zero, a primeira visita espera o pull da imagem; `--min-instances 1`
  elimina isso, ao custo de uma instância sempre ligada.
- **Estado em memória por réplica:** os caches de quadros e tiles são locais. Isso não afeta a
  correção, só a taxa de acerto do cache.
- **CORS:** não é necessário, porque o dashboard é servido pela própria API (mesma origem).
