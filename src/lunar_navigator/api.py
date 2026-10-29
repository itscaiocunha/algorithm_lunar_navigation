"""API FastAPI mínima, usada como ponto de partida e para validar o ambiente."""

import sys

import numpy as np
import spiceypy as spice
from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from lunar_navigator import __version__

app = FastAPI(title="Lunar Navigator", version=__version__)


class Vector3(BaseModel):
    x: float
    y: float
    z: float


class SphericalCoords(BaseModel):
    radius: float
    colatitude_deg: float
    longitude_deg: float


@app.get("/", include_in_schema=False)
def root() -> RedirectResponse:
    """Redireciona a raiz para a documentação interativa."""
    return RedirectResponse(url="/docs")


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
