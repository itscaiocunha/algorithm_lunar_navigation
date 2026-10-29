"""Efemérides via SPICE: posição do Sol e da Terra vistos de um ponto na Lua.

Pipeline (cada etapa é uma função):
    1. load_kernels       -> carrega o meta-kernel (furnsh)
    2. utc_to_et          -> string UTC -> Ephemeris Time (s desde J2000 TDB)
    3. surface_point      -> lat/lon do observador -> vetor (X, Y, Z) em MOON_ME
    4. target_vector      -> vetor observador -> centro do alvo (SUN ou EARTH), em MOON_ME
    5. topocentric_angles -> vetor no horizonte local -> (elevação, azimute)

O Sol e a Terra usam a mesma correção LT+S (posição aparente): para a Terra
isso inclui o atraso de sinal de rádio de ~1,2–1,36 s.

Limitação: aqui a Lua é tratada como esfera (raio 1737,4 km); a oclusão pelo
relevo fica em illumination.py / horizon.py.
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

SUN = "SUN"  # NAIF ID 10
EARTH = "EARTH"  # NAIF ID 399
SUN_RADIUS_M = 695_700_000.0  # raio nominal IAU 2015 (Resolução B3)
EARTH_RADIUS_M = 6_378_137.0  # raio equatorial (pck00011); disco de ~1,8–2,05° visto da Lua
TARGET_RADIUS_M = {SUN: SUN_RADIUS_M, EARTH: EARTH_RADIUS_M}


@dataclass(frozen=True)
class BodyGeometry:
    target: str
    et: float
    observer_position: np.ndarray  # km, MOON_ME, relativo ao centro da Lua
    vector: np.ndarray  # km, MOON_ME, observador -> alvo
    light_time: float  # s (para a Terra: atraso do sinal de rádio)
    elevation_deg: float  # acima do horizonte local (+) / abaixo (-)
    azimuth_deg: float  # a partir do Norte, sentido horário (Norte -> Leste)
    angular_radius_deg: float  # raio aparente do disco


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


# 4. Vetor observador -> alvo ----------------------------------------------
def target_vector(et: float, observer_position: np.ndarray, target: str = SUN) -> tuple[np.ndarray, float]:
    """Posição aparente de `target` relativa a um ponto fixo na superfície (spkcpo), em km."""
    state, light_time = spice.spkcpo(target, et, FRAME, "OBSERVER", ABCORR, observer_position, BODY, FRAME)
    return np.array(state[:3]), light_time


def sun_vector(et: float, observer_position: np.ndarray) -> tuple[np.ndarray, float]:
    return target_vector(et, observer_position, SUN)


def earth_vector(et: float, observer_position: np.ndarray) -> tuple[np.ndarray, float]:
    return target_vector(et, observer_position, EARTH)


def body_position_m(et: float, target: str = SUN) -> np.ndarray:
    """Posição aparente do alvo relativa ao centro da Lua, MOON_ME, em metros."""
    pos, _ = spice.spkpos(target, et, FRAME, ABCORR, BODY)
    return np.array(pos) * 1000.0


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


def body_geometry(utc: str, lat_deg: float, lon_deg: float, target: str = SUN) -> BodyGeometry:
    """Etapas 2-5 de uma vez para o Sol ou a Terra (requer kernels carregados)."""
    et = utc_to_et(utc)
    observer = surface_point(lat_deg, lon_deg)
    vector, light_time = target_vector(et, observer, target)
    elevation, azimuth = topocentric_angles(vector, observer)
    radius = np.degrees(np.arcsin(TARGET_RADIUS_M[target] / 1000.0 / np.linalg.norm(vector)))
    return BodyGeometry(target, et, observer, vector, light_time, elevation, azimuth, float(radius))


def sun_geometry(utc: str, lat_deg: float, lon_deg: float) -> BodyGeometry:
    return body_geometry(utc, lat_deg, lon_deg, SUN)


def earth_geometry(utc: str, lat_deg: float, lon_deg: float) -> BodyGeometry:
    return body_geometry(utc, lat_deg, lon_deg, EARTH)
