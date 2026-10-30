# syntax=docker/dockerfile:1
#
# Lunar Navigator — API FastAPI + dashboard numa imagem só.
#
#   docker build --target runtime -t lunar-navigator:runtime .   # sem caches derivados (CI, ~0,8 GB)
#   docker build -t lunar-navigator .                            # "bundle": + horizontes e análise anual
#
# Estágios: frontend (pnpm) · data (kernels + DEM, SHA-256) · deps (venv) · runtime · bundle.
# Os dados públicos são baixados das fontes oficiais com hash fixo; os caches derivados (34 min
# de pré-cálculo) entram só no alvo "bundle", copiados de data/cache e output/ do contexto.

ARG PYTHON_VERSION=3.12
ARG NODE_VERSION=24

# --- 1. Frontend: build reprodutível a partir do lockfile ---------------------
FROM node:${NODE_VERSION}-alpine AS frontend
RUN npm install -g pnpm@11.1.3
WORKDIR /web
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm run build

# --- 2. Dados públicos: kernels SPICE + DEM LOLA, verificados por SHA-256 -------
FROM python:${PYTHON_VERSION}-slim AS data
WORKDIR /app
COPY scripts/baixar_dados.py scripts/
RUN python scripts/baixar_dados.py --destino /app

# --- 3. Dependências Python num venv isolado (wheels: sem compilador na imagem final)
FROM python:${PYTHON_VERSION}-slim AS deps
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --- 4. Runtime ---------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS runtime
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg \
    PORT=8000
# libexpat1: o GDAL embutido no wheel do rasterio precisa dela, e a imagem slim não traz
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 lunar
WORKDIR /app
COPY --from=deps /opt/venv /opt/venv
# falha no build (e não no primeiro request) se faltar alguma biblioteca nativa
RUN python -c "import rasterio, scipy, spiceypy, matplotlib, numpy, uvicorn, fastapi"
# dados (raramente mudam) antes do código (muda sempre): o cache de camadas reaproveita os 300 MB
COPY --from=data /app/kernels/ kernels/
COPY --from=data /app/data/dem/ data/dem/
COPY kernels/lunar.tm kernels/
COPY src/ src/
COPY scripts/ scripts/
COPY --from=frontend /web/dist/ frontend/dist/
RUN mkdir -p data/cache output && chown lunar:lunar data/cache output
USER lunar
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health', timeout=4)"
# 1 worker: o serviço mantém DEM, horizontes e caches em memória (~1 GB) e serializa o SPICE
# com locks; para escalar, mais réplicas do contêiner, não mais workers no mesmo processo
CMD ["sh", "-c", "exec uvicorn lunar_navigator.api:app --app-dir src --host 0.0.0.0 --port \"$PORT\" --proxy-headers --forwarded-allow-ips='*'"]

# --- 5. Bundle: + caches derivados (modo rápido, animação, aba anual) ----------
FROM runtime AS bundle
COPY --chown=lunar:lunar data/cache/ data/cache/
COPY --chown=lunar:lunar output/ output/
