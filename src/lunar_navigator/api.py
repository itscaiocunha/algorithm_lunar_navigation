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
    """Fração do disco solar visível num ponto (ray-casting de um único pixel, ~50 ms)."""
    return _call(_service().point, utc, lat, lon, _annual(year))


@app.get("/api/map")
def api_map(
    utc: str = Query(..., examples=["2026-11-20T00:00:00Z"]),
    modo: str = Query("completo", pattern="^(completo|rapido)$",
                      description="completo = ray-casting de toda a malha (~15 s); rapido = mapa de horizontes (<1 s)"),
    formato: str = Query("png", pattern="^(png|geotiff)$"),
    half_size_km: float = Query(config.HALF_SIZE_M / 1000, ge=1, le=60),
):
    """Mapa de iluminação da área: PNG em base64 (JSON) ou GeoTIFF (download)."""
    svc = _service()
    if formato == "geotiff":
        data = _call(svc.map_geotiff, utc, modo, half_size_km * 1000)
        return Response(data, media_type="image/tiff",
                        headers={"Content-Disposition": 'attachment; filename="iluminacao.tif"'})
    return _call(svc.map_payload, utc, modo, half_size_km * 1000)


@app.get("/api/basemap")
def api_basemap() -> dict:
    """Relevo sombreado (hillshade) da área de análise, para fundo do mapa."""
    return _service().basemap_payload()


@app.get("/api/terrain")
def api_terrain(step: int = Query(3, ge=1, le=10, description="fator de redução da malha")) -> dict:
    """Altitudes da área (Float32 base64) para a vista 3D do relevo."""
    return _service().terrain_payload(step)


@app.get("/api/annual")
def api_annual(year: int = 2027) -> dict:
    """Mapa de calor anual (% do tempo iluminado), sombras permanentes e Picos da Luz Eterna."""
    data = _annual(year)
    if data is None:
        raise HTTPException(404, f"Análise de {year} não encontrada: rode scripts/mapa_anual.py --ano {year}")
    return _service().annual_payload(data)


# Dashboard (precisa vir depois das rotas para não encobri-las)
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
