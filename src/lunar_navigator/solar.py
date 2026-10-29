"""Elevação e azimute do Sol vistos de um ponto na superfície da Lua.

Pipeline (cada etapa é uma função):
    1. load_kernels       -> carrega o meta-kernel (furnsh)
    2. utc_to_et          -> string UTC -> Ephemeris Time (s desde J2000 TDB)
    3. surface_point      -> lat/lon do observador -> vetor (X, Y, Z) em MOON_ME
    4. sun_vector         -> vetor observador -> centro do Sol, em MOON_ME
    5. topocentric_angles -> vetor no horizonte local -> (elevação, azimute)

Limitação: a Lua é tratada como esfera (raio 1737,4 km); o relevo local
(paredes de cratera, montanhas) não bloqueia o Sol neste modelo.
"""

import os
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import spiceypy as spice

ROOT = Path(__file__).resolve().parents[2]
META_KERNEL = ROOT / "kernels" / "lunar.tm"

BODY = "MOON"
FRAME = "MOON_ME"  # Mean Earth / polar axis: frame usado na cartografia lunar
ABCORR = "LT+S"  # correção de tempo-luz + aberração estelar (posição aparente)


@dataclass(frozen=True)
class SunGeometry:
    et: float
    observer_position: np.ndarray  # km, MOON_ME, relativo ao centro da Lua
    sun_vector: np.ndarray  # km, MOON_ME, observador -> Sol
    light_time: float  # s
    elevation_deg: float  # acima do horizonte local (+) / abaixo (-)
    azimuth_deg: float  # a partir do Norte, sentido horário (Norte -> Leste)


@contextmanager
def _project_root():
    """O PATH_VALUES do meta-kernel é relativo à raiz do projeto."""
    cwd = os.getcwd()
    os.chdir(ROOT)
    try:
        yield
    finally:
        os.chdir(cwd)


# 1. Inicialização ---------------------------------------------------------
def load_kernels(meta_kernel: Path = META_KERNEL) -> None:
    with _project_root():
        spice.furnsh(str(meta_kernel))


# 2. Tempo -----------------------------------------------------------------
def utc_to_et(utc: str) -> float:
    """Ex.: '2026-11-14 12:00:00 UTC' -> segundos TDB desde J2000."""
    return spice.str2et(utc)


# 3. Observador ------------------------------------------------------------
def surface_point(lat_deg: float, lon_deg: float, altitude_km: float = 0.0) -> np.ndarray:
    """Converte lat/lon planetocêntricas em (X, Y, Z) no frame MOON_ME."""
    radius = spice.bodvrd(BODY, "RADII", 3)[1][0] + altitude_km
    return np.array(spice.latrec(radius, np.radians(lon_deg), np.radians(lat_deg)))


# 4. Vetor observador -> Sol ----------------------------------------------
def sun_vector(et: float, observer_position: np.ndarray) -> tuple[np.ndarray, float]:
    """Posição do Sol relativa a um ponto fixo na superfície (spkcpo)."""
    state, light_time = spice.spkcpo(
        "SUN", et, FRAME, "OBSERVER", ABCORR, observer_position, BODY, FRAME
    )
    return np.array(state[:3]), light_time


# 5. Horizonte local -------------------------------------------------------
def topocentric_matrix(observer_position: np.ndarray) -> np.ndarray:
    """Rotação MOON_ME -> topocêntrico (Z = zênite, X = Norte, Y = Oeste).

    O zênite é a normal à superfície (na esfera, a direção radial); o eixo
    X é a projeção do polo norte da Lua no plano do horizonte.
    """
    zenith = spice.vhat(observer_position)
    return np.array(spice.twovec(zenith, 3, [0.0, 0.0, 1.0], 1))


def topocentric_angles(vector: np.ndarray, observer_position: np.ndarray) -> tuple[float, float]:
    """Retorna (elevação, azimute) em graus via coordenadas latitudinais.

    No frame topocêntrico, a 'latitude' do vetor é a elevação sobre o
    horizonte e a 'longitude' é o ângulo a partir do Norte rumo ao Oeste;
    o azimute convencional (Norte -> Leste) é o seu negativo.
    """
    local = topocentric_matrix(observer_position) @ vector
    _, lon, lat = spice.reclat(local)
    elevation = np.degrees(lat)
    azimuth = (-np.degrees(lon)) % 360.0
    return float(elevation), float(azimuth)


def sun_geometry(utc: str, lat_deg: float, lon_deg: float) -> SunGeometry:
    """Etapas 2-5 de uma vez (requer kernels carregados)."""
    et = utc_to_et(utc)
    observer = surface_point(lat_deg, lon_deg)
    vector, light_time = sun_vector(et, observer)
    elevation, azimuth = topocentric_angles(vector, observer)
    return SunGeometry(et, observer, vector, light_time, elevation, azimuth)
