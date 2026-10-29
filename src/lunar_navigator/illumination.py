"""Iluminação solar sobre o DEM por ray-casting vetorizado (NumPy).

Para cada pixel P da área de saída, um raio parte de P rumo ao centro do Sol.
Em vez de iterar pixel a pixel, iteramos sobre a *distância* t ao longo do
raio, e em cada passo avançamos todos os pixels ativos de uma vez:

    Q = P + t·ŝ                      (ponto do raio, 3D, MOON_ME)
    (x, y) = projeção de Q no mapa   (estereográfica, sem trigonometria)
    h = DEM[x, y]                    (altura do terreno sob o raio)
    T = Q̂ · (R + h)                 (ponto do terreno sob o raio)
    horizonte = max(horizonte, elevação de T vista de P)

Como Q, P e o centro da Lua estão no mesmo plano, T percorre exatamente o
plano vertical do azimute do Sol: o resultado é o horizonte topográfico
nessa direção, já incluindo a curvatura lunar. A fração do disco solar
visível vem da diferença entre a elevação do Sol e esse horizonte.

Um pixel sai do laço quando: o raio deixa o mapa, o raio (borda inferior do
disco) passa acima do pico mais alto do DEM, ou o Sol já está totalmente
encoberto.
"""

from dataclasses import dataclass

import numpy as np
import spiceypy as spice

from lunar_navigator.solar import ABCORR, BODY, FRAME
from lunar_navigator.terrain import DEM

SUN_RADIUS_M = 695_700_000.0  # raio nominal IAU 2015


@dataclass
class IlluminationResult:
    fraction: np.ndarray  # 0 (sombra) .. 1 (disco inteiro visível)
    sun_elevation_deg: np.ndarray  # elevação do centro do Sol sobre o horizonte local ideal
    horizon_deg: np.ndarray  # elevação do horizonte topográfico na direção do Sol
    steps: int  # passos de ray-marching executados


def sun_position_m(et: float) -> np.ndarray:
    """Posição aparente do Sol relativa ao centro da Lua, MOON_ME, em metros."""
    pos, _ = spice.spkpos("SUN", et, FRAME, ABCORR, BODY)
    return np.array(pos) * 1000.0


def visible_disk_fraction(sun_elev: np.ndarray, horizon: np.ndarray, sun_radius: np.ndarray) -> np.ndarray:
    """Fração da área do disco acima de um horizonte reto (segmento circular)."""
    d = np.clip((sun_elev - horizon) / sun_radius, -1.0, 1.0)
    return 1.0 - (np.arccos(d) - d * np.sqrt(1.0 - d**2)) / np.pi


def _march(points, sun, terrain: DEM, first_step, growth, max_distance):
    """Ray-marching de um bloco de pixels. points: (N, 3) metros."""
    n_hat = points / np.linalg.norm(points, axis=1, keepdims=True)
    to_sun = sun - points
    dist = np.linalg.norm(to_sun, axis=1)
    s_hat = to_sun / dist[:, None]
    sun_elev = np.arcsin(np.einsum("ij,ij->i", s_hat, n_hat))
    sun_radius = np.arcsin(SUN_RADIUS_M / dist)

    ceiling = terrain.radius + terrain.max_height

    horizon = np.full(len(points), -np.pi / 2)
    active = np.arange(len(points))
    t, steps = first_step, 0
    while active.size and t <= max_distance:
        p, s, n = points[active], s_hat[active], n_hat[active]
        q = p + t * s
        r = np.linalg.norm(q, axis=1)
        x, y = terrain.to_map(q)
        ground = q * ((terrain.radius + terrain.sample(x, y)) / r)[:, None]
        v = ground - p
        elev = np.arcsin(np.einsum("ij,ij->i", v, n) / np.linalg.norm(v, axis=1))
        horizon[active] = np.maximum(horizon[active], elev)

        lower_limb_clear = (r - t * sun_radius[active] > ceiling) & (np.einsum("ij,ij->i", q, s) > 0)
        fully_dark = horizon[active] >= sun_elev[active] + sun_radius[active]
        active = active[terrain.contains(x, y) & ~lower_limb_clear & ~fully_dark]
        t += max(first_step, growth * t)
        steps += 1

    return visible_disk_fraction(sun_elev, horizon, sun_radius), sun_elev, horizon, steps


def compute_illumination(
    area: DEM,
    terrain: DEM,
    sun_m: np.ndarray,
    growth: float = 0.01,
    max_distance: float = np.inf,
    chunk_size: int = 65_536,  # blocos que cabem no cache da CPU
) -> IlluminationResult:
    """Iluminação de cada pixel de `area`, usando `terrain` como obstáculo.

    `area` e `terrain` podem ser o mesmo DEM ou `area` um recorte dele.
    `growth` controla o passo: Δt = max(pixel, growth·t) (passos finos perto,
    largos longe, onde o terreno ocupa ângulos menores).
    """
    points = area.surface_points().reshape(-1, 3)
    fraction = np.empty(len(points))
    elev = np.empty(len(points))
    horizon = np.empty(len(points))
    steps = 0
    for start in range(0, len(points), chunk_size):
        sl = slice(start, start + chunk_size)
        fraction[sl], elev[sl], horizon[sl], n = _march(
            points[sl], sun_m, terrain, terrain.pixel, growth, max_distance
        )
        steps = max(steps, n)
    return IlluminationResult(
        fraction.reshape(area.shape),
        np.degrees(elev).reshape(area.shape),
        np.degrees(horizon).reshape(area.shape),
        steps,
    )
