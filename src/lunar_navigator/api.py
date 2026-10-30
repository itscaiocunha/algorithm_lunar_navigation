"""API FastAPI do Lunar Navigator + dashboard web (build do frontend servido em /).

Executar:  python scripts/servidor.py   (ou uvicorn lunar_navigator.api:app --app-dir src)
Frontend:  cd frontend && npm run build   (gera frontend/dist, servido aqui)
"""

import sys
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import spiceypy as spice
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lunar_navigator import __version__, config

WEB_DIR = Path(__file__).resolve().parents[2] / "frontend" / "dist"

state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Carrega kernels, DEM e caches uma vez por processo (se o DEM existir)."""
    if config.DEM_PATH.exists():
        from lunar_navigator.service import LunarService

        state["service"] = LunarService()
        state["annual"] = {}
    yield
    state.clear()


app = FastAPI(title="Lunar Navigator", version=__version__, lifespan=lifespan)


class Vector3(BaseModel):
    x: float
    y: float
    z: float


class SphericalCoords(BaseModel):
    radius: float
    colatitude_deg: float
    longitude_deg: float


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/versions")
def versions() -> dict:
    """Versões das bibliotecas principais carregadas no ambiente."""
    return {
        "python": sys.version.split()[0],
        "numpy": np.__version__,
        "spiceypy": spice.__version__,
        "cspice_toolkit": spice.tkvrsn("TOOLKIT"),
    }


@app.post("/convert/rect-to-spherical", response_model=SphericalCoords)
def rect_to_spherical(v: Vector3) -> SphericalCoords:
    """Converte coordenadas retangulares em esféricas usando SPICE (recsph)."""
    radius, colat, lon = spice.recsph(np.array([v.x, v.y, v.z]))
    return SphericalCoords(
        radius=radius,
        colatitude_deg=np.degrees(colat),
        longitude_deg=np.degrees(lon),
    )


# --- Iluminação ---------------------------------------------------------------
def _service():
    if "service" not in state:
        raise HTTPException(503, f"DEM não encontrado em {config.DEM_PATH} — veja docs/ILUMINACAO.md")
    return state["service"]


def _annual(year: int) -> dict | None:
    cache = state.setdefault("annual", {})
    if year not in cache:
        data = _service().load_annual(year)
        if data is None:
            return None
        cache[year] = data
    return cache[year]


def _call(fn, *args):
    from lunar_navigator.service import InputError

    try:
        return fn(*args)
    except InputError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/info")
def api_info() -> dict:
    """DEM, área de análise e quais caches estão disponíveis."""
    return _service().info()


@app.get("/api/illumination")
def api_illumination(
    utc: str = Query(..., examples=["2026-11-20T00:00:00Z"]),
    lat: float = Query(..., ge=-90, le=-80, examples=[-89.9]),
    lon: float = Query(..., ge=-360, le=360, examples=[0.0]),
    year: int = Query(2027, description="ano da análise anual a anexar, se existir"),
) -> dict:
    """Telemetria de um ponto: Sol (energia) e Terra (enlace DTE), com ray-casting exato de 1 pixel."""
    return _call(_service().point, utc, lat, lon, _annual(year))


@app.get("/api/tiles/meta")
def api_tiles_meta() -> dict:
    """Grade quadtree do DEM: origem, tamanho, células por tile, nível máximo e região analítica rápida."""
    return _service().tiles_meta()


_TILE_CACHE = {"Cache-Control": "public, max-age=86400"}  # relevo e alturas não mudam


@app.get("/api/tiles/{z}/{x}/{y}/heights")
def api_tile_heights(z: int, x: int, y: int) -> Response:
    """(tile_cells+1)² alturas em metros, Float32 little-endian, linha a linha de norte para sul (NaN fora do DEM)."""
    return Response(_call(_service().tile_heights, z, x, y), media_type="application/octet-stream", headers=_TILE_CACHE)


@app.get("/api/tiles/{z}/{x}/{y}/relief.png")
def api_tile_relief(z: int, x: int, y: int) -> Response:
    """Relevo sombreado do tile (PNG RGBA, transparente fora do DEM)."""
    return Response(_call(_service().tile_relief, z, x, y), media_type="image/png", headers=_TILE_CACHE)


@app.get("/api/tiles/{z}/{x}/{y}/analytic.png")
def api_tile_analytic(z: int, x: int, y: int, utc: str = Query(...), sun: bool = True, earth: bool = True,
                      golden: bool = True) -> Response:
    """Sol (inferno) + Terra só-rádio (hachura) + Zona de Ouro (verde) do tile no instante dado."""
    png = _call(_service().tile_analytic, z, x, y, utc, (sun, earth, golden))
    return Response(png, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/countdown")
def api_countdown(
    utc: str = Query(..., examples=["2026-11-20T00:00:00Z"]),
    lat: float = Query(..., ge=-90, le=-80, examples=[-89.45]),
    lon: float = Query(..., ge=-360, le=360, examples=[-137.1]),
) -> dict:
    """Contagem regressiva no pixel: próximo pôr/nascer do Sol e LOS/AOS (e degradação) da Terra.

    Varredura de 1 h por até 60 dias + bisseção (scipy) com tolerância de 1 s sobre
    f(t) = elevação − horizonte(azimute) ± raio do disco.
    """
    return _call(_service().countdown, utc, lat, lon)


@app.get("/api/map")
def api_map(
    utc: str = Query(..., examples=["2026-11-20T00:00:00Z"]),
    modo: str = Query("completo", pattern="^(completo|rapido)$",
                      description="completo = ray-casting de toda a malha (~15 s); rapido = mapa de horizontes (<1 s)"),
    formato: str = Query("png", pattern="^(png|geotiff)$"),
    half_size_km: float = Query(config.HALF_SIZE_M / 1000, ge=1, le=60),
):
    """Mapa de Sol + Terra da área: PNG/frações em base64 (JSON) ou GeoTIFF de 3 bandas (download)."""
    svc = _service()
    if formato == "geotiff":
        data = _call(svc.map_geotiff, utc, modo, half_size_km * 1000)
        return Response(data, media_type="image/tiff",
                        headers={"Content-Disposition": 'attachment; filename="iluminacao.tif"'})
    return _call(svc.map_payload, utc, modo, half_size_km * 1000)


@app.get("/api/map/frame")
def api_map_frame(utc: str = Query(..., examples=["2026-11-20T00:00:00Z"])) -> Response:
    """Quadro de animação (modo rápido): bytes linha a linha, Sol no nibble alto e Terra no baixo (0..15)."""
    data, iso, (rows, cols) = _call(_service().map_frame, utc)
    return Response(data, media_type="application/octet-stream",
                    headers={"X-Utc": iso, "X-Shape": f"{rows},{cols}", "Cache-Control": "public, max-age=3600"})


@app.get("/api/ephemeris")
def api_ephemeris(
    start: str = Query(..., examples=["2026-11-20T00:00:00Z"]),
    hours: float = Query(168, gt=0, le=1080, description="duração da janela"),
    step_min: float = Query(30, ge=5, le=720, description="passo da série"),
    lat: float | None = Query(None, ge=-90, le=-80),
    lon: float | None = Query(None, ge=-360, le=360),
) -> dict:
    """Série densa de elevação/azimute do Sol e da Terra (centro da área e, opcionalmente, um pixel com horizonte)."""
    return _call(_service().ephemeris_series, start, hours, step_min, lat, lon)


@app.get("/api/basemap")
def api_basemap() -> dict:
    """Relevo sombreado (hillshade) da área de análise, para fundo do mapa."""
    return _service().basemap_payload()


@app.get("/api/terrain")
def api_terrain(step: int = Query(3, ge=1, le=10, description="fator de redução da malha")) -> dict:
    """Altitudes da área (Float32 base64) para a vista 3D do relevo."""
    return _service().terrain_payload(step)


@app.get("/api/annual")
def api_annual(
    year: int = 2027,
    metric: str = Query("score", pattern="^(score|golden_window|golden_pct|illumination_pct|earth_pct)$",
                        description="score = pontuação composta; golden_window = maior janela contínua Sol + Terra"),
    a: float = Query(1.0, ge=0, le=10, description="peso A: maior janela de ouro"),
    b: float = Query(1.0, ge=0, le=10, description="peso B: fração anual de ouro"),
    c: float = Query(1.0, ge=0, le=10, description="peso C: pior apagão contínuo (noite ou LOS)"),
) -> dict:
    """Mapa anual (Sol, Terra, Zona de Ouro ou pontuação) e candidatos a pouso re-ranqueados com os pesos A, B, C."""
    data = _annual(year)
    if data is None:
        raise HTTPException(404, f"Análise Sol + Terra de {year} não encontrada: rode scripts/mapa_anual.py --ano {year}")
    return _call(_service().annual_payload, data, metric, (a, b, c))


# Dashboard (precisa vir depois das rotas para não encobri-las)
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
